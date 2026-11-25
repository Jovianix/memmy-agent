import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Check, GripVertical, LoaderCircle, Square, X } from "lucide-react";
import type { EventCaptureSession } from "@memmy/local-api-contracts";
import { useTranslation } from "../i18n/use-translation.js";

type Position = { left: number; top: number };

export function DemonstrationControls({ session, duration, elapsed, busy, error, onStop, onDiscard, onContinue }: {
  session: EventCaptureSession; duration: string; elapsed: number; busy: boolean; error: string | null;
  onStop: () => void; onDiscard: () => void; onContinue?: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const live = ["starting", "recording", "finalizing"].includes(session.state);
  const wasLive = useRef(live);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<Position | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);
  useEffect(() => { if (live) wasLive.current = true; }, [live]);

  function move(left: number, top: number) {
    const rect = bar.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(4, Math.min(left, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(top, window.innerHeight - rect.height - 4)) });
  }
  useEffect(() => {
    function resize() { const rect = bar.current?.getBoundingClientRect(); if (rect) move(rect.left, rect.top); }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  function beginDrag(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || !bar.current) return;
    const rect = bar.current.getBoundingClientRect();
    drag.current = { left: e.clientX - rect.left, top: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  async function resume() {
    if (sendLock.current || !onContinue) return;
    sendLock.current = true; setSending(true);
    try { if (await onContinue()) setDismissed(true); }
    catch { /* The chat submission reports connection errors; leave the control available to retry. */ }
    finally { sendLock.current = false; setSending(false); }
  }
  // A saved session remains available in chat. Opening its history should never reopen its controls.
  if (dismissed || (!live && !wasLive.current && session.state !== "failed")) return null;
  const recording = session.state === "recording";
  const ready = session.state === "ready" && session.eventCount > 0;
  const label = live ? recording ? "active" : session.state === "starting" ? "starting" : "ending"
    : session.state === "failed" ? "failed" : session.state === "cancelled" ? "cancelled" : ready ? "ended" : "empty";
  return createPortal(<div ref={bar} id="memmy-recording-controls" className="demonstration-controls" role="region" aria-label={t("plugins.recording.label")}
    data-recording-session={session.id} style={position ? { ...position, right: "auto" } : undefined}>
    <button id="memmy-recording-move" className="demonstration-grip" aria-label={t("plugins.recording.move")} title={t("plugins.recording.move")}
      onPointerDown={beginDrag} onLostPointerCapture={() => { drag.current = null; }}
      onPointerMove={e => { if (drag.current) move(e.clientX - drag.current.left, e.clientY - drag.current.top); }}
      onKeyDown={e => {
        const rect = bar.current?.getBoundingClientRect();
        if (!rect || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        move(rect.left + (e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0), rect.top + (e.key === "ArrowDown" ? 16 : e.key === "ArrowUp" ? -16 : 0));
      }}><GripVertical size={14} /></button>
    {busy || (live && !recording) ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
      : recording ? <span className="demonstration-dot" /> : ready ? <Check size={15} aria-hidden="true" /> : null}
    <strong role="status">{t(`plugins.recording.${label}`)}</strong>
    <time role="timer" aria-live="off" aria-label={t("plugins.recording.elapsed")} dateTime={`PT${elapsed}S`}>{duration}</time>
    {live ? <>
      <button id="memmy-recording-stop" className="demonstration-action" disabled={busy || !recording} onClick={onStop}><Square size={11} />{t("plugins.recording.stop")}</button>
      <button id="memmy-recording-discard" className="demonstration-quiet" disabled={busy || session.state === "finalizing"} onClick={onDiscard}>{t("plugins.recording.discard")}</button>
    </> : <>
      {ready && onContinue && <button id="memmy-recording-continue" className="demonstration-action" disabled={sending} onClick={() => void resume()}>{t("plugins.recording.done")}</button>}
      <button id="memmy-recording-dismiss" className="demonstration-quiet" aria-label={t("plugins.recording.dismiss")} onClick={() => setDismissed(true)}><X size={14} /></button>
    </>}
    {error && <span className="demonstration-error" role="alert">{error}</span>}
  </div>, document.body);
}
