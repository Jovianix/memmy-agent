import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventCaptureSessionSchema, type EventCaptureSession } from "@memmy/local-api-contracts";
import type { EventCaptureSource, EventCaptureSubscription, CaptureCheckpoint } from "../computer-history/core/event-capture-source.js";
import { writeJsonAtomic } from "../computer-recordings/session-service.js";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const controls = /^recording_(?:started|stopped|paused|resumed)$/;
const maxBytes = 64 * 1024 * 1024;
type Active = { session: EventCaptureSession; subscription: EventCaptureSubscription;
  positions: Map<string, number>; skipLeading: Set<string>; fd: number; bytes: number };

/** Durable, owner/conversation-scoped snapshots of the shared authorized stream. */
export class PluginEventSessions {
  private readonly active = new Map<string, Active>();
  private readonly failed = new Map<string, EventCaptureSession>();
  private pending: Promise<unknown> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private readonly options: { dataRoot: string; source: EventCaptureSource; now?: () => number }) {
    fs.mkdirSync(options.dataRoot, { recursive: true });
    // A Host crash never resumes acquisition. Keep the partial evidence.
    for (const owner of fs.readdirSync(options.dataRoot, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.isSymbolicLink()) continue;
      const root = path.join(options.dataRoot, owner.name, "event-sessions");
      if (!fs.existsSync(root)) continue;
      for (const folder of fs.readdirSync(root)) {
        try {
          const session = this.read(owner.name, folder);
          if (["starting", "recording", "finalizing"].includes(session.state)) {
            session.state = "failed"; session.availability = "partial"; session.error = "capture_interrupted";
            session.endedAt = this.now(); this.save(session);
          }
        } catch { /* Never advertise invalid manifests. */ }
      }
    }
    this.timer = setInterval(() => { void this.serial(async () => {
      for (const active of [...this.active.values()]) {
        try { await this.collect(active); }
        catch (error) { await this.fail(active, error); }
      }
    }).catch(() => undefined); }, 1_000); this.timer.unref();
  }
  private now() { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }
  isBusy(owner: string) { return [...this.active.values()].some(active => active.session.pluginId === owner); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(operation); this.pending = next; return next;
  }
  private folder(owner: string, id: string) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(owner) || !idPattern.test(id)) throw new Error("capture_invalid_identity");
    const root = path.resolve(this.options.dataRoot, owner), folder = path.join(root, "event-sessions", id);
    for (const target of [root, path.dirname(folder), folder]) if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("capture_invalid_path");
    return folder;
  }
  private read(owner: string, id: string) {
    const failed = this.failed.get(id); if (failed?.pluginId === owner) return structuredClone(failed);
    const file = path.join(this.folder(owner, id), "session.json"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200_000) throw new Error("capture_invalid_manifest");
    const session = EventCaptureSessionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (session.id !== id || session.pluginId !== owner) throw new Error("capture_invalid_owner");
    return session;
  }
  private save(session: EventCaptureSession) {
    writeJsonAtomic(path.join(this.folder(session.pluginId, session.id), "session.json"), EventCaptureSessionSchema.parse(session));
  }
  private authorized(owner: string, conversationId: string, id: string) {
    const session = this.read(owner, id);
    if (session.conversationId !== conversationId) throw new Error("capture_not_found_in_conversation");
    return session;
  }
  list(owner: string, conversationId: string): EventCaptureSession[] {
    const root = path.dirname(this.folder(owner, "00000000-0000-0000-0000-000000000000"));
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).flatMap(id => {
      try { const session = this.read(owner, id); return session.conversationId === conversationId ? [session] : []; } catch { return []; }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  start(owner: string, conversationId: string, goal: string, consent: boolean) {
    return this.serial(async () => {
      if (this.closing) throw new Error("capture_shutting_down");
      if (consent !== true || !goal.trim() || goal.length > 2_000) throw new Error("capture_goal_and_consent_required");
      const duplicate = [...this.active.values()].find(a => a.session.pluginId === owner && a.session.conversationId === conversationId);
      if (duplicate) return structuredClone(duplicate.session);
      const subscription = await this.options.source.acquireEventCapture();
      let fd: number | undefined;
      let session: EventCaptureSession | undefined;
      try {
        const initial = await subscription.checkpoint();
        if (!initial.running) throw new Error("capture_not_running");
        session = { schemaVersion: 1, id: randomUUID(), pluginId: owner, conversationId,
          goal: goal.trim(), state: "recording", startedAt: this.now(), endedAt: null, eventCount: 0, eventTypes: {}, applications: [],
          availability: "pending", eventsSha256: null, limitations: initial.limitations, error: null, ranges: [] };
        fs.mkdirSync(this.folder(owner, session.id), { recursive: true, mode: 0o700 });
        fd = fs.openSync(path.join(this.folder(owner, session.id), "events.jsonl"), "wx", 0o600);
        this.save(session);
        const skipLeading = new Set<string>();
        for (const stream of initial.streams) if (stream.size) {
          const input = fs.openSync(stream.file, "r"), last = Buffer.alloc(1);
          try { fs.readSync(input, last, 0, 1, stream.size - 1); if (last[0] !== 10) skipLeading.add(stream.id); }
          finally { fs.closeSync(input); }
        }
        this.active.set(session.id, { session, subscription, fd, bytes: 0, skipLeading, positions: new Map(initial.streams.map(s => [s.id, s.size])) });
        return structuredClone(session);
      } catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Subscription cleanup still runs after a file error. */ } }
        if (session) {
          session.state = "failed"; session.availability = "unavailable"; session.endedAt = this.now();
          session.error = error instanceof Error ? error.message : "capture_start_failed";
          this.failed.set(session.id, session);
          try { this.save(session); } catch { /* The in-memory terminal state remains authoritative until disk recovers. */ }
        }
        await subscription.release(); throw error;
      }
    });
  }
  private async collect(active: Active, checkpoint?: CaptureCheckpoint) {
    const point = checkpoint ?? await active.subscription.checkpoint();
    if (!point.running && active.session.state === "recording") throw new Error("capture_source_stopped");
    active.session.limitations = [...new Set([...active.session.limitations, ...point.limitations])];
    const start = Date.parse(active.session.startedAt), end = Date.parse(active.session.endedAt ?? this.now());
    if (end < start) throw new Error("capture_clock_changed");
    for (const stream of point.streams) {
      let position = active.positions.get(stream.id) ?? 0;
      if (stream.size < position || stream.size - position > maxBytes) throw new Error("capture_source_range_invalid");
      if (stream.size === position) continue;
      const stat = fs.lstatSync(stream.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("capture_source_invalid");
      const bytes = Buffer.alloc(stream.size - position), fd = fs.openSync(stream.file, "r");
      try {
        let read = 0;
        while (read < bytes.length) { const n = fs.readSync(fd, bytes, read, bytes.length - read, position + read); if (!n) throw new Error("capture_source_truncated"); read += n; }
      } finally { fs.closeSync(fd); }
      let input = bytes;
      if (active.skipLeading.has(stream.id)) {
        const newline = input.indexOf(10);
        if (newline < 0) { active.positions.set(stream.id, stream.size); continue; }
        position += newline + 1; input = input.subarray(newline + 1); active.skipLeading.delete(stream.id);
      }
      const complete = input.lastIndexOf(10) + 1;
      for (const line of input.subarray(0, complete).toString("utf8").split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.recordType !== "human_event" || typeof event.eventType !== "string" || controls.test(event.eventType)) continue;
        const at = Date.parse(event.timestamp);
        if (!Number.isFinite(at)) throw new Error("capture_event_timestamp_invalid");
        if (at < start || at > end) continue;
        const envelope = { index: active.session.eventCount, source: { stream: stream.id, sequence: event.sequence }, event };
        const output = Buffer.from(JSON.stringify(envelope) + "\n");
        if (active.bytes + output.length > maxBytes || active.session.eventCount >= 100_000) throw new Error("capture_evidence_limit_reached");
        let written = 0;
        while (written < output.length) {
          const count = fs.writeSync(active.fd, output, written, output.length - written);
          if (!count) throw new Error("capture_evidence_write_failed"); written += count;
        }
        active.bytes += output.length; active.session.eventCount++;
        active.session.eventTypes[event.eventType] = (active.session.eventTypes[event.eventType] ?? 0) + 1;
        const app = event.application?.name ?? event.application?.bundleId ?? event.application?.executable;
        if (typeof app === "string" && !active.session.applications.includes(app)) active.session.applications.push(app);
      }
      const range = active.session.ranges.find(r => r.stream === stream.id);
      if (range) range.endByte = position + complete;
      else active.session.ranges.push({ stream: stream.id, startByte: position, endByte: position + complete });
      position += complete; active.positions.set(stream.id, position);
      if (active.session.endedAt && complete !== input.length) {
        active.session.availability = "partial"; active.session.limitations.push("An incomplete trailing source record was excluded.");
      }
    }
    this.save(active.session);
  }
  stop(owner: string, conversationId: string, id: string, cancel = false) {
    return this.serial(async () => {
      const saved = this.authorized(owner, conversationId, id), active = this.active.get(id);
      if (!active) return saved;
      active.session.endedAt = this.now(); active.session.state = "finalizing"; this.save(active.session);
      try {
        const point = await active.subscription.checkpoint();
        if (point.complete !== true) {
          active.session.availability = "partial";
          if (!active.session.limitations.includes("Native-to-disk completion was not confirmed.")) active.session.limitations.push("Native-to-disk completion was not confirmed.");
        }
        if (!point.running) throw new Error("capture_source_stopped");
        await this.collect(active, point);
        fs.fsyncSync(active.fd); fs.closeSync(active.fd); active.fd = -1;
        active.session.eventsSha256 = this.evidenceHash(active.session);
        active.session.state = cancel ? "cancelled" : "ready";
        if (active.session.availability !== "partial") active.session.availability = active.session.eventCount ? "available" : "empty";
        this.save(active.session); return structuredClone(active.session);
      } catch (error) { await this.fail(active, error); return this.read(owner, id); }
      finally { if (this.active.delete(id)) await active.subscription.release(); }
    });
  }
  private evidenceHash(session: EventCaptureSession) {
    const file = path.join(this.folder(session.pluginId, session.id), "events.jsonl"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("capture_evidence_invalid");
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  readEvents(owner: string, conversationId: string, id: string, offset = 0, limit = 100) {
    const session = this.authorized(owner, conversationId, id);
    if (session.state !== "ready" || !session.eventsSha256 || session.availability === "empty") throw new Error("capture_ready_events_required");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("capture_invalid_cursor");
    if (this.evidenceHash(session) !== session.eventsSha256) throw new Error("capture_evidence_hash_mismatch");
    const records = fs.readFileSync(path.join(this.folder(owner, id), "events.jsonl"), "utf8").trim().split("\n");
    const events: unknown[] = []; let bytes = 0;
    for (const line of records.slice(offset, offset + limit)) {
      if (bytes + Buffer.byteLength(line) > 2_000_000 && events.length) break;
      if (Buffer.byteLength(line) > 2_000_000) throw new Error("capture_event_too_large_for_context");
      events.push(JSON.parse(line)); bytes += Buffer.byteLength(line);
    }
    const nextOffset = offset + events.length < records.length ? offset + events.length : null;
    return { session, events, nextOffset };
  }
  async invoke(owner: string, conversationId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (input.action === "start") return this.start(owner, conversationId, String(input.goal ?? ""), input.consent === true);
    if (input.action === "status" || input.action === "list") return { sessions: this.list(owner, conversationId) };
    if (typeof input.session_id !== "string") throw new Error("capture_session_id_required");
    if (input.action === "stop" || input.action === "cancel") return this.stop(owner, conversationId, input.session_id, input.action === "cancel");
    if (input.action === "read") return this.readEvents(owner, conversationId, input.session_id, Number(input.offset ?? 0), Number(input.limit ?? 100));
    throw new Error("capture_unknown_action");
  }
  private async fail(active: Active, error: unknown) {
    active.session.state = "failed"; active.session.availability = "partial"; active.session.endedAt ??= this.now();
    active.session.error = error instanceof Error ? error.message : "capture_failed";
    this.failed.set(active.session.id, structuredClone(active.session));
    this.active.delete(active.session.id);
    try {
      if (active.fd >= 0) { try { fs.fsyncSync(active.fd); } finally { fs.closeSync(active.fd); active.fd = -1; } }
      this.save(active.session);
    } finally { await active.subscription.release(); }
  }
  release(owner: string) { return this.serial(async () => {
    const results = await Promise.allSettled([...this.active.values()].filter(active => active.session.pluginId === owner)
      .map(active => this.fail(active, new Error("capture_plugin_stopped"))));
    const error = results.find((result): result is PromiseRejectedResult => result.status === "rejected"); if (error) throw error.reason;
  }); }
  async close() { this.closing = true; clearInterval(this.timer); await this.serial(async () => {
    await Promise.allSettled([...this.active.values()].map(active => this.fail(active, new Error("capture_host_stopped"))));
  }); }
}
