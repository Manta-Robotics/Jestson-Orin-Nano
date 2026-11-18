import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = process.env.ARMING_SOURCE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transportSource = fs.readFileSync(path.join(root, 'frontend/js/manta-app-transport.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');

function harness() {
  let now = 0, nextId = 0;
  const timers = new Map(), incoming = new EventEmitter(), outgoing = [];
  const socket = {
    connected: true,
    on: (...args) => incoming.on(...args), once: (...args) => incoming.once(...args),
    off: (...args) => incoming.off(...args), emit: (...args) => outgoing.push(args)
  };
  const box = {
    LiveTransport: function () {},
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.createContext(box);
  vm.runInContext(transportSource.slice(transportSource.indexOf('    function armingFailureMessage('),
    transportSource.indexOf('    LiveTransport.prototype.gimbal = function')), box);
  const transport = new box.LiveTransport();
  Object.assign(transport, { socket, canControl: true, on: () => () => {} });
  return {
    transport, incoming, outgoing, timers,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      now = end;
    },
    requestId() { return outgoing.filter(([name]) => name === 'arm').at(-1)[1].requestId; }
  };
}

test('a rejected ARM reports the gyro reason promptly and cleans up listeners', async () => {
  const h = harness();
  const result = assert.rejects(h.transport.arm(), /陀螺仪未校准.*Gyros not calibrated/);
  h.incoming.emit('arm_result', { action: 'arm', requestId: h.requestId(), result: 4,
    resultName: 'MAV_RESULT_FAILED', reason: 'Gyros not calibrated' });
  h.advance(151);
  await result;
  assert.equal(h.incoming.listenerCount('arm_result'), 0);
  assert.equal(h.timers.size, 0);
});

test('STATUSTEXT arriving just after the failed ACK supplies the specific reason', async () => {
  const h = harness();
  const result = assert.rejects(h.transport.arm(), /Gyros not calibrated/);
  const reply = { action: 'arm', requestId: h.requestId(), result: 4, resultName: 'MAV_RESULT_FAILED' };
  h.incoming.emit('arm_result', reply);
  h.advance(20);
  h.incoming.emit('arm_result', { ...reply, reason: 'Gyros not calibrated' });
  h.advance(151);
  await result;
});

test('ACK acceptance, another request and disarm feedback cannot claim successful arming', async () => {
  const h = harness();
  let settled = false;
  const result = h.transport.arm().then(() => { settled = true; });
  const requestId = h.requestId();
  h.incoming.emit('arm_result', { action: 'arm', requestId, result: 0 });
  h.incoming.emit('arm_result', { action: 'arm', requestId: 'older-request', result: 4 });
  h.incoming.emit('arm_result', { action: 'disarm', requestId, result: 4 });
  h.advance(200);
  await Promise.resolve();
  assert.equal(settled, false);
  h.incoming.emit('aircraft_armed');
  await result;
  assert.equal(h.timers.size, 0);
});

test('every repeated rejection completes its own request without waiting for timeout', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    const result = assert.rejects(h.transport.arm(), /MAV_RESULT_FAILED/);
    h.incoming.emit('arm_result', { action: 'arm', requestId: h.requestId(), result: 4, resultName: 'MAV_RESULT_FAILED' });
    h.advance(151);
    await result;
  }
  assert.equal(h.outgoing.length, 2);
});

test('a truly missing reply still reports a bounded confirmation timeout', async () => {
  const h = harness();
  const result = assert.rejects(h.transport.arm(), /时限内确认武装/);
  h.advance(8001);
  await result;
  assert.equal(h.timers.size, 0);
});

test('backend forwards structured failures independently of alert logs', () => {
  let receive;
  const events = [], commands = [];
  const box = {
    telemetrySocket: { on: (event, handler) => { receive = handler; } },
    io: { emit: (...args) => events.push(args) }, systemState: { telemetry: {} },
    addLog() { throw new Error('Results must not depend on a log event'); }
  };
  vm.createContext(box);
  const start = serverSource.indexOf("telemetrySocket.on('message'");
  vm.runInContext(serverSource.slice(start, serverSource.indexOf("telemetrySocket.on('error'", start)), box);
  const feedback = { action: 'arm', requestId: 'request', result: 4, reason: 'Gyros not calibrated' };
  receive(Buffer.from(JSON.stringify({ type: 'arm_ack', payload: feedback })));
  assert.equal(events[0][0], 'arm_result');
  assert.equal(events[0][1].requestId, 'request');
  assert.equal(box.systemState.telemetry.armCommand.reason, feedback.reason);
  receive(Buffer.from(JSON.stringify({ type: 'prearm_status', payload: { reason: feedback.reason } })));
  assert.equal(box.systemState.telemetry.preArm.reason, feedback.reason);
  assert.equal(commands.length, 0);
});

test('the manual ARM handler forwards the browser transaction ID to the bridge', () => {
  let arm;
  const sent = [];
  const box = {
    socket: { on: (name, handler) => { arm = handler; }, emit() {} },
    controlAccess: { authorizeSocket: () => true }, refreshHardwareState() {},
    systemState: { isConnected: true, telemetry: { armed: false } },
    uwbFollowState: { active: false, autoResumePending: false }, uwbFollowTransitionBusy: false,
    sendMavlinkCommand: (...args) => sent.push(args), addLog() {}
  };
  vm.createContext(box);
  const start = serverSource.indexOf("  socket.on('arm',");
  vm.runInContext(serverSource.slice(start, serverSource.indexOf("  socket.on('disarm'", start)), box);
  arm({ requestId: 'arm-browser-request' });
  assert.equal(sent[0][0], 'ARM');
  assert.equal(sent[0][1].requestId, 'arm-browser-request');
});
