import { useEffect, useRef, useState } from "react";
import type { InstalledPlugin, PluginCatalogEntry } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../api/plugins-client.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { useTranslation } from "../i18n/use-translation.js";

export function PluginStoreSection({ client, platform }: { client?: PluginsClient; platform?: string }) {
  const { language } = useTranslation(), cn = language === "zh-CN";
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]), [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<InstalledPlugin | null>(null);
  const mutating = useRef(false);
  const os = platform ?? (typeof window !== "undefined" ? window.memmy?.platform : undefined);
  const refresh = async () => {
    if (!client) return;
    const results = await Promise.allSettled([client.catalog(), client.list()]);
    if (results[0].status === "fulfilled") setCatalog(results[0].value); else setError(cn ? "暂时无法连接插件商店，请稍后刷新。" : "Plugin store is unavailable. Try refreshing later.");
    if (results[1].status === "fulfilled") setInstalled(results[1].value);
  };
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15_000); return () => clearInterval(timer); }, [client, cn]);
  const mutate = async (id: string, operation: () => Promise<unknown>) => {
    if (mutating.current) return; mutating.current = true; setBusy(id); setError(null);
    try { await operation(); await refresh(); window.dispatchEvent(new Event("memmy:plugins-changed")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { mutating.current = false; setBusy(null); }
  };
  const items: PluginCatalogEntry[] = [...catalog, ...installed.filter(p => !catalog.some(c => c.manifest.id === p.id)).map(p => ({
    manifest: p.manifest,
    eligibility: p.eligibility ?? { visible: true, canInstall: true, canUse: true, reason: null },
    installed: p
  }))];
  return <section aria-label={cn ? "插件商店" : "Plugin store"} className="mb-6 rounded-card border border-border-stone/30 bg-background-paper p-4">
    <header className="flex items-center justify-between"><h2>{cn ? "插件商店" : "Plugin store"}</h2><button onClick={() => void refresh()}>{cn ? "刷新" : "Refresh"}</button></header>
    {error && <p role="alert">{error}</p>}
    {items.filter(item => item.eligibility.visible).map(({ manifest: item, eligibility }) => {
      const platforms = item.platforms ?? [];
      const plugin = installed.find(p => p.id === item.id), supported = !platforms.length || platforms.some(p => p === os);
      return <article key={item.id} className="mt-3 rounded-card border border-border-stone/30 p-4">
        <h3>{item.name}</h3><p>{item.description ?? item.capabilities[0]?.description}</p><p className="text-xs text-text-ink/60">{item.version} · {plugin?.state ?? (cn ? "未安装" : "Not installed")}{(item.rules?.autoUpdate ?? item.updateMode === "automatic") ? cn ? " · 自动更新" : " · Automatic updates" : ""}</p>
        <p className="text-xs text-text-ink/60">{platforms.map(platform => ({ win32: "Windows", darwin: "macOS", linux: "Linux" })[platform]).join(" / ")}{item.minimumHostVersion ? ` · Memmy ≥ ${item.minimumHostVersion}` : ""}</p>
        {!supported && <p>{cn ? "当前平台暂不支持" : "Not supported on this platform"} ({platforms.join(", ")})</p>}
        {!eligibility.canUse && <p>{eligibility.reason === "login_required" ? cn ? "登录后可用" : "Sign in to use" : cn ? "当前账号未获授权" : "Account access required"}</p>}
        <div className="mt-2 flex gap-3">
          {!plugin ? <button disabled={!client || !supported || !eligibility.canInstall || busy !== null} onClick={() => void mutate(item.id, async () => {
            const result = await client!.install(item.id, item.version);
            if (result.state === "pending_approval") setApproval(result); else await client!.enable(item.id);
          })}>{busy === item.id ? cn ? "下载中…" : "Downloading…" : cn ? "安装" : "Install"}</button>
            : <>{plugin.manifest.conversation && plugin.state !== "pending_approval" ? <span className="text-sm">{cn ? "在对话中启用或停用插件" : "Enable or disable this plugin in chat"}</span> : <button disabled={busy !== null || !supported || (plugin.state !== "active" && !eligibility.canUse)} onClick={() => plugin.state === "pending_approval" ? setApproval(plugin)
              : void mutate(item.id, () => plugin.state === "active" ? client!.disable(item.id) : client!.enable(item.id))}>
              {plugin.state === "active" ? cn ? "停用" : "Disable" : plugin.state === "pending_approval" ? cn ? "授权并启用" : "Approve and enable" : cn ? "启用" : "Enable"}</button>}
              <button disabled={busy !== null} onClick={() => void mutate(item.id, () => client!.uninstall(item.id))}>{cn ? "卸载（保留插件数据）" : "Uninstall (keep plugin data)"}</button></>}
        </div>{plugin?.lastError && <p role="alert">{plugin.lastError}</p>}
      </article>;
    })}
    <ConfirmDialog open={!!approval} title={cn ? "确认插件权限" : "Approve plugin permissions"}
      message={approval?.manifest.permissions.map(p => p.description ?? (p.type === "host-service" ? p.services.join(", ") : p.type)).join("\n") ?? ""}
      cancelLabel={cn ? "暂不启用" : "Not now"} confirmLabel={cn ? "授权并启用" : "Approve and enable"} onCancel={() => setApproval(null)}
      onConfirm={() => { const plugin = approval; setApproval(null); if (plugin) void mutate(plugin.id, async () => {
        await client!.approvePermissions(plugin.id, plugin.manifest.permissions); await client!.enable(plugin.id);
      }); }} />
  </section>;
}
