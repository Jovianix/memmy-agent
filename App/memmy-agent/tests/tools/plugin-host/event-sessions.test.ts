import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginEventSessions } from "../../../src/tools/plugin-host/event-sessions.js";
import type { CaptureCheckpoint, EventCaptureSource } from "../../../src/tools/computer-history/core/event-capture-source.js";

const roots: string[] = [], services: PluginEventSessions[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "event-fragment-")); roots.push(root);
  const stream = path.join(root, "source.jsonl"); fs.writeFileSync(stream, "");
  let time = Date.parse("2026-10-20T00:00:00Z"), running = true;
  const streams = [{ id: "first", file: stream }];
  const checkpoint = vi.fn(async (): Promise<CaptureCheckpoint> => ({ running, complete: true, limitations: ["Authorized UI events only"],
    streams: streams.map(source => ({ ...source, size: fs.statSync(source.file).size })) }));
  const release = vi.fn(async () => undefined), source: EventCaptureSource = { acquireEventCapture: vi.fn(async () => ({ checkpoint, release })) };
  const dataRoot = path.join(root, "data"), service = new PluginEventSessions({ dataRoot, source, now: () => time }); services.push(service);
  function event(value: string, at = time, file = stream) { fs.appendFileSync(file, JSON.stringify({ recordType: "human_event", sequence: 1,
    eventType: "text_changed", timestamp: new Date(at).toISOString(), application: { name: "Any authorized app" }, details: { value } }) + "\n"); }
  return { root, stream, streams, source, release, checkpoint, service, dataRoot, event,
    advance: (amount: number) => { time += amount; }, stopped: () => { running = false; } };
}
describe("conversation event fragments", () => {
  it("retains a transient incomplete boundary even when capture recovers before stop", async () => {
    const f = fixture(), original = f.checkpoint.getMockImplementation()!;
    f.checkpoint.mockImplementationOnce(async () => ({ ...await original(), complete: false, limitations: ["observer_unavailable"] }));
    const session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.advance(10); f.event("after recovery"); f.advance(10);
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ state: "ready", eventCount: 1, availability: "partial" });
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("marks an unconfirmed native boundary partial and keeps post-stop observations outside the fragment", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.advance(10); f.event("inside");
    const original = f.checkpoint.getMockImplementation()!;
    f.checkpoint.mockImplementation(async () => {
      f.advance(100); f.event("after stop request");
      return { ...await original(), complete: false };
    });
    const ended = await f.service.stop("test.capture", "chat-a", session.id);
    expect(ended).toMatchObject({ state: "ready", availability: "partial", eventCount: 1 });
    expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toHaveLength(1);
  });

  it("uses source positions to retain an event in the same timestamp tick as end", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.event("same tick");
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ state: "ready", eventCount: 1 });
    f.event("after confirmation");
    expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toHaveLength(1);
  });
  it("seals exact positions/time bounds across rotation and preserves a durable snapshot independently of History cleanup", async () => {
    const f = fixture(); f.event("before");
    const session = await f.service.start("test.capture", "chat-a", "Record a workflow", true);
    f.advance(100); f.event("inside");
    const second = path.join(f.root, "second.jsonl"); fs.writeFileSync(second, ""); f.streams.push({ id: "second", file: second });
    f.advance(100); f.event("rotated", undefined, second); f.event("future", Date.parse(session.startedAt) + 10_000, second);
    f.advance(100); const ended = await f.service.stop("test.capture", "chat-a", session.id);
    f.event("after"); fs.rmSync(f.stream); fs.rmSync(second);
    expect(ended).toMatchObject({ state: "ready", availability: "available", eventCount: 2, eventTypes: { text_changed: 2 } });
    expect(ended.ranges).toHaveLength(2); expect(ended.ranges[0]!.startByte).toBeGreaterThan(0);
    const page = f.service.readEvents("test.capture", "chat-a", session.id);
    expect(page.events.map((item: any) => item.event.details.value)).toEqual(["inside", "rotated"]);
    expect(f.release).toHaveBeenCalledOnce(); expect(ended.eventsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toEqual(ended);
  });
  it("requires explicit consent and serializes repeated start requests into one subscription", async () => {
    const f = fixture(); await expect(f.service.start("test.capture", "chat-a", "Goal", false)).rejects.toThrow("consent");
    const results = await Promise.all([f.service.start("test.capture", "chat-a", "Goal", true), f.service.start("test.capture", "chat-a", "Goal", true)]);
    expect(results[0]!.id).toBe(results[1]!.id); expect(f.source.acquireEventCapture).toHaveBeenCalledOnce();
    await f.service.release("test.capture"); expect(f.release).toHaveBeenCalledOnce();
    expect(f.service.list("test.capture", "chat-a")[0]).toMatchObject({ state: "failed", error: "capture_plugin_stopped" });
  });
  it("isolates conversations and refuses altered snapshots or cancelled fragments", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.advance(1); f.event("captured"); f.advance(1); await f.service.stop("test.capture", "chat-a", session.id);
    expect(f.service.list("test.capture", "chat-b")).toEqual([]);
    expect(() => f.service.readEvents("test.capture", "chat-b", session.id)).toThrow("conversation");
    const evidence = path.join(f.dataRoot, "test.capture", "event-sessions", session.id, "events.jsonl"); fs.appendFileSync(evidence, "tampered\n");
    expect(() => f.service.readEvents("test.capture", "chat-a", session.id)).toThrow("hash_mismatch");
    const cancelled = await f.service.start("test.capture", "chat-a", "Other goal", true); f.advance(1);
    expect(await f.service.stop("test.capture", "chat-a", cancelled.id, true)).toMatchObject({ state: "cancelled" });
    expect(() => f.service.readEvents("test.capture", "chat-a", cancelled.id)).toThrow("ready_events_required");
  });
  it("retains incomplete records as an explicit partial result without admitting their payload", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.advance(1); f.event("complete"); fs.appendFileSync(f.stream, '{"recordType":"human_event",'); f.advance(1);
    const ended = await f.service.stop("test.capture", "chat-a", session.id);
    expect(ended).toMatchObject({ state: "ready", availability: "partial", eventCount: 1 });
    expect(ended.limitations.join(" ")).toContain("incomplete trailing");
  });

  it("excludes an in-progress source record that began before the start boundary", async () => {
    const f = fixture(); fs.appendFileSync(f.stream, '{"recordType":"human_event",');
    const session = await f.service.start("test.capture", "chat-a", "Goal", true);
    fs.appendFileSync(f.stream, '"eventType":"text_changed","timestamp":"2026-10-20T00:00:00.001Z"}\n');
    f.advance(2); f.event("inside"); f.advance(2);
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ state: "ready", eventCount: 1 });
    expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toMatchObject([{ event: { details: { value: "inside" } } }]);
  });
  it("never reports a stopped source as ready or resumes a recovered recording", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true); f.stopped();
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ state: "failed", error: "capture_source_stopped" });
    expect(f.release).toHaveBeenCalledOnce();
    const manifest = path.join(f.dataRoot, "test.capture", "event-sessions", session.id, "session.json");
    const interrupted = JSON.parse(fs.readFileSync(manifest, "utf8")); interrupted.state = "recording"; fs.writeFileSync(manifest, JSON.stringify(interrupted));
    const recovered = new PluginEventSessions({ dataRoot: f.dataRoot, source: f.source }); services.push(recovered);
    expect(recovered.list("test.capture", "chat-a")[0]).toMatchObject({ state: "failed", error: "capture_interrupted" });
    expect(f.source.acquireEventCapture).toHaveBeenCalledOnce();
  });
});
