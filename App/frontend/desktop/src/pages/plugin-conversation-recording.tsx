import { useEffect, useState } from "react";
import { LoaderCircle, Square, Video, X } from "lucide-react";
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
  const [endingAt, setEndingAt] = useState<number | null>(null);
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
  const selected = sessions.filter(item => item.session.conversationId === conversationId).sort((a, b) => Number(["starting", "recording", "finalizing"].includes(b.session.state)) - Number(["starting", "recording", "finalizing"].includes(a.session.state))
    || b.session.startedAt.localeCompare(a.session.startedAt))[0];
  const ongoing = selected && ["starting", "recording", "finalizing"].includes(selected.session.state);
  useEffect(() => {
    setNow(Date.now()); setEndingAt(null);
    if (!ongoing) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [selected?.session.id, ongoing]);
  async function control(action: "stop" | "cancel" | "disable") {
    if (!selected || !client || !conversationId || busy) return;
    setBusy(true); setEndingAt(Date.now()); setError(null);
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
    finally { setBusy(false); setEndingAt(null); }
  }
  if (!selected) return error || notice ? <div className="mx-4 my-2 text-sm" role={error ? "alert" : "status"}>{error ?? notice}</div> : null;
  const { session, presentation } = selected, recording = session.state === "recording";
  const elapsed = session.state === "starting" ? 0 : Math.max(0, Math.floor(((session.endedAt ? Date.parse(session.endedAt) : endingAt ?? now) - Date.parse(session.startedAt)) / 1_000));
  const duration = `${elapsed >= 3600 ? `${String(Math.floor(elapsed / 3600)).padStart(2, "0")}:` : ""}${String(Math.floor(elapsed / 60) % 60).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const availability = cn ? { pending: "待核对", available: "可用", empty: "无可用事件", partial: "部分可用", unavailable: "不可用" }[session.availability] : session.availability;
  const label = error ? cn ? "状态待核对" : "Status unavailable" : busy ? cn ? "正在结束录制" : "Ending recording" : recording ? cn ? "录制中" : "Recording" :
    session.state === "ready" ? cn ? "录制已结束" : "Recording ended" : session.state === "cancelled" ? cn ? "录制已取消" : "Recording cancelled" :
    session.state === "finalizing" ? cn ? "正在结束录制" : "Ending recording" : session.state === "starting" ? session.browserCapture
      ? cn ? "正在准备教学窗口" : "Preparing teaching window" : cn ? "正在启动录制" : "Starting recording" : cn ? "录制失败" : "Recording failed";
  return <section aria-label={cn ? "对话录制" : "Conversation recording"} data-recording-session={session.id}
    className={ongoing ? `recording-bar recording-bar--activity${recording && !busy && !error ? " recording-bar--live" : ""}` : "mx-4 my-2 rounded-card border border-border-stone/40 bg-background-paper p-3 text-sm"} aria-live="polite">
    {ongoing ? <>
      <span className="recording-bar__icon" aria-hidden="true">{busy || session.state === "starting" || session.state === "finalizing" ? <LoaderCircle size={18} className="animate-spin" /> : <Video size={18} />}</span>
      <strong className="recording-bar__title"><span className="recording-bar__indicator" aria-hidden="true" />{label}</strong>
      <time className="recording-bar__clock" role="timer" aria-label={cn ? "录制时长" : "Recording elapsed time"} aria-live="off" dateTime={`PT${elapsed}S`}>{duration}</time>
      <span className="recording-bar__goal" title={session.goal}>{selected.plugin.manifest.name} · {session.goal}</span>
      <div className="recording-bar__actions">
        <button type="button" className="recording-bar__button" disabled={busy || !recording} onClick={() => void control("stop")}><Square size={12} aria-hidden="true" />{cn ? "结束录制" : "End recording"}</button>
        <button type="button" className="recording-bar__button" disabled={busy || session.state === "finalizing"} onClick={() => void control("cancel")}><X size={13} aria-hidden="true" />{cn ? "取消" : "Cancel"}</button>
        <button type="button" className="recording-bar__button" disabled={busy} onClick={() => void control("disable")}>{cn ? "停用插件" : "Disable plugin"}</button>
      </div>
      {session.availability === "partial" && <p className="recording-bar__note recording-bar__note--warning">{cn ? "采集部分可用，结束后请核对录制片段。" : "Capture coverage is partial. Review the fragment after recording."}</p>}
      {session.limitations.includes("browser_capture_popup_unconfirmed") && <p className="recording-bar__note recording-bar__note--warning">{cn
        ? "有弹窗尚未确认来源，未纳入录制；请在教学窗口中继续操作。" : "A popup's source could not be confirmed and it was excluded. Continue in the teaching window."}</p>}
      {session.browserCapture && <p className="recording-bar__note">{session.state === "starting"
        ? cn ? "正在绑定新教学窗口，尚未开始录制。" : "Binding a new teaching window. Recording has not started."
        : cn ? "仅记录教学窗口及其弹窗；沿用日常登录态，原有窗口不纳入。" : "Only the teaching window and its popups are recorded. Existing sign-in is retained; everyday windows are excluded."}</p>}
    </> : <div className="flex flex-wrap items-center gap-3"><strong>{label}</strong><time aria-live="off">{duration}</time><span>{session.goal}</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control("disable")}>{cn ? "停用插件" : "Disable plugin"}</Button>
    </div>}
    {!recording && <p className="mt-2">{session.eventCount} {cn ? "条事件" : "events"}{session.applications.length ? ` · ${session.applications.join(", ")}` : ""} · {availability}</p>}
    {session.state === "ready" && session.captureIntegrity && <p className="mt-2" role="status">{!session.captureIntegrity.snapshotSaved
      ? cn ? "录制片段保存未完成。" : "The recording snapshot could not be saved."
      : !session.captureIntegrity.boundaryConfirmed
        ? cn ? "已保留已收到的事件，结束确认未完成。" : "Received events were saved; the end boundary could not be confirmed."
        : !session.captureIntegrity.coverageComplete
          ? cn ? "录制已结束并保存，部分网页操作未能确认完整；生成技能前请核对片段。" : "Recording ended and was saved with coverage gaps. Review the fragment before creating a skill."
          : cn ? "录制已结束并保存。" : "Recording ended and was saved."}</p>}
    {presentation && <div className="mt-2 flex flex-wrap items-center gap-3"><span>{presentation.message}</span>
      {presentation.actions.map(action => <Button key={action.id} size="sm" disabled={busy} onClick={() => onPrompt(action.prompt)}>{action.label}</Button>)}</div>}
    {session.error && <p role="alert" className={ongoing ? "recording-bar__note recording-bar__note--warning" : undefined}>{session.error}</p>}{error && <p role="alert" className={ongoing ? "recording-bar__note recording-bar__note--warning" : undefined}>{error}</p>}
    {session.limitations.length > 0 && !recording && <details className="mt-2"><summary>{cn ? "采集范围与限制" : "Capture scope and limitations"}</summary>{session.limitations.map((text, i) => <p key={i}>{text}</p>)}</details>}
  </section>;
}
