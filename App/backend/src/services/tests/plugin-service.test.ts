import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileEntitledPlugins } from "../plugin-entitlement-reconcile-service.js";
import { createInMemoryPluginRegistry, type PluginRelease } from "../../adapters/outbound/plugin-registry/index.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import {
  createPluginService,
  type PluginArtifactManager,
  type PluginRuntimeHost
} from "../plugin-service.js";
import type { CreatePluginServiceOptions } from "../plugin-service.js";
import type { PluginLocalArtifactService } from "../plugin-local-artifact-service.js";

let root: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const release = {
  manifest: {
    apiVersion: "memmy/v1" as const,
    id: "com.example.review",
    name: "Review",
    version: "1.0.0",
    runtime: { adapter: "http" as const, config: { baseUrl: "https://plugin.example" } },
    capabilities: [{
      id: "run",
      name: "Run review",
      description: "Runs a review",
      inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } },
      outputSchema: { type: "object" },
      execution: "job" as const
    }],
    permissions: [
      { type: "network" as const, hosts: ["plugin.example"] },
      { type: "secret" as const, keys: ["api-key"] }
    ],
    configSchema: {
      type: "object",
      required: ["database"],
      properties: { database: { type: "string" } },
      additionalProperties: false
    }
  }
};

function createContext(
  releases: PluginRelease[] = [release],
  localArtifactService?: PluginLocalArtifactService,
  lifecycleOrAuthenticated: Partial<CreatePluginServiceOptions> | (() => boolean) = {},
  catalogPluginIds?: () => readonly string[],
  isEntitlementGranted?: (entitlement: string) => boolean
) {
  root = mkdtempSync(join(tmpdir(), "memmy-plugin-service-"));
  store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
  const runtimeHost: PluginRuntimeHost = {
    supports: vi.fn(() => true),
    activate: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined),
    async *invoke() {
      yield { type: "result" as const, output: { ok: true } };
    },
    cancel: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined)
  };
  const artifactManager: PluginArtifactManager = {
    install: vi.fn(async (pluginRelease) => ({
      artifactHash: pluginRelease.artifact?.sha256.toLowerCase() ?? null,
      rootPath: null
    })),
    readTextFile: vi.fn(async () => "<main>renderer</main>"),
    remove: vi.fn(async () => undefined)
  };
  const skillManager = {
    activate: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined)
  };
  const registry = createInMemoryPluginRegistry(releases);
  return {
    registry,
    runtimeHost,
    artifactManager,
    skillManager,
    service: createPluginService({
      repository: store.repositories.plugins,
      secretStore: store.secretStore,
      registry,
      runtimeHost,
      artifactManager,
      skillManager,
      localArtifactService,
      ...(typeof lifecycleOrAuthenticated === "object" ? lifecycleOrAuthenticated : { isAuthenticated: lifecycleOrAuthenticated }),
      catalogPluginIds,
      isEntitlementGranted
    })
  };
}

describe("PluginService", () => {
  it("installs a plugin requiring the implemented ordered event checkpoints", async () => {
    const checkpointRelease: PluginRelease = { manifest: { ...release.manifest,
      requiredHostCapabilities: ["memmy.event-checkpoints/v1"] } };
    const { service, artifactManager } = createContext([checkpointRelease]);
    await expect(service.install(checkpointRelease.manifest.id)).resolves.toMatchObject({
      state: "pending_approval", version: "1.0.0"
    });
    expect(artifactManager.install).toHaveBeenCalledOnce();
  });
  const gatewayRelease: PluginRelease = { manifest: { ...release.manifest,
    permissions: [...release.manifest.permissions, { type: "host-service", services: ["event-sessions"] }] } };
  async function persistedFailure(options: Partial<CreatePluginServiceOptions> = {}) {
    const context = createContext([gatewayRelease], undefined, options);
    const { service } = context;
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, { config: { database: "crossref" }, secrets: { "api-key": "secret" } });
    await service.approvePermissions(release.manifest.id, gatewayRelease.manifest.permissions);
    store!.repositories.plugins.setDesiredEnabled(release.manifest.id, true);
    store!.repositories.plugins.setState(release.manifest.id, "failed", "fetch failed");
    return context;
  }
  it("keeps the first window unblocked and restores a desired failed worker after real Gateway readiness", async () => {
    const gateway = Promise.withResolvers<void>(), onRestored = vi.fn(async () => undefined);
    const { service, runtimeHost } = await persistedFailure({ gatewayReady: gateway.promise, onRestored });
    try {
      await service.restoreActive();
      expect(runtimeHost.activate).not.toHaveBeenCalled();
      expect(service.get(release.manifest.id)).toMatchObject({ desiredEnabled: true, state: "enabling" });
      gateway.resolve();
      await vi.waitFor(() => expect(service.get(release.manifest.id).state).toBe("active"));
      expect(runtimeHost.activate).toHaveBeenCalledOnce(); expect(onRestored).toHaveBeenCalledOnce();
    } finally { await service.shutdown(); }
  });
  it("retries only transient connection failures with a finite attempt count", async () => {
    const { service, runtimeHost } = await persistedFailure({ gatewayReady: Promise.resolve(), restoreRetryDelaysMs: [1, 1] });
    try {
      vi.mocked(runtimeHost.activate).mockRejectedValueOnce(new Error("MCP initialize: fetch failed"));
      await service.restoreActive();
      await vi.waitFor(() => expect(service.get(release.manifest.id).state).toBe("active"));
      expect(runtimeHost.activate).toHaveBeenCalledTimes(2);
      vi.mocked(runtimeHost.activate).mockReset().mockRejectedValue(new Error("ECONNREFUSED"));
      await service.restoreActive();
      await vi.waitFor(() => expect(runtimeHost.activate).toHaveBeenCalledTimes(3));
      expect(service.get(release.manifest.id)).toMatchObject({ state: "failed", desiredEnabled: true });
    } finally { await service.shutdown(); }
  });
  it("replaces a cancelled deferred recovery when the user enables again before Gateway readiness", async () => {
    const gateway = Promise.withResolvers<void>();
    const { service, runtimeHost } = await persistedFailure({ gatewayReady: gateway.promise });
    try {
      await service.restoreActive();
      expect((await service.enable(release.manifest.id)).state).toBe("enabling");
      expect(runtimeHost.activate).not.toHaveBeenCalled();
      gateway.resolve();
      await vi.waitFor(() => expect(service.get(release.manifest.id).state).toBe("active"));
      expect(runtimeHost.activate).toHaveBeenCalledOnce();
    } finally { await service.shutdown(); }
  });
  it("keeps an active worker on duplicate enable while its restored tools are being refreshed", async () => {
    const refresh = Promise.withResolvers<void>();
    const { service, runtimeHost } = await persistedFailure({ gatewayReady: Promise.resolve(), onRestored: () => refresh.promise });
    try {
      await service.restoreActive();
      await vi.waitFor(() => expect(service.get(release.manifest.id).state).toBe("active"));
      expect((await service.enable(release.manifest.id)).state).toBe("active");
      expect(runtimeHost.activate).toHaveBeenCalledOnce();
      expect(runtimeHost.deactivate).not.toHaveBeenCalled();
    } finally { refresh.resolve(); await service.shutdown(); }
  });
  it("retains pending approval across restart even when the user still wants the plugin enabled", async () => {
    const { service, runtimeHost } = await persistedFailure({ gatewayReady: Promise.resolve() });
    try {
      store!.repositories.plugins.setState(release.manifest.id, "pending_approval");
      await service.restoreActive();
      expect(service.get(release.manifest.id)).toMatchObject({ state: "pending_approval", desiredEnabled: true });
      expect(runtimeHost.activate).not.toHaveBeenCalled();
    } finally { await service.shutdown(); }
  });
  it.each(["disable", "uninstall"] as const)("cancels a deferred recovery on %s and never resurrects it", async action => {
    const gateway = Promise.withResolvers<void>();
    const { service, runtimeHost } = await persistedFailure({ gatewayReady: gateway.promise });
    try {
      await service.restoreActive();
      await service[action](release.manifest.id);
      gateway.resolve(); await service.restoreActive();
      expect(runtimeHost.activate).not.toHaveBeenCalled();
      if (action === "disable") expect(service.get(release.manifest.id)).toMatchObject({ state: "disabled", desiredEnabled: false });
      else expect(service.list()).toEqual([]);
    } finally { await service.shutdown(); }
  });
  it("discards an in-flight activation when the user disables the recovering plugin", async () => {
    const activation = Promise.withResolvers<void>();
    const { service, runtimeHost } = await persistedFailure({ gatewayReady: Promise.resolve() });
    try {
      vi.mocked(runtimeHost.activate).mockImplementationOnce(() => activation.promise);
      await service.restoreActive();
      await vi.waitFor(() => expect(runtimeHost.activate).toHaveBeenCalledOnce());
      const disabled = service.disable(release.manifest.id);
      expect(service.get(release.manifest.id).desiredEnabled).toBe(false);
      activation.resolve(); await disabled;
      expect(service.get(release.manifest.id)).toMatchObject({ state: "disabled", desiredEnabled: false });
      await service.restoreActive(); expect(runtimeHost.activate).toHaveBeenCalledOnce();
    } finally { activation.resolve(); await service.shutdown(); }
  });
  it("does not retry permission failures or block shutdown on an unstarted Gateway", async () => {
    const { service, runtimeHost } = await persistedFailure({ gatewayReady: Promise.resolve(), restoreRetryDelaysMs: [1, 1] });
    vi.mocked(runtimeHost.activate).mockRejectedValue(Object.assign(new Error("permission denied"), { code: "plugin_permission_denied" }));
    await service.restoreActive();
    await vi.waitFor(() => expect(service.get(release.manifest.id).state).toBe("failed"));
    await service.shutdown(); expect(runtimeHost.activate).toHaveBeenCalledOnce();
    const deferred = await persistedFailure({ gatewayReady: new Promise<void>(() => undefined) });
    await deferred.service.restoreActive(); await deferred.service.shutdown();
    expect(deferred.runtimeHost.activate).not.toHaveBeenCalled();
  });
  it("does not expose a private plugin from the public registry without its entitlement", async () => {
    const publicRelease: PluginRelease = { manifest: {
      ...release.manifest, id: "office", permissions: [], configSchema: undefined
    } };
    const legalRelease: PluginRelease = { manifest: {
      ...release.manifest,
      id: "legal-labor",
      name: "用工合规诊断",
      permissions: [],
      configSchema: undefined,
      requiredEntitlement: "plugin:legal-labor",
      rules: { distribution: "account", installation: "automatic", requiresLogin: true,
        unavailableVisibility: "hidden", autoUpdate: true, recommendsOfficialModel: false }
    } };
    const { service } = createContext(
      [publicRelease, legalRelease],
      undefined,
      () => true,
      () => [],
      () => false
    );

    expect((await service.catalog()).map((entry) => entry.manifest.id)).toEqual(["office"]);
  });

  it("adds entitled private releases to the catalog and keeps them visible after uninstall", async () => {
    const publicRelease: PluginRelease = { manifest: {
      ...release.manifest, id: "office", permissions: [], configSchema: undefined
    } };
    const legalRelease: PluginRelease = { manifest: {
      ...release.manifest,
      id: "legal-labor",
      name: "用工合规诊断",
      permissions: [],
      configSchema: undefined,
      requiredEntitlement: "plugin:legal-labor",
      rules: { distribution: "account", installation: "automatic", requiresLogin: true,
        unavailableVisibility: "hidden", autoUpdate: true, recommendsOfficialModel: false }
    } };
    const { service, registry } = createContext(
      [publicRelease, legalRelease],
      undefined,
      () => true,
      () => ["legal-labor"],
      (entitlement) => entitlement === "plugin:legal-labor"
    );
    vi.spyOn(registry, "list").mockResolvedValue([publicRelease.manifest]);

    expect((await service.catalog()).map((entry) => entry.manifest.id)).toEqual(["office", "legal-labor"]);
    await service.install("legal-labor", legalRelease.manifest.version);
    await service.approvePermissions("legal-labor", []);
    await service.enable("legal-labor");
    expect((await service.catalog()).find((entry) => entry.manifest.id === "legal-labor")?.installed?.state).toBe("active");

    await service.uninstall("legal-labor");
    const uninstalled = (await service.catalog()).find((entry) => entry.manifest.id === "legal-labor");
    expect(uninstalled?.installed).toBeUndefined();
    expect(uninstalled?.eligibility).toMatchObject({ visible: true, canInstall: true, canUse: true });

    await service.install("legal-labor", legalRelease.manifest.version);
    expect(store!.repositories.plugins.listUserUninstalledIds()).toEqual([]);
  });

  it("does not download or reinstall an unchanged installed release on account refresh", async () => {
    const { service, artifactManager } = createContext();
    await service.install(release.manifest.id);
    vi.mocked(artifactManager.install).mockClear();
    await service.update(release.manifest.id);
    await service.update(release.manifest.id);
    expect(artifactManager.install).not.toHaveBeenCalled();
    expect(service.list()).toHaveLength(1);
  });

  it("automatically installs after login, drains calls on logout, restores without download, and respects uninstall", async () => {
    let authenticated = false;
    const literature: PluginRelease = { manifest: {
      ...release.manifest, id: "literature-review", permissions: [], configSchema: undefined,
      rules: { distribution: "account", installation: "automatic", requiresLogin: true,
        unavailableVisibility: "visible", autoUpdate: true, recommendsOfficialModel: true }
    } };
    const { service, artifactManager, runtimeHost } = createContext([literature], undefined, () => authenticated);
    const reconcile = () => reconcileEntitledPlugins({ plugins: service, entitlements: [],
      userUninstalledIds: new Set(store!.repositories.plugins.listUserUninstalledIds()) });
    expect((await service.catalog())[0].eligibility.reason).toBe("login_required");
    await expect(service.install("literature-review")).rejects.toThrow(/access denied/);
    await reconcile();
    expect(service.list()).toHaveLength(0);
    authenticated = true;
    await reconcile();
    expect(service.get("literature-review").state).toBe("active");
    runtimeHost.invoke = async function* () {
      yield { type: "progress", current: 1 };
      yield { type: "result", output: { ok: true } };
    };
    const call = service.invoke({ callId: "existing", pluginId: "literature-review", capabilityId: "run",
      conversationId: "chat", input: { topic: "memory" } })[Symbol.asyncIterator]();
    await call.next();
    authenticated = false;
    await reconcile();
    expect(runtimeHost.deactivate).not.toHaveBeenCalled();
    expect(service.list()[0].eligibility?.canUse).toBe(false);
    await expect(service.invoke({ callId: "new", pluginId: "literature-review", capabilityId: "run",
      conversationId: "chat", input: { topic: "memory" } })[Symbol.asyncIterator]().next()).rejects.toThrow(/access denied/);
    expect((await call.next()).value).toMatchObject({ type: "result" });
    await call.next();
    expect(service.get("literature-review").state).toBe("disabled");
    authenticated = true;
    await reconcile();
    expect(service.get("literature-review").state).toBe("active");
    expect(artifactManager.install).toHaveBeenCalledTimes(1);
    await service.uninstall("literature-review");
    await reconcile();
    expect(service.list()).toHaveLength(0);
    await service.install("literature-review");
    expect(store!.repositories.plugins.listUserUninstalledIds()).toEqual([]);
  });

  it("loads a declared renderer from the installed plugin artifact", async () => {
    const rendererRelease: PluginRelease = {
      manifest: { ...release.manifest, ui: { renderer: { entry: "ui/index.html", capabilities: ["run"] } } }
    };
    const { service, artifactManager } = createContext([rendererRelease]);
    await service.install(rendererRelease.manifest.id);

    await expect(service.readUi(rendererRelease.manifest.id, "renderer")).resolves.toBe("<main>renderer</main>");
    expect(artifactManager.readTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: rendererRelease.manifest.id }),
      "ui/index.html",
      512 * 1024
    );
  });

  it("installs, configures, approves, enables, disables, and uninstalls", async () => {
    const { service, runtimeHost, artifactManager, skillManager } = createContext();
    expect((await service.install(release.manifest.id)).state).toBe("pending_approval");
    expect(() => service.configure(release.manifest.id, { config: {} })).toThrow(/Invalid plugin config/);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    expect((await service.approvePermissions(release.manifest.id, release.manifest.permissions)).state).toBe("installed");
    expect((await service.enable(release.manifest.id)).state).toBe("active");
    expect(runtimeHost.activate).toHaveBeenCalledWith(expect.objectContaining({ id: release.manifest.id }), {
      "api-key": "secret"
    });
    expect(skillManager.activate).toHaveBeenCalledWith(expect.objectContaining({ id: release.manifest.id }));
    expect((await service.disable(release.manifest.id)).state).toBe("disabled");
    expect(skillManager.deactivate).toHaveBeenCalledWith(release.manifest.id);
    await service.uninstall(release.manifest.id);
    expect(service.list()).toEqual([]);
    expect(artifactManager.remove).toHaveBeenCalled();
  });

  it("rejects undeclared secrets and permissions", async () => {
    const { service } = createContext();
    await service.install(release.manifest.id);
    expect(() => service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { password: "nope" }
    })).toThrow(/not declared/);
    await expect(service.approvePermissions(release.manifest.id, [{
      type: "network",
      hosts: ["evil.example"]
    }])).rejects.toThrow(/did not declare/);
  });

  it.each(["install", "update"] as const)("rejects a changed artifact digest through %s", async (operation) => {
    const releases: PluginRelease[] = [{
      ...release,
      artifact: { url: "https://plugins.example/review.zip", sha256: "a".repeat(64) }
    }];
    const { service } = createContext(releases);
    await service.install(release.manifest.id);
    releases.push({
      ...release,
      artifact: { url: "https://plugins.example/review.zip", sha256: "b".repeat(64) }
    });

    await expect(service[operation](release.manifest.id)).rejects.toThrow(/digest changed/);
  });

  it("rejects a changed manifest for an installed version", async () => {
    const changed: PluginRelease = { manifest: { ...release.manifest, name: "Changed" } };
    const releases: PluginRelease[] = [release];
    const { service } = createContext(releases);
    await service.install(release.manifest.id);
    releases.push(changed);

    await expect(service.update(release.manifest.id)).rejects.toThrow(/manifest changed/);
  });

  it("compares permission scope independently of descriptions and list order", async () => {
    const declared = [
      { type: "network" as const, hosts: ["api.example", "cdn.example"], description: "Paper APIs" },
      { type: "secret" as const, keys: ["api-key", "client-id"], description: "Credentials" }
    ];
    const pluginRelease: PluginRelease = {
      manifest: { ...release.manifest, permissions: declared }
    };
    const { service } = createContext([pluginRelease]);
    await service.install(release.manifest.id);

    expect(await service.approvePermissions(release.manifest.id, [
      { type: "network", hosts: ["cdn.example", "api.example"] },
      { type: "secret", keys: ["client-id", "api-key"] }
    ])).toMatchObject({ state: "installed" });
  });

  it("marks activation failures without publishing the plugin as active", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    vi.mocked(runtimeHost.activate).mockRejectedValueOnce(new Error("offline"));
    await expect(service.enable(release.manifest.id)).rejects.toThrow(/offline/);
    expect(service.get(release.manifest.id)).toMatchObject({ state: "failed", lastError: "offline" });
  });

  it("marks an active plugin failed when a permission change cannot stop its runtime", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    vi.mocked(runtimeHost.deactivate).mockRejectedValueOnce(new Error("busy"));

    await expect(service.approvePermissions(release.manifest.id, [])).rejects.toThrow(/busy/);
    expect(service.get(release.manifest.id)).toMatchObject({
      state: "failed",
      approvedPermissions: release.manifest.permissions,
      lastError: "busy"
    });
  });

  it("invokes only active declared capabilities", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    const events = [];
    for await (const event of service.invoke({
      callId: "call-1",
      pluginId: release.manifest.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: {}
    })) events.push(event);
    expect(events).toEqual([{ type: "result", output: { ok: true } }]);
    expect(runtimeHost.invoke).toBeDefined();
    expect(store!.db.prepare("SELECT outcome, error_code FROM plugin_call_logs WHERE call_id = ?")
      .get("call-1")).toEqual({ outcome: "success", error_code: null });
    expect(() => service.configure(release.manifest.id, {
      config: { database: "pubmed" }
    })).toThrow(/Disable plugin/);
  });

  it("rewrites result paths to the copies published in the conversation workspace", async () => {
    const sourcePath = join(tmpdir(), "plugin-data", "review-1", "outputs", "review.md");
    const publishedPath = join(tmpdir(), "workspace", "outputs", "com.example.review", "review-1", "review.md");
    const localArtifactService: PluginLocalArtifactService = {
      host: vi.fn(async (_plugin, artifact) => ({ ...artifact, path: publishedPath })),
      open: vi.fn(async () => ({ path: sourcePath, name: "review.md", mediaType: "text/markdown" })),
      revokePlugin: vi.fn()
    };
    const { service, runtimeHost } = createContext([release], localArtifactService);
    runtimeHost.invoke = async function* () {
      yield {
        type: "artifact",
        artifact: {
          id: "review",
          name: "review.md",
          mediaType: "text/markdown",
          uri: pathToFileURL(sourcePath).href
        }
      };
      yield { type: "result", output: { data: { outputs: [{ path: sourcePath }] } } };
    };
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);

    const events = [];
    for await (const event of service.invoke({
      callId: "call-1",
      pluginId: release.manifest.id,
      capabilityId: "run",
      conversationId: "websocket:chat-1",
      input: { taskId: "review-1" }
    })) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({ type: "artifact", artifact: expect.objectContaining({ path: publishedPath }) }),
      { type: "result", output: { data: { outputs: [{ path: publishedPath }] } } }
    ]);
    expect(localArtifactService.host).toHaveBeenCalledWith(
      expect.objectContaining({ id: release.manifest.id }),
      expect.objectContaining({ id: "review" }),
      { conversationId: "websocket:chat-1", taskId: "review-1", callId: "call-1" }
    );
  });

  it("updates an active plugin and reactivates it atomically", async () => {
    const nextRelease: PluginRelease = {
      manifest: { ...release.manifest, version: "2.0.0" }
    };
    const { service, runtimeHost } = createContext([release, nextRelease]);
    await service.install(release.manifest.id, "1.0.0");
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    expect(await service.update(release.manifest.id, "2.0.0")).toMatchObject({
      version: "2.0.0",
      state: "active",
      config: { database: "crossref" }
    });
    expect(runtimeHost.deactivate).toHaveBeenCalledWith(release.manifest.id);
    expect(runtimeHost.activate).toHaveBeenCalledTimes(2);
  });

  it("restores the previous active version when an update cannot activate", async () => {
    const nextRelease: PluginRelease = { manifest: { ...release.manifest, version: "2.0.0" } };
    const { service, runtimeHost, artifactManager } = createContext([release, nextRelease]);
    vi.mocked(artifactManager.install).mockImplementation(async (pluginRelease) => ({
      artifactHash: pluginRelease.manifest.version,
      rootPath: `/plugins/${pluginRelease.manifest.version}`
    }));
    await service.install(release.manifest.id, "1.0.0");
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    vi.mocked(runtimeHost.activate).mockRejectedValueOnce(new Error("new version failed"));

    await expect(service.update(release.manifest.id, "2.0.0")).rejects.toThrow(/new version failed/);
    expect(service.get(release.manifest.id)).toMatchObject({ version: "1.0.0", state: "active" });
    expect(runtimeHost.activate).toHaveBeenCalledTimes(3);
    expect(artifactManager.remove).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: "/plugins/2.0.0"
    }));
  });

  it("restores and closes persisted active runtimes without changing their state", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    vi.mocked(runtimeHost.activate).mockClear();

    await service.restoreActive();
    await service.shutdown();

    expect(runtimeHost.activate).toHaveBeenCalledOnce();
    expect(runtimeHost.deactivate).toHaveBeenCalledWith(release.manifest.id);
    expect(service.get(release.manifest.id).state).toBe("active");
  });
});
