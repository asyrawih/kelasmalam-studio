/**
 * `ScrubVoice`, diuji terhadap konteks palsu yang MENCATAT.
 *
 * Yang diuji di sini bukan bunyinya — jsdom tidak punya Web Audio, dan yang
 * dijamin browser tidak perlu dijamin lagi oleh kita. Yang diuji adalah
 * KEBIJAKAN PENJADWALAN: kapan sebuah butir boleh lahir, berapa panjangnya, dan
 * ke mana ia disambungkan. Ketiganya justru bagian yang tidak terlihat dari
 * layar dan hanya terdengar sebagai "scrub-nya berdengung" — gejala yang
 * menuntun orang mencari penyebabnya di tempat yang salah.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { ScrubVoice } from './scrub-voice';

const SR = 48_000;

interface StartCall {
  readonly when: number;
  readonly offset: number;
  readonly duration: number;
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly playbackRate = {
    value: 1,
    setValueAtTime: (v: number): void => {
      this.playbackRate.value = v;
    },
  };
  started: StartCall | null = null;
  stopped = false;
  connectedTo: unknown = null;

  connect(target: unknown): void {
    this.connectedTo = target;
  }
  disconnect(): void {}
  start(when: number, offset: number, duration: number): void {
    this.started = { when, offset, duration };
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeGain {
  connectedTo: unknown = null;
  readonly gain = {
    value: 0,
    setValueAtTime: (): void => undefined,
    linearRampToValueAtTime: (): void => undefined,
  };
  connect(target: unknown): void {
    this.connectedTo = target;
  }
  disconnect(): void {}
}

class FakeCtx {
  currentTime = 0;
  readonly sampleRate = SR;
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];

  advance(sec: number): void {
    this.currentTime += sec;
  }
  createGain(): unknown {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource(): unknown {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      length,
      sampleRate,
      numberOfChannels: channels,
      getChannelData: (channel: number) => data[channel]!,
    } as AudioBuffer;
  }
}

const fakeBuffer = (seconds: number): AudioBuffer => {
  const length = Math.round(seconds * SR);
  const data = [new Float32Array(length), new Float32Array(length)];
  return {
    length,
    sampleRate: SR,
    numberOfChannels: 2,
    getChannelData: (channel: number) => data[channel]!,
  } as AudioBuffer;
};

const sec = (n: number): number => n * SR;

/** Maju cukup jauh untuk melewati ambang jarak antar butir. */
const PAST_INTERVAL = 0.05;

let ctx: FakeCtx;
let destination: object;
let voice: ScrubVoice;

beforeEach(() => {
  ctx = new FakeCtx();
  destination = { connect: () => undefined };
  voice = new ScrubVoice({
    ctx: ctx as unknown as BaseAudioContext,
    destination: destination as unknown as AudioNode,
  });
  voice.setBuffer(fakeBuffer(300));
});

describe('kapan butir lahir', () => {
  it('butir pertama berbunyi langsung — tidak ada jeda sebelum bunyi pertama', () => {
    voice.emit(sec(10), 1);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]?.started?.offset).toBe(0);
  });

  it('tidak berbunyi sama sekali tanpa materi', () => {
    voice.setBuffer(null);
    voice.emit(sec(10), 1);
    expect(ctx.sources).toHaveLength(0);
  });

  it('DUA laporan tangan yang berdekatan hanya menghasilkan SATU butir', () => {
    // Inti dari seluruh berkas ini: `pointermove` datang ~60×/detik, dan satu
    // butir per laporan adalah dengung 60 Hz, bukan lagu.
    voice.emit(sec(10), 1);
    ctx.advance(0.016);
    voice.emit(sec(10.05), 1);
    ctx.advance(0.016);
    voice.emit(sec(10.1), 1);
    expect(ctx.sources).toHaveLength(1);
  });

  it('butir berikutnya lahir setelah jaraknya terlampaui', () => {
    voice.emit(sec(10), 1);
    ctx.advance(PAST_INTERVAL);
    voice.emit(sec(10.4), 1);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]?.started?.offset).toBe(0);
  });

  it('TANGAN YANG DIAM tidak berbunyi, berapa lama pun ditahan', () => {
    // Jari yang menempel tanpa bergerak akan menghasilkan satu nada stabil
    // kalau butirnya tetap dijadwalkan. Yang benar saat tangan berhenti adalah
    // senyap — itu yang membuat scrub terasa seperti memegang lagu.
    voice.emit(sec(10), 1);
    for (let i = 0; i < 20; i += 1) {
      ctx.advance(PAST_INTERVAL);
      voice.emit(sec(10), 1);
    }
    expect(ctx.sources).toHaveLength(1);
  });

  it('tangan yang diam lalu bergerak lagi langsung berbunyi', () => {
    voice.emit(sec(10), 1);
    ctx.advance(PAST_INTERVAL);
    voice.emit(sec(10), 1);
    ctx.advance(PAST_INTERVAL);
    voice.emit(sec(11), 1);
    expect(ctx.sources).toHaveLength(2);
  });

  it('posisi di luar materi tidak menjadwalkan apa pun', () => {
    voice.emit(sec(400), 1);
    voice.emit(-sec(1), 1);
    expect(ctx.sources).toHaveLength(0);
  });

  it('posisi di luar materi tidak ikut memakai jatah butir berikutnya', () => {
    // Menarik melewati ujung lalu kembali harus langsung berbunyi lagi; kalau
    // percobaan yang gagal ikut mencatat waktu, ada 45 ms senyap tanpa sebab.
    voice.emit(sec(400), 1);
    voice.emit(sec(10), 1);
    expect(ctx.sources).toHaveLength(1);
  });
});

describe('bentuk butir', () => {
  it('velocity tangan menentukan playback rate dan dibatasi agar tetap stabil', () => {
    voice.emit(sec(10), 1);
    ctx.advance(PAST_INTERVAL);
    voice.emit(sec(9.9), 1); // 0.1 s / 0.05 s = 2×, arah mundur
    expect(ctx.sources[1]?.playbackRate.value).toBeCloseTo(2, 6);

    ctx.advance(PAST_INTERVAL);
    voice.emit(sec(20), 1); // lonjakan ekstrem dijepit, tidak merusak pitch
    expect(ctx.sources[2]?.playbackRate.value).toBe(4);
  });

  it('panjang DINDING-nya tetap saat velocity tangan berubah', () => {
    // Yang harus konstan adalah panjang yang TERDENGAR, bukan panjang materi:
    // butir yang menyusut mengikuti laju akan lebih pendek dari fade-nya
    // sendiri pada deck yang dipercepat, dan yang tersisa hanya klik.
    voice.emit(sec(10), 1);
    const source1 = ctx.sources[0];

    ctx.advance(PAST_INTERVAL);
    voice.emit(sec(20), 2);
    const source2 = ctx.sources[1];

    expect((source1?.started?.duration ?? 0) / (source1?.playbackRate.value ?? 1)).toBeCloseTo(0.09, 3);
    expect((source2?.started?.duration ?? 0) / (source2?.playbackRate.value ?? 1)).toBeCloseTo(0.09, 3);
  });

  it('dipotong di ujung materi, bukan menjulur keluar', () => {
    voice.emit(sec(299.99), 1);
    const d = ctx.sources[0]?.started?.duration ?? 0;
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(0.01 + 1e-9);
  });

  it('dijadwalkan SEDIKIT KE DEPAN, tidak di masa lalu', () => {
    ctx.advance(5);
    voice.emit(sec(10), 1);
    expect(ctx.sources[0]?.started?.when ?? 0).toBeGreaterThan(ctx.currentTime);
  });

  it('laju yang tidak masuk akal jatuh ke 1, bukan menghasilkan NaN', () => {
    voice.emit(sec(10), 0);
    expect(ctx.sources[0]?.playbackRate.value).toBe(1);
    expect(ctx.sources[0]?.started?.duration).toBeGreaterThan(0);
  });
});

describe('jalur sinyal', () => {
  it('butir masuk ke channel strip, bukan langsung ke keluaran', () => {
    // Kalau butir memintas channel strip, mencari cue point dengan fader turun
    // akan menyemburkan lagu berikutnya ke ruangan — kebalikan dari gunanya.
    voice.emit(sec(10), 1);
    const gain = ctx.gains[0];
    expect(ctx.sources[0]?.connectedTo).toBe(gain);
    expect(gain?.connectedTo).toBe(destination);
  });
});

describe('berhenti', () => {
  it('mematikan semua butir yang masih hidup', () => {
    voice.emit(sec(10), 1);
    ctx.advance(PAST_INTERVAL);
    voice.emit(sec(11), 1);
    expect(voice.liveGrains).toBe(2);

    voice.stop();
    expect(voice.liveGrains).toBe(0);
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
  });

  it('melepas `onended` supaya butir yang mati tidak menyentuh daftar baru', () => {
    voice.emit(sec(10), 1);
    const first = ctx.sources[0];
    voice.stop();
    expect(first?.onended).toBeNull();
  });

  it('mengulang dari nol — butir berikutnya berbunyi langsung', () => {
    voice.emit(sec(10), 1);
    voice.stop();
    voice.emit(sec(10), 1);
    expect(ctx.sources).toHaveLength(2);
  });

  it('mengganti materi ikut menghentikan butir yang lama', () => {
    voice.emit(sec(10), 1);
    voice.setBuffer(fakeBuffer(120));
    expect(voice.liveGrains).toBe(0);
    expect(ctx.sources[0]?.stopped).toBe(true);
  });

  it('aman dipanggil berkali-kali', () => {
    voice.emit(sec(10), 1);
    expect(() => {
      voice.stop();
      voice.stop();
    }).not.toThrow();
  });
});
