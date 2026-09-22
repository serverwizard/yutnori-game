/**
 * 효과음. 파일 없이 Web Audio 로 합성한다 (학교 네트워크에서 추가 다운로드가 없도록).
 * 브라우저 정책상 첫 사용자 동작 뒤에 unlock() 을 불러야 소리가 난다.
 */
const NOTE = Object.freeze({
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  C6: 1046.5,
  E6: 1318.5,
  A4: 440,
  F4: 349.23,
});

export class SoundBox {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) {
      this.unlock();
    }
  }

  unlock() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        return;
      }
      if (!this.ctx) {
        this.ctx = new AudioContextClass();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    } catch {
      this.ctx = null;
    }
  }

  get ready() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  /** 짧은 잡음 (윷가락 부딪히는 소리) */
  noise(duration, { frequency = 1800, q = 1, gain = 0.3, when = 0 } = {}) {
    if (!this.ready) {
      return;
    }
    const ctx = this.ctx;
    const sampleCount = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const amp = ctx.createGain();
    const start = ctx.currentTime + when;
    amp.gain.setValueAtTime(gain, start);
    amp.gain.exponentialRampToValueAtTime(0.001, start + duration);
    source.connect(filter).connect(amp).connect(ctx.destination);
    source.start(start);
    source.stop(start + duration);
  }

  tone(frequency, { duration = 0.15, type = 'sine', gain = 0.18, when = 0, slideTo = null } = {}) {
    if (!this.ready) {
      return;
    }
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    const start = ctx.currentTime + when;
    osc.frequency.setValueAtTime(frequency, start);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
    }
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  /** 손에 쥐고 흔드는 달그락 소리 */
  rattle() {
    this.noise(0.05, { frequency: 2200 + Math.random() * 1800, q: 2, gain: 0.12 });
  }

  /** 던지는 순간 */
  whoosh() {
    this.noise(0.35, { frequency: 700, q: 0.6, gain: 0.1 });
  }

  /** 윷가락이 바닥에 떨어지는 소리 */
  clack() {
    this.noise(0.03, { frequency: 3200, q: 3, gain: 0.25 });
    this.tone(170 + Math.random() * 40, { duration: 0.09, type: 'triangle', gain: 0.22 });
  }

  /** 결과별 신호음 */
  result(key) {
    switch (key) {
      case 'DO':
        this.tone(NOTE.C5, { duration: 0.14 });
        return;
      case 'GAE':
        this.tone(NOTE.C5, { duration: 0.12 });
        this.tone(NOTE.E5, { duration: 0.16, when: 0.13 });
        return;
      case 'GEOL':
        this.tone(NOTE.C5, { duration: 0.11 });
        this.tone(NOTE.E5, { duration: 0.11, when: 0.12 });
        this.tone(NOTE.G5, { duration: 0.2, when: 0.24 });
        return;
      case 'YUT':
        [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((frequency, i) => {
          this.tone(frequency, { duration: 0.14, when: i * 0.1, gain: 0.2 });
        });
        this.tone(NOTE.C6, { duration: 0.45, when: 0.42, type: 'triangle', gain: 0.16 });
        return;
      case 'MO':
        [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6, NOTE.E6].forEach((frequency, i) => {
          this.tone(frequency, { duration: 0.14, when: i * 0.09, gain: 0.2 });
        });
        this.tone(NOTE.G5, { duration: 0.5, when: 0.5, type: 'triangle', gain: 0.16 });
        this.tone(NOTE.C6, { duration: 0.7, when: 0.5, type: 'triangle', gain: 0.16 });
        this.noise(0.6, { frequency: 5000, q: 0.5, gain: 0.05, when: 0.5 });
        return;
      case 'BACKDO':
        this.tone(NOTE.A4, { duration: 0.28, type: 'sawtooth', gain: 0.08, slideTo: NOTE.F4 });
        this.tone(NOTE.F4, { duration: 0.4, type: 'sawtooth', gain: 0.08, when: 0.3, slideTo: NOTE.F4 / 1.5 });
        return;
      default:
        return;
    }
  }

  /** 버튼 누름 등 짧은 확인음 */
  tick() {
    this.tone(NOTE.G5, { duration: 0.06, gain: 0.08 });
  }
}
