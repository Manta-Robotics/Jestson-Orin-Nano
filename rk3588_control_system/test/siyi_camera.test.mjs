import test from 'node:test';
import assert from 'node:assert/strict';
import { SiyiCamera, encodeCameraEncoding, decodeCameraEncoding } from '../backend/siyi_camera.js';

function fixture() {
  let recording = false, card = true, toggles = 0, lostAck = false;
  let encoding = { stream: 1, codec: 1, width: 1280, height: 720, bitrateKbps: 2500, fps: 25 };
  const camera = new SiyiCamera({ timeoutMs: 20, send(command, payload) {
    if (command === 0x0c) { recording = !recording; toggles++; return; }
    let response;
    if (command === 0x0a) response = Buffer.from([0, 0, 0, card ? Number(recording) : 2]);
    if (command === 0x20) { response = encodeCameraEncoding(encoding); response[8] = encoding.fps; }
    if (command === 0x21) { const fps = encoding.fps; encoding = { ...decodeCameraEncoding(payload), fps }; if (lostAck) return; response = Buffer.from([payload[0], 1]); }
    queueMicrotask(() => camera.receive({ command, payload: response, control: 2 }));
  } });
  return { camera, setCard(value) { card = value; }, setLostAck() { lostAck = true; }, get toggles() { return toggles; } };
}

test('SDK SET reserves byte 8; live 4K and unsupported parameters are rejected', () => {
  const p = encodeCameraEncoding({ stream: 1, codec: 1, width: 1920, height: 1080, bitrateKbps: 4000 });
  assert.equal(p[8], 0); assert.equal(p.readUInt16LE(6), 4000);
  assert.throws(() => encodeCameraEncoding({ stream: 1, codec: 1, width: 3840, height: 2160, bitrateKbps: 20000 }));
});

test('repeated or concurrent desired-state commands never invert a TF recording', async () => {
  const f = fixture();
  await Promise.all([f.camera.setRecording(true), f.camera.setRecording(true)]);
  assert.equal(f.toggles, 1); assert.equal(f.camera.status.recording, true);
  await Promise.all([f.camera.setRecording(false), f.camera.setRecording(false)]);
  assert.equal(f.toggles, 2); assert.equal(f.camera.status.recording, false);
});

test('missing TF card is visible and sends no toggle', async () => {
  const f = fixture(); f.setCard(false);
  await assert.rejects(f.camera.setRecording(true), /missing/);
  assert.equal(f.toggles, 0); assert.equal(f.camera.status.phase, 'unavailable');
});

test('encoding mutation with a lost ACK is confirmed through readback', async () => {
  const f = fixture(); f.setLostAck();
  const result = await f.camera.configureEncoding({ stream: 1, codec: 1, width: 1920, height: 1080, bitrateKbps: 4000 });
  assert.equal(result.after.width, 1920); assert.equal(result.after.fps, 25);
});

test('dropped read replies are retried without sending a recording toggle', async () => {
  let reads = 0;
  const camera = new SiyiCamera({ timeoutMs: 10, send(command) {
    assert.equal(command, 0x20); reads++;
    if (reads < 3) return;
    const payload = encodeCameraEncoding({ stream: 1, codec: 1, width: 1920, height: 1080, bitrateKbps: 4000 });
    payload[8] = 25;
    queueMicrotask(() => camera.receive({ command, control: 2, payload }));
  } });
  assert.equal((await camera.getEncoding(1)).width, 1920);
  assert.equal(reads, 3);
});
