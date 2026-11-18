import assert from 'node:assert/strict';
import test from 'node:test';
import { canRequestCinematography, cinematographyTargetLabel, normalizeCinematography } from '../frontend/js/cinematography-panel.js';

const control = { mode: 'live', connected: true, canControl: true };

test('unavailable strategy and foreign schema leave every action disabled', () => {
  for (const data of [null, { schema_version: 2, available: true, can_start: true },
    { schema_version: 1, available: false, can_start: true, can_stop: true }]) {
    const state = normalizeCinematography(data);
    assert.equal(state.available, false);
    assert.equal(state.mode, null);
    assert.equal(canRequestCinematography(state, control, 'start'), false);
    assert.equal(canRequestCinematography(state, control, 'stop'), false);
  }
});

test('future strategy enables only the advertised action for the live owner', () => {
  const state = normalizeCinematography({ schema_version: 1, available: true, state: 'idle', modes: ['follow', 'orbit', 'follow', null], can_start: true, can_stop: false });
  assert.deepEqual(state.modes, ['follow', 'orbit']);
  assert.equal(canRequestCinematography(state, control, 'start'), true);
  assert.equal(canRequestCinematography(state, control, 'stop'), false);
  for (const viewer of [{ ...control, canControl: false }, { ...control, mode: 'mock' }, { ...control, connected: false }]) {
    assert.equal(canRequestCinematography(state, viewer, 'start'), false);
  }
});

test('vision switch follows the reported setting and the current live owner', () => {
  const input = { schema_version: 1, available: true, state: 'running', can_set_p: true };
  for (const value of [true, false]) {
    const state = normalizeCinematography({ ...input, p_enabled: value, target_state: value ? 'coasting' : 'uwb', intent_mode: 'WORLD_HOLD', uwb_distance_m: 4.7 });
    assert.equal(state.p_enabled, value);
    assert.equal(state.target_state, value ? 'coasting' : 'uwb');
    assert.equal(state.intent_mode, 'WORLD_HOLD');
    assert.equal(state.uwb_distance_m, 4.7);
    assert.equal(canRequestCinematography(state, control, 'vision'), true);
    for (const viewer of [{ ...control, canControl: false }, { ...control, connected: false }, { ...control, mode: 'mock' }]) {
      assert.equal(canRequestCinematography(state, viewer, 'vision'), false);
    }
  }
  const state = normalizeCinematography({ ...input, p_enabled: 'yes', uwb_distance_m: -4, target_state: 'unrecognized' });
  assert.equal(state.uwb_distance_m, null);
  assert.equal(state.target_state, null);
  assert.equal(canRequestCinematography(state, control, 'vision'), false);
});

test('predictions and a rejected swimmer bearing display the actual gimbal fallback', () => {
  const data = { schema_version: 1, available: true, p_enabled: true };
  const label = (target_state, gimbal_source) => cinematographyTargetLabel(normalizeCinematography({ ...data, target_state, gimbal_source }));
  assert.equal(label('detected', 'yolo'), '已检测到一名泳者');
  assert.equal(label('detected', 'uwb'), '已检测到一名泳者，云台使用 UWB');
  assert.equal(label('coasting', 'uwb'), '视觉预测中，云台使用 UWB');
  assert.equal(label('uwb', 'uwb'), '使用 UWB 信标');
});
