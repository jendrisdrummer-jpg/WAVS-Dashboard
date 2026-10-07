// Audio worklets for the comms relay (used when a phone can't reach the engine directly, e.g. on a
// hotspot or cellular). Audio travels over the comms WebSocket as 16 kHz mono μ-law, 20 ms per
// message (320 bytes, about 128 kbit/s), and only while someone is actually talking.
//
//   wavs-capture: microphone / mix -> 20 ms μ-law frames (posted to the page)
//   wavs-player:  μ-law frames from the page -> audio, with a small jitter buffer

const RATE = 16000;
const FRAME = 320; // 20 ms

function encode(x) {
  let s = Math.max(-1, Math.min(1, x)) * 32635;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += 0x84;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

const DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exp = (u >> 4) & 7;
  const mag = (((u & 0x0f) << 3) + 0x84) << exp;
  DECODE[i] = ((u & 0x80 ? 0x84 - mag : mag - 0x84) / 32768);
}

class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.ratio = sampleRate / RATE;
    this.skipSilence = Boolean(o.skipSilence); // the engine sends nothing for a silent mix
    this.on = o.gated ? false : true; // a phone only sends while talking
    this.acc = 0;
    this.cnt = 0;
    this.pos = 0;
    this.buf = new Uint8Array(FRAME);
    this.n = 0;
    this.peak = 0;
    this.port.onmessage = (e) => { if (typeof e.data?.on === 'boolean') this.on = e.data.on; };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // Average the input samples that fall into each output sample (a simple low-pass).
      this.acc += ch[i];
      this.cnt++;
      this.pos += 1;
      if (this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      const v = this.acc / this.cnt;
      this.acc = 0;
      this.cnt = 0;
      if (Math.abs(v) > this.peak) this.peak = Math.abs(v);
      this.buf[this.n++] = encode(v);
      if (this.n === FRAME) {
        if (this.on && (!this.skipSilence || this.peak > 0.002)) {
          const out = this.buf.slice().buffer;
          this.port.postMessage(out, [out]);
        }
        this.n = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = RATE * 2;
    this.q = new Float32Array(this.cap);
    this.r = 0;
    this.w = 0;
    this.len = 0;
    this.playing = false;
    this.step = RATE / sampleRate;
    this.frac = 0;
    this.target = RATE * 0.08; // start playing with 80 ms buffered
    this.max = RATE * 0.3; // never fall more than 300 ms behind
    this.port.onmessage = (e) => this.push(new Uint8Array(e.data));
  }

  push(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      this.q[this.w] = DECODE[bytes[i]];
      this.w = (this.w + 1) % this.cap;
      if (this.len < this.cap) this.len++;
      else this.r = (this.r + 1) % this.cap;
    }
    // Too far behind (e.g. after a network hiccup): skip ahead to keep the delay short.
    if (this.len > this.max) {
      const drop = this.len - this.target;
      this.r = (this.r + drop) % this.cap;
      this.len -= drop;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.playing && this.len >= this.target) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || this.len < 2) {
        out[i] = 0;
        if (this.len < 2) this.playing = false;
        continue;
      }
      const a = this.q[this.r];
      const b = this.q[(this.r + 1) % this.cap];
      out[i] = a + (b - a) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1) {
        this.frac -= 1;
        this.r = (this.r + 1) % this.cap;
        this.len--;
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('wavs-capture', Capture);
registerProcessor('wavs-player', Player);
