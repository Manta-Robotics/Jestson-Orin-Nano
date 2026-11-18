// One owner for the policy, its swimmer tracker and both hardware outputs.
const monoMs = () => Number(process.hrtime.bigint()) / 1e6;
const DECISION_MAX_AGE_MS = 1000;

export function selectedSwimmer(result) {
  if (result?.state !== 'detected' || !Array.isArray(result.targets)) return null;
  const target = result.selected_id != null
    ? result.targets.find(item => item.id === result.selected_id)
    : result.targets[result.selected_index ?? -1];
  if (!target || ![target.x,target.y,target.w,target.h,target.confidence].every(Number.isFinite)
    || target.x < 0 || target.y < 0 || target.w <= 0 || target.h <= 0
    || target.x + target.w > 1.000001 || target.y + target.h > 1.000001
    || target.confidence < 0 || target.confidence > 1) return null;
  return { x1: target.x, y1: target.y, x2: Math.min(1,target.x+target.w),
    y2: Math.min(1,target.y+target.h), confidence: target.confidence };
}

export class CinematographySession {
  constructor(board) {
    this.board = board;
    this.phase = 'idle';
    this.visual = true;
    this.generation = 0;
    this.lastReason = null;
    this.targetState = 'idle';
    this.clock = board.clock || monoMs;
  }
  get active() { return this.phase === 'starting' || this.phase === 'running'; }
  state() {
    const blocker = this.active ? null : this.board.blocker();
    return {available:true, state:this.phase, mode:this.active?'ppo':null, modes:['ppo'],
      p_enabled:this.visual, can_set_p:this.phase !== 'starting',
      target_state:this.targetState, intent_mode:this.decision?.mode.toUpperCase() ?? null,
      executed_mode:this.execution?.executedMode?.toUpperCase() ?? null,
      uwb_distance_m:this.execution?.distanceM ?? null, gimbal_source:this.active ? this.gimbalSource : null,
      policy_version:this.version || null, reason: this.lastReason || blocker,
      can_start:!this.active && !blocker, can_stop:this.active};
  }
  start() {
    const reason = this.board.blocker();
    if (this.active || reason) throw new Error(reason || '运镜已经启动');
    this.phase = 'starting';
    this.lastReason = null;
    this.acquiredCamera = false;
    this.version = null;
    this.clearObservation();
    const generation = ++this.generation;
    try {
      this.board.neutral('cinema_start');
      this.policy = this.board.openPolicy({
        ready: version => {
          if (generation !== this.generation) return;
          this.version = version;
          this.ready = true;
        },
        sample: sample => this.receive(sample, generation),
        error: message => { if (generation === this.generation) this.stop(message); }
      });
      this.acquiredCamera = true;
      this.board.camera(this.visual);
      this.timer = setInterval(() => this.tick(), 50);
      this.timer.unref?.();
      this.board.event('start', {visual:this.visual});
    } catch (error) {
      this.stop(error.message);
      throw error;
    }
  }
  clearObservation() {
    this.history = new Map();
    this.latest = null;
    this.lastExecution = null;
    this.gimbalSource = null;
    this.pending = null;
    this.inflight = false;
    this.decision = null;
    this.execution = null;
    this.decisionTime = -Infinity;
    this.lastFrame = -1;
    this.epoch = null;
    this.nextFrameAt = 0;
    this.startedAt = this.clock();
    this.lastDriveTick = null;
    this.targetState = this.visual ? 'searching' : 'uwb';
    this.board.reset();
  }
  stop(reason = null) {
    if (!this.active) return;
    ++this.generation;
    this.phase = reason ? 'fault' : 'idle';
    this.lastReason = reason;
    clearInterval(this.timer);
    this.ready = false;
    this.policy?.close();
    this.policy = null;
    this.board.neutral(reason || 'cinema_stop');
    if (this.acquiredCamera) this.board.releaseCamera();
    this.acquiredCamera = false;
    this.clearObservation();
    this.targetState = 'idle';
    this.board.event('stop', {reason});
  }
  setVision(enabled) {
    if (this.phase === 'starting') throw new Error('运镜正在启动');
    if (this.visual === enabled) return;
    this.visual = enabled;
    if (this.active) {
      // Invalidate both the pending image and the previous recurrent context.
      this.stop();
      this.start();
    }
    this.board.event('vision', {visual:enabled});
  }
  vision(result) {
    if (!this.active || !this.visual || result?.detector !== 'swimmer'
        || !result.frame_id || !['detected','predicted','no_target'].includes(result.state)) return;
    const target = selectedSwimmer(result);
    this.latest = {id:result.frame_id, target, state:target?'detected':result.state==='predicted'?'coasting':'uwb'};
  }
  async pollFrame(generation) {
    const selection = this.visual ? this.latest : null;
    if (this.visual && !selection) return;
    this.inflight = true;
    try {
      const frame = await this.board.frame(selection?.id);
      if (generation !== this.generation || !frame) return;
      const now = this.clock();
      if (this.epoch && frame.epoch !== this.epoch) throw new Error('画面已重新连接，请重新启动运镜');
      if (frame.sequence <= this.lastFrame || now - frame.timeMs > DECISION_MAX_AGE_MS
        || frame.timeMs > now || (selection && selection.id !== frame.id)) return;
      this.epoch = frame.epoch;
      this.lastFrame = frame.sequence;
      this.pending = {id:frame.id, timeMs:frame.timeMs, sequence:frame.sequence, targetState:selection?.state || 'uwb'};
      this.history.set(frame.sequence, this.pending);
      if (this.history.size > 8) this.history.delete(this.history.keys().next().value);
      this.policy.send({type:'frame',frameId:frame.sequence,timeMs:frame.timeMs,jpeg:frame.jpeg,
        visualEnabled:this.visual,target:selection?.target || null});
    } catch (error) {
      if (generation === this.generation) this.stop(error.message);
    } finally {
      if (generation === this.generation) this.inflight = false;
    }
  }
  receive(sample, generation) {
    const request = this.pending;
    if (generation !== this.generation || !request || sample.frameId !== request.sequence || sample.timeMs !== request.timeMs) return;
    this.pending = null;
    if (this.clock() - request.timeMs > DECISION_MAX_AGE_MS) return;
    this.targetState = request.targetState;
    if (!sample.decision) return;
    const observation = this.history.get(sample.decision.observationFrameId);
    if (!observation || observation.timeMs !== sample.decision.observationTimeMs ||
        observation.timeMs <= this.decisionTime || observation.timeMs > request.timeMs ||
        this.clock() - observation.timeMs > DECISION_MAX_AGE_MS) return;
    this.decision = sample.decision;
    this.decisionFrameId = observation.id;
    this.decisionTime = observation.timeMs;
    this.phase = 'running';
    this.board.event('decision', {frame_id:observation.id,decision:sample.decision,visual:this.visual,target:observation.targetState,version:this.version});
  }
  tick() {
    if (!this.active) return;
    try {
      const now = this.clock();
      const blocker = this.board.blocker(true);
      if (blocker) return this.stop(blocker);
      if (this.phase === 'starting' && now - this.startedAt > 45000) return this.stop('策略或带时间戳的相机画面未就绪');
      if (this.phase === 'running' && now - this.decisionTime > DECISION_MAX_AGE_MS) return this.stop('策略或画面超时');
      if (this.ready && !this.pending && !this.inflight && now >= this.nextFrameAt) {
        this.nextFrameAt = now + 190;
        void this.pollFrame(this.generation);
      }
      if (this.decision) {
        if (this.lastDriveTick !== null && now-this.lastDriveTick > this.board.leaseMs)
          return this.stop('船体控制指令续期超时');
        this.lastDriveTick = now;
        this.execution = this.board.execute(this.decision, now - this.decisionTime);
        if (!this.execution.safe) return this.stop(this.execution.reason);
        if (this.lastExecution?.frame !== this.decisionFrameId || this.lastExecution?.reason !== this.execution.reason) {
          this.lastExecution = {frame:this.decisionFrameId,reason:this.execution.reason};
          this.board.event('execution', {frame_id:this.decisionFrameId, intent_id:this.decision.intentId,
            requested_mode:this.decision.mode, executed_mode:this.execution.executedMode,
            reason:this.execution.reason, uwb_distance_m:this.execution.distanceM,
            reference_offset_ne:this.execution.referenceOffsetNE, actual_offset_ne:this.execution.actualOffsetNE,
            throttle_percent:this.execution.throttlePercent, steering_deg:this.execution.steeringDegrees});
        }
      }
    } catch (error) { this.stop(error.message); }
  }
}
