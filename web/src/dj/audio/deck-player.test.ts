/**
 * Matematika posisi `DeckPlayer`, diuji terhadap konteks palsu.
 *
 * jsdom tidak punya Web Audio sama sekali, jadi yang diuji di sini adalah
 * bagian yang memang MURNI: jangkar posisi, pelipatan loop, dan posisi bayangan
 * slip. Itu justru bagian yang paling mudah salah dan paling sulit dilihat —
 * hanyutnya baru terasa setelah lagu berjalan menit-menit, yaitu tepat saat DJ
 * paling bergantung padanya.
 *
 * Node-nya sendiri (gain, source) tidak diuji: yang dijamin oleh browser tidak
 * perlu dijamin lagi oleh kita.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { DeckPlayer } from './deck-player';

const SR = 48_000;

/** Konteks palsu: jam yang bisa dimajukan tangan, node yang tidak berbunyi. */
class FakeCtx {
  currentTime = 0;
  readonly sampleRate = SR;

  advance(sec: number): void {
    this.currentTime += sec;
  }

  createGain(): unknown {
    return {
      gain: {
        value: 1,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
        cancelScheduledValues: () => undefined,
        setTargetAtTime: () => undefined,
      },
      connect: () => undefined,
      disconnect: () => undefined,
    };
  }

  createBufferSource(): unknown {
    return {
      buffer: null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: {
        value: 1,
        setValueAtTime: () => undefined,
        setTargetAtTime: () => undefined,
        cancelScheduledValues: () => undefined,
      },
      connect: () => undefined,
      disconnect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    };
  }
}

const fakeBuffer = (seconds: number): AudioBuffer =>
  ({ length: Math.round(seconds * SR), sampleRate: SR, numberOfChannels: 2 }) as AudioBuffer;

let ctx: FakeCtx;
let player: DeckPlayer;

beforeEach(() => {
  ctx = new FakeCtx();
  player = new DeckPlayer({
    ctx: ctx as unknown as BaseAudioContext,
    destination: { connect: () => undefined } as unknown as AudioNode,
  });
  player.load(fakeBuffer(300), 0);
});

describe('posisi', () => {
  it('diam saat tidak diputar, berapa lama pun waktu berjalan', () => {
    ctx.advance(10);
    expect(player.positionAt(ctx.currentTime)).toBe(0);
  });

  it('maju sebesar waktu × laju × sample rate', () => {
    player.play(0);
    ctx.advance(2);
    expect(player.positionAt(ctx.currentTime)).toBeCloseTo(2 * SR, 3);
  });

  it('tidak hanyut setelah lima menit — jangkar, bukan akumulasi', () => {
    player.play(0);
    // Dimajukan dalam banyak langkah kecil: kalau posisinya diakumulasi per
    // langkah, galat pembulatan tiap langkah akan menumpuk di sini.
    for (let i = 0; i < 3000; i += 1) ctx.advance(0.1);
    expect(player.positionAt(ctx.currentTime)).toBeCloseTo(300 * SR, 0);
  });

  it('mengikuti perubahan laju TANPA menghitung ulang masa lalu', () => {
    player.play(0);
    ctx.advance(1); // 1 detik @1.0 → 48 000
    player.setRate(2);
    ctx.advance(1); // 1 detik @2.0 → +96 000
    expect(player.positionAt(ctx.currentTime)).toBeCloseTo(SR * 3, 3);
  });

  it('dijepit ke ujung materi', () => {
    player.play(0);
    ctx.advance(10_000);
    expect(player.positionAt(ctx.currentTime)).toBe(300 * SR);
  });
});

describe('loop', () => {
  it('melipat posisi ke dalam loop, sama seperti yang dilakukan node', () => {
    player.setLoop({ inAt: 0, outAt: SR });
    player.play(0);
    ctx.advance(2.5); // 2.5 putaran
    expect(player.positionAt(ctx.currentTime)).toBeCloseTo(0.5 * SR, 3);
  });

  it('melipat berkali-kali, bukan menempel di ujung', () => {
    player.setLoop({ inAt: SR, outAt: 2 * SR });
    player.play(SR);
    ctx.advance(7.25);
    const p = player.positionAt(ctx.currentTime);
    expect(p).toBeGreaterThanOrEqual(SR);
    expect(p).toBeLessThan(2 * SR);
    expect(p).toBeCloseTo(SR + 0.25 * SR, 3);
  });

  it('melepas loop tidak memindahkan posisi pada frame pergantian', () => {
    player.setLoop({ inAt: 0, outAt: SR });
    player.play(0);
    ctx.advance(2.5);
    const before = player.positionAt(ctx.currentTime);
    player.setLoop(null);
    expect(player.positionAt(ctx.currentTime)).toBeCloseTo(before, 3);
  });
});

describe('slip', () => {
  it('bayangannya berjalan terus meski deck terkurung di loop', () => {
    player.setLoop({ inAt: 0, outAt: SR });
    player.play(0);
    player.setSlip(true);
    ctx.advance(5);
    // Yang terdengar melipat di dalam satu detik…
    expect(player.positionAt(ctx.currentTime)).toBeLessThan(SR);
    // …tapi bayangannya sudah lima detik jauhnya.
    expect(player.slipPositionAt(ctx.currentTime)).toBeCloseTo(5 * SR, 3);
  });

  it('melepas SLIP melompat ke posisi bayangan', () => {
    player.setLoop({ inAt: 0, outAt: SR });
    player.play(0);
    player.setSlip(true);
    ctx.advance(5);
    const target = player.setSlip(false);
    expect(target).toBeCloseTo(5 * SR, 3);
  });

  it('tanpa SLIP, lompatan biasa ikut memindahkan bayangan', () => {
    player.play(0);
    ctx.advance(1);
    player.seek(10 * SR);
    expect(player.slipPositionAt(ctx.currentTime)).toBeCloseTo(10 * SR, 3);
  });
});

describe('ujung materi', () => {
  it('dilaporkan hanya saat benar-benar habis dan tidak sedang loop', () => {
    player.play(299 * SR);
    ctx.advance(0.5);
    expect(player.reachedEnd(ctx.currentTime)).toBe(false);
    ctx.advance(1);
    expect(player.reachedEnd(ctx.currentTime)).toBe(true);
  });

  it('TIDAK pernah dilaporkan saat loop aktif — loop memang tidak berujung', () => {
    player.setLoop({ inAt: 0, outAt: SR });
    player.play(0);
    ctx.advance(10_000);
    expect(player.reachedEnd(ctx.currentTime)).toBe(false);
  });
});

describe('loop yang dipersempit di bawah posisi sekarang', () => {
  /**
   * `AudioBufferSourceNode` hanya melipat saat kursornya MENCAPAI `loopEnd`
   * dari arah maju. Menekan ÷2 di paruh kedua loop menaruh `outAt` baru di
   * BELAKANG kursor, dan tanpa penanganan khusus node-nya berjalan lurus
   * sampai ujung lagu — sementara layar tetap menggambar playhead melipat di
   * dalam loop. Dua kebenaran yang berbeda tentang hal yang sama.
   */
  it('melompatkan deck ke dalam loop baru, bukan membiarkannya lari', () => {
    player.setLoop({ inAt: 0, outAt: 4 * SR });
    player.play(0);
    ctx.advance(3); // di paruh kedua
    player.setLoop({ inAt: 0, outAt: 2 * SR }); // ÷2
    const p = player.positionAt(ctx.currentTime);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(2 * SR);
    expect(p).toBeCloseTo(SR, 3);
  });

  it('posisi yang masih di dalam loop baru TIDAK digeser', () => {
    player.setLoop({ inAt: 0, outAt: 4 * SR });
    player.play(0);
    ctx.advance(1);
    player.setLoop({ inAt: 0, outAt: 2 * SR });
    expect(player.positionAt(ctx.currentTime)).toBeCloseTo(SR, 3);
  });
});
