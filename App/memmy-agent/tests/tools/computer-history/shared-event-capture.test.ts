import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../src/tools/computer-history/mac/computer-history-api.js";
import { collectorGate } from "../../../src/tools/computer-history/core/collector-gate.js";

const roots: string[] = [], services: ComputerHistoryDemoService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.shutdown())); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function fixture(authorized = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-history-capture-")); roots.push(root);
  const recorderScript = path.join(root, "recorder.cjs");
  fs.writeFileSync(recorderScript, `
const fs = require('node:fs'), readline = require('node:readline');
const file = process.argv[process.argv.indexOf('--out') + 1];
fs.appendFileSync(file, JSON.stringify({ recordType:'human_event', eventType:'recording_started', timestamp:new Date().toISOString() })+'\\n');
const mark = code => console.log('[recorder-health] '+JSON.stringify({code,timestamp:new Date().toISOString()}));
mark('observer_ready'); mark('heartbeat');
readline.createInterface({input:process.stdin}).on('line', line => {
 const input=JSON.parse(line); if(input.kind !== 'checkpoint') return;
 setTimeout(() => {
  fs.appendFileSync(file, JSON.stringify({recordType:'human_event', eventType:'text_input', timestamp:new Date().toISOString(), details:{text:'controlled fixture'}})+'\\n');
  const fd=fs.openSync(file,'r+'); fs.fsyncSync(fd); fs.closeSync(fd);
  console.log('[recorder-checkpoint] '+JSON.stringify({id:input.id,complete:true}));
 },10);
});
process.on('SIGTERM',()=>process.exit(0));
`);
  const service = new ComputerHistoryDemoService({ recorderScript, permissionReader: async () => ({ supported: true, accessibility: authorized, inputMonitoring: authorized }),
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"), weChatConsentFile: path.join(root, "consent.json") });
  // Windows has no TCC prompt; simulate a denied Host preflight result directly.
  if (!authorized) vi.spyOn(service, "checkPermissions").mockResolvedValue({ supported: true, accessibility: false, inputMonitoring: false });
  services.push(service);
  const child = () => (service as unknown as { segment: { child: { pid: number } } }).segment?.child;
  return { service, root, pid: () => child()?.pid };
}
describe("Computer History capture subscriptions", () => {
  it("shares one actual collector and waits for its persisted checkpoint without stopping background History", async () => {
    const f = fixture(); await f.service.startObservationWithPermissions();
    const firstPid = f.pid(), a = await f.service.acquireEventCapture(), b = await f.service.acquireEventCapture();
    const point = await a.checkpoint(); expect(point).toMatchObject({ running: true, complete: true });
    expect(fs.readFileSync(point.streams.at(-1)!.file, "utf8")).toContain("controlled fixture");
    expect(f.pid()).toBe(firstPid); expect(() => collectorGate.acquire("task")).toThrow("collector_busy");
    await a.release(); await b.release();
    expect(f.service.snapshot().observation.state).toBe("running"); expect(f.pid()).toBe(firstPid);
    await f.service.stopObservation(); expect(collectorGate.busy).toBe(false);
  });
  it("temporarily starts an off History and restores the persisted background intent after its last subscriber", async () => {
    const f = fixture(), a = await f.service.acquireEventCapture(), b = await f.service.acquireEventCapture();
    expect(f.service.snapshot().observation.state).toBe("stopped");
    expect(JSON.parse(fs.readFileSync(path.join(f.root, "histories/recording-intent.json"), "utf8")).state).toBe("stopped");
    await a.release(); expect((await b.checkpoint()).running).toBe(true);
    await b.release(); expect(f.service.recorderBusy).toBe(false); expect(collectorGate.busy).toBe(false);
    await b.release();
  });
  it("preserves later History start/pause/stop choices while subscriptions retain the same collector", async () => {
    const f = fixture(), a = await f.service.acquireEventCapture();
    const pid = f.pid(); f.service.startObservation(); await a.release();
    expect(f.service.snapshot().observation.state).toBe("running");
    const b = await f.service.acquireEventCapture(); await f.service.pauseObservation();
    expect(f.service.snapshot().observation.state).toBe("paused"); expect((await b.checkpoint()).running).toBe(true);
    expect(f.pid()).toBe(pid); await b.release(); expect(collectorGate.busy).toBe(false);
    const c = await f.service.acquireEventCapture(); await f.service.stopObservation(); await c.release();
    expect(f.service.snapshot().observation.state).toBe("stopped"); expect(collectorGate.busy).toBe(false);
  });
  it("does not launch or acquire resources when permission is denied or another recorder owns the collector", async () => {
    const f = fixture(false); await expect(f.service.acquireEventCapture()).rejects.toThrow("permission_required");
    expect(f.pid()).toBeUndefined(); expect(collectorGate.busy).toBe(false);
    const release = collectorGate.acquire("task");
    try { await expect(f.service.acquireEventCapture()).rejects.toThrow("collector_busy"); }
    finally { release(); }
  });
});
