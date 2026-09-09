/**
 * SCRUB dilihat dari `DjAudio.apply` — yaitu dari tempat urutannya bisa salah.
 *
 * `deck-player.test.ts` sudah membuktikan bahwa `beginScrub`/`scrubTo`/`endScrub`
 * masing-masing benar. Yang TIDAK dibuktikan di sana adalah bahwa ketiganya
 * dipanggil pada saat yang tepat relatif terhadap `seekEpoch` dan `playing` —
 * dan justru itu satu-satunya bagian yang tidak punya bentuk lokal: ia hidup
 * sebagai urutan tiga baris `if` yang tidak berdekatan.
 *
 * Dua kesalahan yang mungkin, keduanya bergejala sebagai bunyi dan bukan error:
 *
 *  - `beginScrub` SESUDAH cabang `seekEpoch` → laporan tangan yang pertama
 *    sempat menjadwalkan ulang source utama, dan awal tiap tarikan berbunyi
 *    klik;
 *  - `endScrub` SEBELUM cabang `seekEpoch` → source utama menyala di posisi
 *    sebelum lompatan penutup, lalu lompatan itu menjadwalkannya ulang. Dua
 *    source dalam satu frame, dan lagunya lanjut dari tempat yang salah.
 *
 * Keduanya bisa dilihat dari SATU hal yang bisa dihitung: berapa banyak source
 * utama yang lahir, dan di posisi mana. Butir scrub dibedakan dari source utama
 * lewat argumen `duration` pada `start()` — hanya butir yang punya panjang
 * tetap; source utama berjalan sampai dihentikan.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildDjGraph } from './dj-graph';
import { DjAudio } from './engine';
import { djStore } from '../store';
import type { DeckState, DjState } from '../model';

const SR = 48_000;

interface StartCall {
  readonly when: number;
  readonly offset: number;
  readonly duration: number | undefined;
}

interface FakeSource {
  started: StartCall | null;
}

const param = (v = 0): Record<string, unknown> => {
  const p = {
    value: v,
    setValueAtTime: (x: number) => {
      p.value = x;
    },
    linearRampToValueAtTime: (x: number) => {
      p.value = x;
    },
    setTargetAtTime: (x: number) => {
      p.value = x;
    },
    cancelScheduledValues: () => undefined,
  };
  return p as unknown as Record<string, unknown>;
};

let sources: FakeSource[] = [];

function fakeCtx(): AudioContext {
  const base = {
    out: [] as unknown[],
    connect(n: unknown) {
      return n;
    },
    disconnect() {},
  };
  const node = (extra: Record<string, unknown>): unknown => ({ ...base, ...extra });

  const ctx = {
    currentTime: 0,
    sampleRate: SR,
    state: 'running',
    destination: node({}),
    createGain: () => node({ gain: param(1) }),
    createBiquadFilter: () =>
      node({ type: '', frequency: param(1000), Q: param(1), gain: param(0) }),
    createAnalyser: () => node({ fftSize: 1024, smoothingTimeConstant: 0 }),
    createMediaStreamDestination: () => node({ stream: {} }),
    createBufferSource: () => {
      const s: FakeSource & Record<string, unknown> = {
        ...base,
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        playbackRate: param(1),
        started: null,
        start(when: number, offset: number, duration?: number) {
          s.started = { when, offset, duration };
        },
        stop() {},
      };
      sources.push(s);
      return s;
    },
  };
  return ctx as unknown as AudioContext;
}

const fakeBuffer = (seconds: number): AudioBuffer =>
  ({ length: Math.round(seconds * SR), sampleRate: SR, numberOfChannels: 2 }) as AudioBuffer;

/** Source utama = yang dijadwalkan TANPA panjang. Butir scrub selalu punya. */
const mainSources = (): FakeSource[] =>
  sources.filter((s) => s.started !== null && s.started.duration === undefined);
const grains = (): FakeSource[] =>
  sources.filter((s) => s.started !== null && s.started.duration !== undefined);

let ctx: AudioContext & { currentTime: number };
let audio: DjAudio;
let base: DjState;

/** State dengan deck A ditambal — sisanya dibiarkan apa adanya. */
const st = (patch: Partial<DeckState>): DjState => ({
  ...base,
  decks: { ...base.decks, A: { ...base.decks.A, ...patch } },
});

const advance = (sec: number): void => {
  ctx.currentTime += sec;
};

/** Cukup jauh untuk melewati ambang jarak antar butir. */
const STEP = 0.05;

beforeEach(() => {
  sources = [];
  ctx = fakeCtx() as AudioContext & { currentTime: number };
  audio = new DjAudio(buildDjGraph(ctx));
  base = djStore.getState();

  // `getBuffer` milik Studio tidak punya apa-apa di lingkungan tes, jadi
  // penerapan pertama memuat `null`. Materinya dipasang tangan SETELAH itu,
  // supaya penerapan berikutnya (yang `assetId`-nya tidak berubah) tidak
  // menimpanya kembali dengan null.
  audio.apply(st({ assetId: 1 }), false);
  audio.graph.channels.A.player.load(fakeBuffer(300), 0);
  sources = [];
});

const pos = (): number => audio.positionSamples('A') ?? Number.NaN;

describe('deck yang DIAM', () => {
  it('tangan menggerakkan posisi, dan yang berbunyi hanya butir', () => {
    audio.apply(st({ assetId: 1, scrubbing: true }), false);
    advance(STEP);
    audio.apply(st({ assetId: 1, scrubbing: true, playhead: 30 * SR, seekEpoch: 1 }), false);

    expect(pos()).toBeCloseTo(30 * SR, 3);
    expect(mainSources()).toHaveLength(0);
    expect(grains()).toHaveLength(1);
    // Grain memakai buffer scratch lokal; posisi deck sudah tercermin pada
    // materi yang disalin, jadi source selalu mulai dari offset nol.
    expect(grains()[0]?.started?.offset).toBe(0);
  });

  it('tetap diam setelah tangan diangkat', () => {
    audio.apply(st({ assetId: 1, scrubbing: true }), false);
    audio.apply(st({ assetId: 1, scrubbing: true, playhead: 30 * SR, seekEpoch: 1 }), false);
    audio.apply(st({ assetId: 1, playhead: 30 * SR, seekEpoch: 1 }), false);

    advance(5);
    expect(pos()).toBeCloseTo(30 * SR, 3);
    expect(mainSources()).toHaveLength(0);
  });

  it('lompatan BIASA (hot cue, beat jump) tetap bisu — itu bukan scrub', () => {
    audio.apply(st({ assetId: 1, playhead: 30 * SR, seekEpoch: 1 }), false);
    expect(grains()).toHaveLength(0);
  });
});

describe('deck yang BERJALAN', () => {
  const play = (): void => {
    audio.apply(st({ assetId: 1, playing: true }), false);
  };

  it('source utama TIDAK dijadwalkan ulang selama tangan menarik', () => {
    // Inilah bug yang membuat scrub berdengung: satu source per laporan tangan.
    play();
    expect(mainSources()).toHaveLength(1);

    advance(2);
    audio.apply(st({ assetId: 1, playing: true, scrubbing: true }), false);

    for (let i = 1; i <= 6; i += 1) {
      advance(STEP);
      audio.apply(
        st({ assetId: 1, playing: true, scrubbing: true, playhead: (2 + i) * SR, seekEpoch: i }),
        false,
      );
    }

    expect(mainSources()).toHaveLength(1);
    expect(grains()).toHaveLength(6);
  });

  it('posisi berhenti maju sendiri selama tangan menempel', () => {
    play();
    advance(2);
    audio.apply(st({ assetId: 1, playing: true, scrubbing: true }), false);
    advance(4);
    expect(pos()).toBeCloseTo(2 * SR, 3);
  });

  it('lanjut dari posisi PENUTUP, bukan dari posisi sebelum lompatan terakhir', () => {
    /*
     * Urutan ini menirukan `DeckScrollingWave` persis: `seek` penutup lebih
     * dulu, tanda scrub dilepas SESUDAHNYA — dua penerapan terpisah. Kalau
     * `endScrub` dijalankan sebelum cabang `seekEpoch`, angka yang keluar di
     * sini adalah 30, bukan 60.
     */
    play();
    advance(1);
    audio.apply(st({ assetId: 1, playing: true, scrubbing: true }), false);
    advance(STEP);
    audio.apply(
      st({ assetId: 1, playing: true, scrubbing: true, playhead: 30 * SR, seekEpoch: 1 }),
      false,
    );
    advance(STEP);
    audio.apply(
      st({ assetId: 1, playing: true, scrubbing: true, playhead: 60 * SR, seekEpoch: 2 }),
      false,
    );
    audio.apply(st({ assetId: 1, playing: true, playhead: 60 * SR, seekEpoch: 2 }), false);

    const main = mainSources();
    expect(main).toHaveLength(2);
    expect(main[1]?.started?.offset).toBeCloseTo(60, 6);

    advance(3);
    expect(pos()).toBeCloseTo(63 * SR, 3);
  });

  it('tanda dan laporan tangan PERTAMA yang datang bersama tidak menyalakan source', () => {
    // Cermin dari tes berikutnya, untuk ujung yang satunya: kalau `beginScrub`
    // dijalankan SESUDAH cabang `seekEpoch`, laporan tangan yang pertama masih
    // melihat deck sebagai "berjalan biasa" dan menjadwalkan ulang source utama
    // — satu klik di awal SETIAP tarikan.
    play();
    advance(1);
    audio.apply(
      st({ assetId: 1, playing: true, scrubbing: true, playhead: 30 * SR, seekEpoch: 1 }),
      false,
    );

    expect(mainSources()).toHaveLength(1);
    expect(grains()).toHaveLength(1);
    expect(pos()).toBeCloseTo(30 * SR, 3);
  });

  it('lompatan penutup dan pelepasan tanda yang datang BERSAMA tetap benar', () => {
    /*
     * Hari ini `DeckScrollingWave` mengirim keduanya sebagai DUA perubahan
     * store terpisah — `set` memberitahu pelanggannya secara sinkron — jadi
     * jalur itu tidak menguji urutannya sama sekali.
     *
     * Ia tetap dikunci di sini karena satu aksi gabungan (`seek` + melepas
     * tanda dalam satu `set`) adalah bentuk store yang lebih rapi dan
     * kemungkinan besar akan ditulis suatu saat. Pada hari itu, urutan tiga
     * baris `if` di `apply` adalah SATU-SATUNYA yang menentukan apakah lagunya
     * lanjut dari 60 detik atau dari 30 — dan yang salah tidak melempar apa
     * pun, ia hanya memutar bagian lagu yang keliru.
     */
    play();
    advance(1);
    audio.apply(st({ assetId: 1, playing: true, scrubbing: true }), false);
    advance(STEP);
    audio.apply(
      st({ assetId: 1, playing: true, scrubbing: true, playhead: 30 * SR, seekEpoch: 1 }),
      false,
    );
    advance(STEP);
    audio.apply(st({ assetId: 1, playing: true, playhead: 60 * SR, seekEpoch: 2 }), false);

    const main = mainSources();
    // DUA, bukan tiga: `endScrub` yang jalan terlalu awal menyalakan source di
    // posisi lama, lalu lompatan penutup menyalakannya lagi.
    expect(main).toHaveLength(2);
    expect(main[1]?.started?.offset).toBeCloseTo(60, 6);

    advance(3);
    expect(pos()).toBeCloseTo(63 * SR, 3);
  });

  it('PAUSE di tengah tarikan tidak menyalakan apa pun saat tangan diangkat', () => {
    play();
    advance(1);
    audio.apply(st({ assetId: 1, playing: true, scrubbing: true }), false);
    advance(STEP);
    audio.apply(
      st({ assetId: 1, playing: true, scrubbing: true, playhead: 30 * SR, seekEpoch: 1 }),
      false,
    );
    audio.apply(st({ assetId: 1, scrubbing: true, playhead: 30 * SR, seekEpoch: 1 }), false);
    audio.apply(st({ assetId: 1, playhead: 30 * SR, seekEpoch: 1 }), false);

    expect(mainSources()).toHaveLength(1); // hanya yang dari PLAY pertama
    advance(5);
    expect(pos()).toBeCloseTo(30 * SR, 3);
  });

  it('PLAY yang ditekan di tengah tarikan baru berjalan setelah dilepas', () => {
    audio.apply(st({ assetId: 1, scrubbing: true }), false);
    advance(STEP);
    audio.apply(st({ assetId: 1, scrubbing: true, playhead: 10 * SR, seekEpoch: 1 }), false);
    audio.apply(
      st({ assetId: 1, playing: true, scrubbing: true, playhead: 10 * SR, seekEpoch: 1 }),
      false,
    );

    expect(mainSources()).toHaveLength(0);
    advance(2);
    expect(pos()).toBeCloseTo(10 * SR, 3);

    audio.apply(st({ assetId: 1, playing: true, playhead: 10 * SR, seekEpoch: 1 }), false);
    expect(mainSources()).toHaveLength(1);
    advance(2);
    expect(pos()).toBeCloseTo(12 * SR, 3);
  });
});

describe('loop yang aktif', () => {
  it('butir mengikuti pelipatan loop, sama dengan yang digambar layar', () => {
    // Menarik ke luar loop membuat playhead melipat kembali ke dalam. Kalau
    // butirnya membunyikan angka MENTAH dari tangan, layar dan telinga bercerita
    // dua hal yang berbeda tentang posisi yang sama.
    const looped = st({ assetId: 1, loop: { inAt: 0, outAt: 4 * SR, active: true, beats: 8 } });
    audio.apply(looped, false);
    audio.apply({ ...looped, decks: { ...looped.decks, A: { ...looped.decks.A, scrubbing: true } } }, false);
    advance(STEP);
    audio.apply(
      {
        ...looped,
        decks: {
          ...looped.decks,
          A: { ...looped.decks.A, scrubbing: true, playhead: 10 * SR, seekEpoch: 1 },
        },
      },
      false,
    );

    expect(pos()).toBeCloseTo(2 * SR, 3);
    expect(grains()).toHaveLength(1);
    expect(grains()[0]?.started?.offset).toBe(0);
  });
});

describe('deck B tidak ikut terseret', () => {
  it('menarik deck A tidak menyentuh source deck B', () => {
    // Dibangun dari state yang deck A-nya SUDAH memegang lagu: menurunkannya
    // kembali ke null di sini akan membongkar buffer yang baru saja dipasang.
    const withA = st({ assetId: 1 });
    const b: DjState = {
      ...withA,
      decks: { ...withA.decks, B: { ...withA.decks.B, assetId: 2 } },
    };
    audio.apply(b, false);
    audio.graph.channels.B.player.load(fakeBuffer(300), 0);
    sources = [];

    audio.apply(
      {
        ...b,
        decks: { ...b.decks, A: { ...b.decks.A, scrubbing: true } },
      },
      false,
    );
    advance(STEP);
    audio.apply(
      {
        ...b,
        decks: {
          ...b.decks,
          A: { ...b.decks.A, scrubbing: true, playhead: 30 * SR, seekEpoch: 1 },
        },
      },
      false,
    );

    expect(grains()).toHaveLength(1);
    expect(audio.positionSamples('B')).toBe(0);
  });
});
