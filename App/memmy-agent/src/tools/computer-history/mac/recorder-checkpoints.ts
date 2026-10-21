import readline from "node:readline";
import type { Readable } from "node:stream";
import type { CaptureRange } from "../core/event-capture-source.js";

const identity = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Acknowledgement follows the native barrier, queued normalization and fsync. */
export function recorderCheckpoints(options: {
  input: Readable; requestNative?: (id: string, range?: CaptureRange) => void;
  persist: () => Promise<void>; write: (line: string) => void; timeoutMs?: number;
}) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lines = readline.createInterface({ input: options.input });
  let closed = false;
  const finish = async (id: string, complete: boolean, rangeEvaluated = false) => {
    const timer = pending.get(id);
    if (!timer) return;
    clearTimeout(timer); pending.delete(id);
    try { await options.persist(); }
    catch { complete = false; }
    if (!closed) options.write("[recorder-checkpoint] " + JSON.stringify({ id, complete, ...(rangeEvaluated ? { rangeEvaluated: true } : {}) }));
  };
  lines.on("line", line => {
    if (closed || line.length > 512 || pending.size >= 16) return;
    try {
      const command = JSON.parse(line);
      if (command.kind !== "checkpoint" || typeof command.id !== "string" || !identity.test(command.id) || pending.has(command.id)) return;
      const range = typeof command.from === "string" && Number.isFinite(Date.parse(command.from))
        && (command.through === undefined || (typeof command.through === "string" && Date.parse(command.through) >= Date.parse(command.from)))
        ? { from: command.from, ...(command.through ? { through: command.through } : {}) } : undefined;
      const timer = setTimeout(() => { void finish(command.id, false); }, options.timeoutMs ?? 9_000);
      timer.unref(); pending.set(command.id, timer);
      if (!options.requestNative) { void finish(command.id, false); return; }
      try { range ? options.requestNative(command.id, range) : options.requestNative(command.id); } catch { void finish(command.id, false); }
    } catch { /* Recorder stdin carries controls, never executable instructions. */ }
  });
  return {
    acknowledge(event: Record<string, unknown>): boolean {
      if (event.kind !== "session.checkpoint") return false;
      if (typeof event.id === "string") void finish(event.id, event.complete === true, event.rangeEvaluated === true);
      return true;
    },
    close() { closed = true; lines.close(); for (const timer of pending.values()) clearTimeout(timer); pending.clear(); }
  };
}
