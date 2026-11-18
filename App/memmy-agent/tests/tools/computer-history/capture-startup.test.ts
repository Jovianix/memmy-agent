import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ComputerHistoryDemoService } from "../../../src/tools/computer-history/mac/computer-history-api.js";
import { PluginEventSessions } from "../../../src/tools/plugin-host/event-sessions.js";

const granted = { supported: true, accessibility: true, inputMonitoring: true };
// All capture uses a controlled child process; these tests do not record the desktop.
const fixtures: Array<{ service: ComputerHistoryDemoService; events: PluginEventSessions; root: string }> = [];
function fixture(read: () => Promise<typeof granted>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-permission-case-'));
  const recorderScript = path.join(root, 'recorder.cjs');
  fs.writeFileSync(recorderScript, `
const fs = require('node:fs'), readline = require('node:readline');
const file = process.argv[process.argv.indexOf('--out') + 1];
fs.appendFileSync(require('node:path').join(__dirname, 'spawns.txt'), String(process.pid)+' ');
fs.appendFileSync(file, JSON.stringify({recordType:'human_event',eventType:'recording_started',timestamp:new Date().toISOString()})+'\\n');
console.log('[recorder-health] '+JSON.stringify({code:'observer_ready',timestamp:new Date().toISOString()}));
console.log('[recorder-health] '+JSON.stringify({code:'heartbeat',timestamp:new Date().toISOString()}));
readline.createInterface({input:process.stdin}).on('line', line => {
 const input=JSON.parse(line); if(input.kind !== 'checkpoint') return;
 console.log('[recorder-checkpoint] '+JSON.stringify({id:input.id,complete:true,rangeEvaluated:!!input.from}));
});
process.on('SIGTERM',()=>process.exit(0));
`);
  const service = new ComputerHistoryDemoService({ recorderScript, permissionReader: read,
    historyDirectory: path.join(root, 'histories'), recordingDirectory: path.join(root, 'recordings'),
    workflowDirectory: path.join(root, 'workflows'), observationSettingsFile: path.join(root, 'settings.json'),
    weChatConsentFile: path.join(root, 'consent.json') });
  const events = new PluginEventSessions({ dataRoot: path.join(root, 'plugin-data'), source: service });
  const value = { service, events, root }; fixtures.push(value); return { ...value, healthyScript: fs.readFileSync(recorderScript, "utf8") };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.events.close(); await f.service.shutdown(); fs.rmSync(f.root, {recursive:true, force:true}); }
});

const owner = 'teach-mode', chat = 'test-chat';
function startTeach(f: ReturnType<typeof fixture>) { return f.events.start(owner, chat, 'Test demonstration', true); }
function delayed() {
  let release!: (status: typeof granted) => void;
  const wait = new Promise<typeof granted>(resolve => { release = resolve; });
  const read = vi.fn(() => wait), f = fixture(read);
  return { ...f, read, release };
}
function checkSpawns(f: ReturnType<typeof fixture>, n: number) {
  const file = path.join(f.root, 'spawns.txt');
  const pids = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(' ') : [];
  expect(pids).toHaveLength(n);
}
it.each(['Teach', 'History'])('shares pending startup with %s first, keeping background History on after Teach stops', async (first) => {
  const f = delayed();
  let teaching: ReturnType<typeof startTeach>, background: ReturnType<typeof f.service.startObservationWithPermissions>;
  if (first === 'Teach') teaching = startTeach(f); else background = f.service.startObservationWithPermissions();
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
  if (first === 'Teach') background = f.service.startObservationWithPermissions(); else teaching = startTeach(f);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.events.list(owner,chat)[0].state).toBe('starting');
  f.release(granted);
  const [teach, history] = await Promise.all([teaching!, background!]);
  expect(teach).toMatchObject({state:'recording',error:null});
  expect(history.observation.state).toBe('running');
  expect(f.read).toHaveBeenCalledTimes(1); checkSpawns(f,1);
  await f.events.stop(owner,chat,teach.id);
  expect(f.service.snapshot().observation.state).toBe('running');
});
it.each(['stop','pause'])('preserves a pending History %s without interrupting Teach', async (action) => {
  const f = delayed(), background = f.service.startObservationWithPermissions(), teaching = startTeach(f);
  await vi.waitFor(() => expect(f.service.eventCaptureActive).toBe(true));
  if (action === 'stop') await f.service.stopObservation(); else await f.service.pauseObservation();
  f.release(granted); await background;
  const session = await teaching;
  expect(session.state).toBe('recording');
  await f.events.stop(owner,chat,session.id);
  expect(f.service.snapshot().observation.state).toBe(action === 'stop' ? 'stopped' : 'paused');
});
it.each(['accessibility','inputMonitoring'])('reports only actually missing %s and saves evidence', async key => {
  const status = {...granted, [key]:false}, f = fixture(async () => status);
  await expect(startTeach(f)).rejects.toMatchObject({code:'capture_permission_required',status:403});
  expect(f.events.list(owner,chat)[0]).toMatchObject({state:'failed',error:'capture_permission_required',failureStage:'permission-check',preflight:{platform:'macos',[key]:false}});
  checkSpawns(f,0);
});
it('preserves a failed permission probe and its stage', async () => {
  const f = fixture(async () => {throw new Error('permission helper timed out');});
  await expect(startTeach(f)).rejects.toMatchObject({message:'permission helper timed out',status:503});
  expect(f.events.list(owner,chat)[0]).toMatchObject({state:'failed',error:'permission helper timed out',failureStage:'permission-check'});
});
it('preserves a synchronous recorder launch failure and successful preflight', async () => {
  const f = fixture(async () => granted);
  fs.unlinkSync(path.join(f.root,'recorder.cjs'));
  await expect(startTeach(f)).rejects.toMatchObject({message:'recorder script is unavailable',status:503});
  expect(f.events.list(owner,chat)[0]).toMatchObject({state:'failed',error:'recorder script is unavailable',failureStage:'recorder-start',preflight:{accessibility:true,inputMonitoring:true}});
});
it.each([
  { diagnostic: "test helper connection failed", expected: "test helper connection failed", permission: false },
  { diagnostic: "human history recording failed: missing macOS permission: Input Monitoring.", expected: "capture_permission_required", permission: true },
])("preserves early recorder failure: $diagnostic", async ({ diagnostic, expected, permission }) => {
  const f = fixture(async () => granted);
  fs.writeFileSync(path.join(f.root, "recorder.cjs"), `process.stderr.write(${JSON.stringify(diagnostic + "\n")}, () => process.exit(23))`);
  await expect(startTeach(f)).rejects.toMatchObject({ code: expected, status: permission ? 403 : 503, stage: "recorder-start" });
  const saved = f.events.list(owner, chat)[0];
  const onDisk = JSON.parse(fs.readFileSync(path.join(f.root, "plugin-data", owner, "event-sessions", saved.id, "session.json"), "utf8"));
  expect(onDisk).toMatchObject({ state: "failed", error: expected, failureStage: "recorder-start",
    preflight: { platform: "macos", accessibility: true, inputMonitoring: !permission } });
});
it('returns cancelled when the user discards during preflight', async () => {
  const f = delayed(), start = startTeach(f);
  await vi.waitFor(() => expect(f.service.eventCaptureActive).toBe(true));
  const s = f.events.list(owner,chat)[0];
  expect((await f.events.stop(owner,chat,s.id,true)).state).toBe('cancelled');
  f.release(granted); expect((await start).state).toBe('cancelled'); checkSpawns(f,0);
  expect(f.service.snapshot().observation.state).toBe('stopped');
});
it('reports cancellation when shutdown invalidates pending startup', async () => {
  const f = delayed(), start = startTeach(f).catch(err=>err);
  await vi.waitFor(() => expect(f.service.eventCaptureActive).toBe(true));
  await f.service.shutdown(); f.release(granted);
  expect(await start).toMatchObject({message:'capture_start_cancelled',status:409});
  expect(f.events.list(owner,chat)[0].error).toBe('capture_start_cancelled'); checkSpawns(f,0);
});

it("preserves diagnostics arriving after process exit but before pipe close", async () => {
  const f = fixture(async () => granted);
  const diagnostic = "delayed helper connection failure";
  const writer = `setTimeout(() => process.stderr.write(${JSON.stringify(diagnostic)}, () => process.exit(0)), 100)`;
  fs.writeFileSync(path.join(f.root, "recorder.cjs"), `
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], { stdio: ["ignore", "ignore", 2] });
    process.exit(23);
  `);
  await expect(startTeach(f)).rejects.toMatchObject({ code: diagnostic, stage: "recorder-start" });
  expect(f.events.list(owner, chat)[0]).toMatchObject({ error: diagnostic, failureStage: "recorder-start" });
});

it("does not reuse an earlier permission failure when the user retries", async () => {
  const f = fixture(async () => granted);
  fs.writeFileSync(path.join(f.root, "recorder.cjs"), 'process.stderr.write("human history recording failed: missing macOS permission: Input Monitoring.\\n", () => process.exit(23))');
  await expect(startTeach(f)).rejects.toThrow();
  await vi.waitFor(() => expect(f.service.recorderBusy).toBe(false));
  fs.writeFileSync(path.join(f.root, "recorder.cjs"), f.healthyScript);
  const retried = await startTeach(f);
  expect(retried).toMatchObject({ state: "recording", error: null });
  expect(retried.failureStage).toBeUndefined();
  await f.events.stop(owner, chat, retried.id);
});

it("keeps cancellation authoritative while the first checkpoint is pending", async () => {
  const f = fixture(async () => granted);
  fs.writeFileSync(path.join(f.root, "recorder.cjs"), `
    require("node:fs").writeFileSync(require("node:path").join(__dirname, "waiting"), "yes");
    setInterval(() => {}, 1000);
  `);
  const starting = startTeach(f);
  await vi.waitFor(() => expect(fs.existsSync(path.join(f.root, "waiting"))).toBe(true));
  const session = f.events.list(owner, chat)[0];
  expect(await f.events.stop(owner, chat, session.id, true)).toMatchObject({ state: "cancelled" });
  expect(await starting).toMatchObject({ state: "cancelled", error: null });
  expect(f.service.recorderBusy).toBe(false);
});
