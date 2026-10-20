import { useEffect, useState } from "react";
import { EventCaptureSessionSchema, PluginConversationPresentationSchema, type PluginConversationPresentation, type EventCaptureSession, type InstalledPlugin, type RuntimeConfig } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../api/plugins-client.js";
import { createEventsConnection } from "../api/events.js";
import { useTranslation } from "../i18n/use-translation.js";
import { Button } from "../components/button.js";

export function PluginConversationRecording({ client, config, plugins, conversationId: currentConversationId, onPrompt }: {
  client?: PluginsClient; config?: RuntimeConfig; plugins: InstalledPlugin[]; conversationId: string | null; onPrompt: (text: string) => void;
}) {
  const { language } = useTranslation(), cn = language === "zh-CN";
  const conversationId = currentConversationId?.replace(/^websocket:/, "") ?? null;
  const [sessions, setSessions] = useState<Array<{ plugin: InstalledPlugin; session: EventCaptureSession; presentation?: PluginConversationPresentation }>>([]);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const key = plugins.filter(p => p.state === "active" && p.manifest.conversation).map(p => `${p.id}:${p.version}`).join("|");
  useEffect(() => { setNotice(""); }, [conversationId]);
  useEffect(() => {
    let active = true, pending = false;
    setSessions([]); setError(null);
    if (!conversationId || !client || !key) return;
    const owners = plugins.filter(p => p.state === "active" && p.manifest.conversation);
    const refresh = async () => {
      if (pending) return; pending = true;
      try {
        const results = await Promise.all(owners.map(async plugin => {
          const response = await client.invoke(plugin.id, plugin.manifest.conversation!.recordingCapabilityId,
            { conversationId, input: { action: "status" }, origin: "user", background: true });
          if (response.event.type === "error") { window.dispatchEvent(new Event("memmy:plugins-changed")); throw new Error(response.event.message); }
          const output = response.event.type === "result" ? response.event.output as { sessions?: unknown[] } : {};
          return (output.sessions ?? []).map(raw => ({ plugin, session: EventCaptureSessionSchema.parse(raw), presentation: PluginConversationPresentationSchema.optional().parse((raw as { presentation?: unknown }).presentation) }));
        }));
        if (active) { setSessions(results.flat().filter(item => item.session.conversationId === conversationId)); setError(null); }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1_500);
    const connection = config && typeof EventSource !== "undefined" ? createEventsConnection(config) : null;
    const onEvent = (event: MessageEvent) => {
      try { const payload = JSON.parse(String(event.data)); if (payload.origin === "agent" && payload.conversationId === conversationId && owners.some(p => p.id === payload.pluginId)) void refresh(); } catch { /* Ignore other events. */ }
    };
    connection?.addEventListener("plugin.capability_event", onEvent as EventListener);
    const changed = () => void refresh(); window.addEventListener("memmy:plugins-changed", changed);
    return () => { active = false; clearInterval(timer); connection?.close(); window.removeEventListener("memmy:plugins-changed", changed); };
  }, [client, config, conversationId, key]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  const selected = [...sessions].sort((a, b) => Number(b.session.state === "recording") - Number(a.session.state === "recording")
    || b.session.startedAt.localeCompare(a.session.startedAt))[0];
  async function control(action: "stop" | "cancel" | "disable") {
    if (!selected || !client || !conversationId || busy) return;
    setBusy(true); setError(null);
    try {
      if (action === "disable") {
        await client.disable(selected.plugin.id);
        setNotice(cn ? "插件已停用，录制已终止；片段和技能已保留。" : "Plugin disabled. Recording ended; fragments and skills were retained.");
        setSessions([]); window.dispatchEvent(new Event("memmy:plugins-changed"));
      } else {
        const response = await client.invoke(selected.plugin.id, selected.plugin.manifest.conversation!.recordingCapabilityId,
          { conversationId, origin: "user", input: { action, session_id: selected.session.id } });
        if (response.event.type === "error") throw new Error(response.event.message);
        if (response.event.type === "result") {
          const session = EventCaptureSessionSchema.parse(response.event.output);
          setSessions(old => old.map(item => item.session.id === session.id ? { ...item, session, presentation: PluginConversationPresentationSchema.optional().parse((response.event.type === "result" ? response.event.output as { presentation?: unknown } : {}).presentation) } : item));
        }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  if (!selected) return error || notice ? <div className="mx-4 my-2 text-sm" role={error ? "alert" : "status"}>{error ?? notice}</div> : null;
  const { session, presentation } = selected, recording = session.state === "recording";
  const elapsed = Math.max(0, Math.floor(((session.endedAt ? Date.parse(session.endedAt) : now) - Date.parse(session.startedAt)) / 1_000));
  const duration = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const availability = cn ? { pending: "待核对", available: "可用", empty: "无可用事件", partial: "部分可用", unavailable: "不可用" }[session.availability] : session.availability;
  const label = error ? cn ? "状态待核对" : "Status unavailable" : recording ? cn ? "录制中" : "Recording" :
    session.state === "ready" ? cn ? "录制已结束" : "Recording ended" : session.state === "cancelled" ? cn ? "录制已取消" : "Recording cancelled" :
    session.state === "finalizing" ? cn ? "正在结束录制" : "Ending recording" : session.state === "starting" ? cn ? "正在启动录制" : "Starting recording" : cn ? "录制失败" : "Recording failed";
  return <section aria-label={cn ? "对话录制" : "Conversation recording"} className="mx-4 my-2 rounded-card border border-border-stone/40 bg-background-paper p-3 text-sm" aria-live="polite">
    <div className="flex flex-wrap items-center gap-3"><strong>{recording && !error ? "● " : ""}{label}</strong><time aria-live="off">{duration}</time><span>{session.goal}</span>
      {recording && <><Button size="sm" disabled={busy} onClick={() => void control("stop")}>{cn ? "结束录制" : "End recording"}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void control("cancel")}>{cn ? "取消" : "Cancel"}</Button></>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control("disable")}>{cn ? "停用插件" : "Disable plugin"}</Button>
    </div>
    {!recording && <p className="mt-2">{session.eventCount} {cn ? "条事件" : "events"}{session.applications.length ? ` · ${session.applications.join(", ")}` : ""} · {availability}</p>}
    {presentation && <div className="mt-2 flex flex-wrap items-center gap-3"><span>{presentation.message}</span>
      {presentation.actions.map(action => <Button key={action.id} size="sm" disabled={busy} onClick={() => onPrompt(action.prompt)}>{action.label}</Button>)}</div>}
    {session.error && <p role="alert">{session.error}</p>}{error && <p role="alert">{error}</p>}
    {session.limitations.length > 0 && !recording && <details className="mt-2"><summary>{cn ? "采集范围与限制" : "Capture scope and limitations"}</summary>{session.limitations.map((text, i) => <p key={i}>{text}</p>)}</details>}
  </section>;
}
