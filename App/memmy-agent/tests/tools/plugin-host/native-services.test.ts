import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativePluginServices } from "../../../src/tools/plugin-host/native-services.js";
import { collectorGate } from "../../../src/tools/computer-history/core/collector-gate.js";
import type { RecordingResult, TaskRecordingDriver } from "../../../src/tools/computer-recordings/session-service.js";

const roots: string[] = [], services: ReturnType<typeof createNativePluginServices>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
function fixture(options: Parameters<typeof createNativePluginServices>[0] = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-plugin-")); roots.push(dataRoot);
  const service = createNativePluginServices({ platform: "win32", dataRoot, ...options }); services.push(service);
  const invoke = (pluginId: string, name: string, input: Record<string, unknown> = {}) => service.invoke({ pluginId, service: name, input });
  return { service, dataRoot, invoke };
}
describe("identity-bound native plugin services", () => {
  it("advertises ordered checkpoints without upgrading incomplete capture evidence", async () => {
    const checkpoint = vi.fn(async () => ({ running: true, complete: false, rangeEvaluated: true,
      boundaryConfirmed: true, limitations: ["Controlled coverage gap"], streams: [] }));
    const f = fixture({ history: { acquireEventCapture: async () => ({ checkpoint, release: async () => undefined }) } });
    const configuration = await f.invoke("test.capture", "event-sessions", { action: "configuration" });
    expect(configuration.features).toContain("memmy.event-checkpoints/v1");
    const started = await f.invoke("test.capture", "event-sessions", {
      action: "start", conversationId: "checkpoint-test", goal: "Keep missing coverage visible", consent: true
    });
    const stopped = await f.invoke("test.capture", "event-sessions", {
      action: "stop", conversationId: "checkpoint-test", session_id: started.id
    });
    expect(stopped.availability).toBe("partial");
    expect(stopped.limitations).toContain("Controlled coverage gap");
    expect(checkpoint).toHaveBeenCalled();
  });
  it("shares collection ownership with Computer History and other task recorders", async () => {
    const historyBusy = vi.fn(() => true), f = fixture({ historyBusy });
    await expect(f.invoke("test.capture", "collector", { action: "acquire" })).rejects.toThrow("collector_busy");
    historyBusy.mockReturnValue(false);
    const historyRelease = collectorGate.acquire("history");
    try { await expect(f.invoke("test.capture", "collector", { action: "acquire" })).rejects.toThrow("collector_busy"); }
    finally { historyRelease(); }
    const lease = await f.invoke("test.capture", "collector", { action: "acquire" });
    expect(() => collectorGate.acquire("history")).toThrow("collector_busy");
    await expect(f.invoke("other", "collector", { action: "acquire" })).rejects.toThrow("collector_busy");
    await expect(f.invoke("other", "collector", { action: "release", leaseId: lease.leaseId })).rejects.toThrow("Invalid collector lease");
    await f.invoke("test.capture", "collector", { action: "release", leaseId: lease.leaseId });
    expect(collectorGate.busy).toBe(false);
  });
  it("requires Windows and an owned lease for desktop control", async () => {
    const focus = vi.fn(async () => undefined), f = fixture({ focus });
    await expect(f.invoke("test.capture", "window-focus", { pid: 42, hwnd: "10" })).rejects.toThrow("lease required");
    await f.invoke("test.capture", "collector", { action: "acquire" });
    await f.invoke("test.capture", "window-focus", { pid: 42, hwnd: "10" }); expect(focus).toHaveBeenCalledWith(42, 10);
    const unsupported = fixture({ platform: "linux" });
    await expect(unsupported.invoke("test.capture", "collector", { action: "acquire" })).rejects.toThrow("requires Windows");
  });
  it("stops owned capture on worker exit, preserves evidence and releases the parent lease", async () => {
    let finish!: (result: RecordingResult) => void;
    const result: RecordingResult = { durationMs: 25, video: null, parts: [], gaps: [], qpc: null,
      videoIntegrity: "missing", timelineCompleteness: "partial", error: "interrupted" };
    const stop = vi.fn(async () => { finish(result); return result; });
    const driver: TaskRecordingDriver = {
      start: vi.fn(async () => ({ finished: new Promise<RecordingResult>(resolve => { finish = resolve; }), stop,
        pause: async () => undefined, resume: async () => undefined, timeMs: () => 25 })),
      recover: async () => result, exportFlow: async () => [],
    };
    const f = fixture({ driverFactory: () => driver });
    const lease = await f.invoke("test.capture", "collector", { action: "acquire" });
    await expect(f.invoke("other", "recording", { action: "start", leaseId: lease.leaseId })).rejects.toThrow("lease required");
    const recorded = await f.invoke("test.capture", "recording", { action: "start", leaseId: lease.leaseId,
      recording: { title: "Owned demonstration", applications: ["C:\\Windows\\notepad.exe"], consent: true },
      target: { pid: 42, hwnd: "10", processStart: "123456" } });
    expect(recorded.state).toBe("recording");
    await expect(f.invoke("other", "recording", { action: "get", id: recorded.id })).rejects.toThrow("recording_not_found");
    await f.service.release("test.capture");
    expect(stop).toHaveBeenCalledOnce(); expect(collectorGate.busy).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.dataRoot, "test.capture", "recordings", String(recorded.id), "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ state: "failed", taskEndReason: "app_exit" });
    expect(fs.existsSync(path.join(f.dataRoot, "test.capture", "recordings", String(recorded.id), "events.jsonl"))).toBe(true);
  });
});

it("reclaims capture owners after the backend heartbeat disappears while keeping a renewed owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-owner-timeout-"));
  const stream = path.join(root, "events.jsonl"); fs.writeFileSync(stream, "");
  let now = 0, releases = 0;
  const service = createNativePluginServices({ dataRoot: root, platform: "win32", now: () => now, leaseTimeoutMs: 30,
    history: { acquireEventCapture: async () => ({ checkpoint: async () => ({ running: true, complete: true, limitations: [], streams: [{ id: "test", file: stream, size: 0 }] }), release: async () => { releases++; } }) } });
  try {
    const a = await service.invoke({ pluginId: "fixture.a", service: "event-sessions", input: { action: "start", conversationId: "chat-a", goal: "Capture one", consent: true } });
    await service.invoke({ pluginId: "fixture.b", service: "event-sessions", input: { action: "start", conversationId: "chat-b", goal: "Capture two", consent: true } });
    now = 25; await service.invoke({ pluginId: "fixture.b", service: "event-sessions", input: { action: "owner-status" } });
    now = 40; await service.reconcile();
    expect(releases).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, "fixture.a", "event-sessions", String(a.id), "session.json"), "utf8"))).toMatchObject({ state: "failed" });
    expect(await service.invoke({ pluginId: "fixture.b", service: "event-sessions", input: { action: "owner-status" } })).toEqual({ busy: true });
  } finally { await service.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});
