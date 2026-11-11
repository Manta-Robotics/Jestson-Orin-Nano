import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('reconnect restores recovery intent, stop failure preserves it, stale states cannot overwrite a restarted server', async () => {
  const html = fs.readFileSync(new URL('../frontend/mobile-preview-kimi-k26.html', import.meta.url), 'utf8');
  const elements = new Map(); let resolve, reject;
  const box = { state: { transportMode: 'live' }, recordingInstance: null, recordingRevision: -1,
    recordingPastInstances: [], recordingLastError: null, recordingBusy: false, recordTimerHandle: null,
    localize: x => x, showToast() {}, loadLiveRecordings() {}, renderRecordTimer() {}, clearInterval() {}, setInterval: () => 1,
    ensureTransport: () => ({ gimbal: () => new Promise((yes, no) => { resolve = yes; reject = no; }) }),
    $: key => { if (!elements.has(key)) elements.set(key, { dataset: {}, classList: { toggle() {} } }); return elements.get(key); } };
  const end = html.includes('function shutdownBoard(') ? html.indexOf('function shutdownBoard(') : html.indexOf('function renderRecordTimer(');
  vm.createContext(box); vm.runInContext(html.slice(html.indexOf('function applyRecordingState('), end), box);
  box.applyRecordingState({ instanceId: 'first', revision: 5, desired: true, active: false, phase: 'recovering', current: { elapsedMs: 60000 } });
  assert.equal(box.state.recordingRequested, true); assert.equal(box.state.recording, false);
  box.stopRecording(false); assert.equal(box.state.recordingRequested, true);
  const stopped = box.setRecording(false); reject(new Error('network lost')); await stopped;
  assert.equal(box.state.recordingRequested, true);
  box.applyRecordingState({ instanceId: 'second', revision: 0, desired: false, phase: 'stopped' });
  box.applyRecordingState({ instanceId: 'first', revision: 100, desired: true, phase: 'recording', active: true });
  assert.equal(box.state.recordingRequested, false);
  box.applyRecordingState({ instanceId: 'second', revision: 1, desired: false, active: false, phase: 'stopped', camera: { enabled: true, recording: true, phase: 'unavailable', error: 'Stop not confirmed' } });
  assert.equal(box.state.recordingAny, true, 'TF recording must remain visible after the local file stops');
});

test('an owner can stop recording when Pixhawk and gimbal feedback are offline', () => {
  const source = fs.readFileSync(new URL('../frontend/mobile-preview-kimi-k26.html', import.meta.url), 'utf8');
  const start = source.indexOf('function recordingControlAvailable('), end = source.indexOf('function applyRecordingState(', start);
  let owned = true;
  const box = { state: { connected: true, boardOnline: true, pixhawkOnline: false, gimbalOutputAvailable: false, gimbalFault: true },
    transport: {}, pageCanControl: () => owned };
  vm.createContext(box); vm.runInContext(source.slice(start, end), box);
  assert.equal(box.recordingControlAvailable(), true);
  owned = false; assert.equal(box.recordingControlAvailable(), false);
  owned = true; box.state.boardOnline = false; assert.equal(box.recordingControlAvailable(), false);
});

test('the recording button bypasses a lost gimbal link while still enforcing ownership', () => {
  const source = fs.readFileSync(new URL('../frontend/mobile-preview-kimi-k26.html', import.meta.url), 'utf8');
  const start = source.indexOf('  $$("[data-gimbal-action]").forEach('), end = source.indexOf('  $("#openReport")', start);
  let click, owned = true;
  const commands = [];
  const box = { state: { recordingAny: true }, recordingControlAvailable: () => owned,
    gimbalControlAvailable: () => false, setRecording: value => commands.push(value), showToast() {},
    $$: () => [{ dataset: { gimbalAction: 'record' }, addEventListener: (_, fn) => { click = fn; } }] };
  vm.createContext(box); vm.runInContext(source.slice(start, end), box);
  click(); assert.deepEqual(commands, [false]);
  owned = false; click(); assert.deepEqual(commands, [false]);
});

test('a delayed TF encoding query cannot restart TF recording after a manual stop', async () => {
  const source = fs.readFileSync(new URL('../backend/server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function synchronizeTfRecording('), end = source.indexOf('const tfSyncTimer', start);
  let finishQuery, desired = true;
  const commands = [];
  const box = { tfSyncBusy: false, recordingConfig: { tf_sync_enabled: true },
    gimbalRecorder: { state: () => ({ desired }) },
    cameraRecorder: { status: {}, getEncoding: () => new Promise(resolve => { finishQuery = resolve; }),
      setRecording: async value => { commands.push(value); } },
    addLog() {}, io: { emit() {} }, buildRecordingState: () => ({}) };
  vm.createContext(box); vm.runInContext(source.slice(start, end), box);
  const starting = box.synchronizeTfRecording(true);
  desired = false; await box.cameraRecorder.setRecording(false);
  finishQuery({ codec: 2, width: 3840, height: 2160, bitrateKbps: 20000 }); await starting;
  assert.ok(commands.length >= 1);
  assert.ok(commands.every(value => value === false));
});
