// Official protocol: SIYI SDK V0.1.1, commands 0x0A, 0x0C, 0x20 and 0x21.
// Use the existing gimbal transport so camera requests cannot steal its feedback port.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function decodeCameraEncoding(payload) {
  if (payload.length < 9 || ![0, 1, 2].includes(payload[0]) || ![1, 2].includes(payload[1])) throw new Error('Invalid SIYI codec response');
  return { stream: payload[0], codec: payload[1], width: payload.readUInt16LE(2), height: payload.readUInt16LE(4),
    bitrateKbps: payload.readUInt16LE(6), fps: payload[8] };
}

export function encodeCameraEncoding({ stream, codec, width, height, bitrateKbps }) {
  if (![0, 1].includes(stream) || ![1, 2].includes(codec)
    || ![[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [4096, 2160]].some(([w, h]) => w === width && h === height)
    || (stream === 1 && width > 1920) || !Number.isInteger(bitrateKbps) || bitrateKbps < 1 || bitrateKbps > 65535) {
    throw new Error('Unsupported SIYI encoding parameters');
  }
  const p = Buffer.alloc(9);
  p[0] = stream; p[1] = codec; p.writeUInt16LE(width, 2); p.writeUInt16LE(height, 4); p.writeUInt16LE(bitrateKbps, 6);
  // Last byte is reserved in SET, not a frame-rate control.
  return p;
}

export class SiyiCamera {
  constructor({ send, timeoutMs = 1200, onChange = () => {} }) {
    Object.assign(this, { send, timeoutMs, onChange });
    this.pending = null; this.queue = Promise.resolve();
    this.lastEncodingReadAt = 0;
    this.status = { phase: 'unknown', recording: false, cardPresent: null, error: null };
  }

  receive(packet) {
    if (!(packet.control & 2)) return;
    if (packet.command === 0x0a && packet.payload.length >= 4) {
      const code = packet.payload[3];
      this.status = { ...this.status, recording: code === 1 || code === 3, cardPresent: code !== 2,
        code, updatedAt: Date.now(), error: code === 2 ? 'Camera TF card is missing' : code === 3 ? 'Camera TF card is losing data' : null };
    }
    const p = this.pending;
    if (p && packet.command === p.command && p.matches(packet.payload)) {
      this.pending = null; clearTimeout(p.timer); p.resolve(packet.payload);
    }
  }

  request(command, payload = Buffer.alloc(0), matches = () => true) {
    if (this.pending) return Promise.reject(new Error('Camera request already pending'));
    return new Promise((resolve, reject) => {
      const pending = { command, matches, resolve, reject };
      pending.timer = setTimeout(() => { if (this.pending === pending) this.pending = null; reject(new Error(`Camera command 0x${command.toString(16)} timed out`)); }, this.timeoutMs);
      this.pending = pending;
      try { this.send(command, payload); } catch (error) { clearTimeout(pending.timer); this.pending = null; reject(error); }
    });
  }

  serial(action) {
    const promise = this.queue.then(action);
    this.queue = promise.catch(() => {});
    return promise;
  }

  async readRequest(command, payload = Buffer.alloc(0), matches = () => true) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.request(command, payload, matches); }
      catch (error) {
        if (attempt === 2 || !error.message.includes('timed out')) throw error;
        // Avoid phase-locking retries to the 100 ms attitude polling cycle.
        await delay(175);
      }
    }
  }

  async readEncoding(stream) {
    // A8 firmware can drop back-to-back codec queries; keep management requests apart.
    const pause = 300 - (Date.now() - this.lastEncodingReadAt);
    if (pause > 0) await delay(pause);
    this.lastEncodingReadAt = Date.now();
    const encoding = decodeCameraEncoding(await this.readRequest(0x20, Buffer.from([stream]), p => p.length >= 9 && p[0] === stream));
    if (stream === 0) this.status = { ...this.status, encoding };
    return encoding;
  }

  getEncoding(stream) { return this.serial(() => this.readEncoding(stream)); }

  configureEncoding(settings) {
    return this.serial(async () => {
      const before = await this.readEncoding(settings.stream);
      const wanted = { ...before, ...settings };
      const same = value => ['stream', 'codec', 'width', 'height', 'bitrateKbps'].every(key => wanted[key] === value[key]);
      if (same(before)) return { before, after: before, changed: false };
      if (settings.stream === 0) {
        await this.readRequest(0x0a);
        if (this.status.recording) throw new Error('Stop camera TF recording before changing its resolution');
        if (wanted.codec !== before.codec) throw new Error('SIYI recording codec cannot be changed by this SDK');
      }
      try {
        const ack = await this.request(0x21, encodeCameraEncoding(wanted), p => p.length >= 2 && p[0] === wanted.stream);
        if (ack[1] !== 1) throw new Error('Camera rejected encoding parameters');
      } catch (error) {
        // A lost mutation ACK is resolved by readback, never by replaying a write.
        if (!error.message.includes('timed out')) throw error;
      }
      let after;
      for (let attempt = 0; attempt < 5; attempt++) {
        await delay(200);
        after = await this.readEncoding(wanted.stream);
        if (same(after)) return { before, after, changed: true };
      }
      throw new Error(`Camera encoding readback mismatch: ${JSON.stringify(after)}`);
    });
  }

  setRecording(desired) {
    return this.serial(async () => {
      try {
        await this.readRequest(0x0a);
        if (!this.status.cardPresent) throw new Error('Camera TF card is missing');
        if (this.status.code === 3 && desired) throw new Error('Camera TF card is losing data');
        if (this.status.recording !== desired) {
          // 0x0C/2 is a TOGGLE. Query before every attempt; send it exactly once.
          this.send(0x0c, Buffer.from([2]));
          for (let attempt = 0; attempt < 5; attempt++) {
            await delay(250);
            await this.readRequest(0x0a);
            if (this.status.recording === desired) break;
          }
          if (this.status.recording !== desired) throw new Error('Camera TF recording change was not confirmed');
        }
        this.status = { ...this.status, phase: desired ? 'recording' : 'stopped', error: null };
        this.onChange(this.status);
        return this.status;
      } catch (error) {
        this.status = { ...this.status, phase: 'unavailable', error: error.message };
        this.onChange(this.status);
        throw error;
      }
    });
  }
}
