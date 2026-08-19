/**
 * TOPOLOGI graf DJ dan cara parameter diterapkan.
 *
 * Yang dibuktikan di sini bukan "nilainya tersimpan" — itu tes store —
 * melainkan lima hal yang HANYA bisa salah di Web Audio, dan yang semuanya
 * bergejala sebagai "suaranya aneh" alih-alih sebagai error:
 *
 *  (a) tidak ada kanal yang menyambung langsung ke `destination`, jadi tidak ada
 *      yang bisa lolos dari fader master;
 *  (b) tap CUE diambil **sebelum** crossfader — kalau sesudah, monitor headphone
 *      ikut senyap justru saat lagunya belum masuk mix, yaitu seluruh gunanya;
 *  (c) knob COLOR memakai DUA biquad permanen, bukan satu yang ditukar jenisnya
 *      (`crates/engine/src/fx/filter.rs` menjelaskan kenapa: state TDF-II yang
 *      direinterpretasi berbunyi klik tiap kali knob melewati tengah);
 *  (d) menggeser kontrol hanya menyentuh AudioParam yang SUDAH ADA — begitu ia
 *      membangun ulang node, tiap piksel gerakan jadi klik;
 *  (e) gain crossfader yang benar-benar dipasang sama dengan yang dihitung
 *      `crossfaderGains` — kurva di layar dan kurva yang terdengar tidak boleh
 *      dua hal yang berbeda.
 *
 * Web Audio tidak ada di jsdom, jadi contextnya dipalsukan seminimal mungkin,
 * pola yang sama dengan `studio/preview/master-gain.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { crossfaderGains, defaultChannel, type ChannelState } from '../model';
import { applyChannel, applyCrossfader, applyMaster, buildDjGraph } from './dj-graph';

interface FakeParam {
  value: number;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

/**
 * `setTargetAtTime` palsu IKUT memperbarui `value`.
 *
 * Tanpa itu, `ramp()` — yang sengaja melewati penulisan saat nilainya sudah
 * sama — akan terlihat "tidak pernah dipanggil" pada panggilan kedua, dan tes
 * jadi menguji kebalikan dari yang dimaksud.
 */
const param = (v = 0): FakeParam => {
  const p: FakeParam = {
    value: v,
    setTargetAtTime: vi.fn((target: number) => {
      p.value = target;
    }),
    setValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
  return p;
};

interface Node {
  readonly kind: string;
  readonly out: Node[];
  connect(n: Node): Node;
  disconnect(n?: Node): void;
}

const DESTINATION: Node = { kind: 'destination', out: [], connect: (n) => n, disconnect: () => undefined };

function node(kind: string, extra: Record<string, unknown> = {}): Node {
  const out: Node[] = [];
  return {
    kind,
    out,
    connect(n: Node) {
      out.push(n);
      return n;
    },
    disconnect(n?: Node) {
      if (n === undefined) out.length = 0;
      else {
        const i = out.indexOf(n);
        if (i >= 0) out.splice(i, 1);
      }
    },
    ...extra,
  } as Node;
}

let created: Node[] = [];

function fakeCtx(): AudioContext {
  const make = (kind: string, extra: Record<string, unknown>): Node => {
    const n = node(kind, extra);
    created.push(n);
    return n;
  };
  return {
    currentTime: 0,
    sampleRate: 48_000,
    destination: DESTINATION,
    createGain: () => make('gain', { gain: param(1) }),
    createBiquadFilter: () =>
      make('biquad', { type: '', frequency: param(1000), Q: param(1), gain: param(0) }),
    createAnalyser: () => make('analyser', { fftSize: 0, smoothingTimeConstant: 0 }),
    createMediaStreamDestination: () => make('streamDest', { stream: {} }),
    createBufferSource: () => make('source', {}),
  } as unknown as AudioContext;
}

/** Semua node yang bisa dicapai dari `start`, mengikuti sambungan keluar. */
function reachable(start: Node): Set<Node> {
  const seen = new Set<Node>();
  const walk = (n: Node): void => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const next of n.out) walk(next);
  };
  walk(start);
  return seen;
}

type G = ReturnType<typeof buildDjGraph>;
let g: G;

beforeEach(() => {
  created = [];
  DESTINATION.out.length = 0;
  g = buildDjGraph(fakeCtx());
});

describe('topologi', () => {
  it('tidak ada kanal yang menyambung langsung ke destination', () => {
    for (const id of ['A', 'B'] as const) {
      const ch = g.channels[id] as unknown as Record<string, Node>;
      for (const key of ['input', 'trim', 'fader', 'cross']) {
        const n = ch[key] as Node;
        expect(n.out).not.toContain(DESTINATION as unknown as Node);
      }
    }
    // Satu-satunya jalan ke luar adalah lewat master.
    expect((g.master as unknown as Node).out).toContain(DESTINATION as unknown as Node);
  });

  it('sinyal kanal benar-benar sampai ke destination lewat master', () => {
    const from = reachable(g.channels.A.input as unknown as Node);
    expect(from.has(DESTINATION as unknown as Node)).toBe(true);
    expect(from.has(g.master as unknown as Node)).toBe(true);
  });

  it('tap CUE diambil SEBELUM crossfader', () => {
    const fader = g.channels.A.fader as unknown as Node;
    const cueSend = g.channels.A.cueSend as unknown as Node;
    const cross = g.channels.A.cross as unknown as Node;
    // Fader memberi makan ketiganya; kirim CUE tidak lewat crossfader.
    expect(fader.out).toContain(cueSend);
    expect(fader.out).toContain(cross);
    expect(reachable(cueSend).has(cross)).toBe(false);
  });

  it('bus CUE TIDAK tersambung ke destination — kalau iya, CUE menggandakan master', () => {
    expect(reachable(g.cueBus as unknown as Node).has(DESTINATION as unknown as Node)).toBe(false);
  });

  it('campuran headphone menerima KEDUA sumber: bus CUE dan master', () => {
    const level = g.cueLevel as unknown as Node;
    expect(reachable(g.cueSide as unknown as Node).has(level)).toBe(true);
    expect(reachable(g.masterSide as unknown as Node).has(level)).toBe(true);
  });

  it('COLOR memakai DUA biquad permanen, terpasang seri', () => {
    const lp = g.channels.A.colorLp as unknown as Node & { type: string };
    const hp = g.channels.A.colorHp as unknown as Node & { type: string };
    expect(lp.type).toBe('lowpass');
    expect(hp.type).toBe('highpass');
    expect(lp.out).toContain(hp);
  });

  it('titik sisip FX master ada di antara jumlah kanal dan fader master', () => {
    expect((g.masterFxIn as unknown as Node).out).toContain(g.master as unknown as Node);
    expect(reachable(g.channels.A.cross as unknown as Node).has(g.masterFxIn as unknown as Node)).toBe(
      true,
    );
  });
});

describe('penerapan parameter', () => {
  const ch = (over: Partial<ChannelState> = {}): ChannelState => ({ ...defaultChannel('A'), ...over });

  it('menggeser fader hanya menyentuh AudioParam yang sudah ada', () => {
    const before = created.length;
    applyChannel(g.channels.A, ch({ fader: 0.5 }), 0);
    expect(created.length).toBe(before);
    const gain = (g.channels.A.fader as unknown as { gain: FakeParam }).gain;
    expect(gain.setTargetAtTime).toHaveBeenCalled();
  });

  it('KILL menuliskan −26 dB ke gain biquad, bukan memutus node', () => {
    applyChannel(g.channels.A, ch({ eqKill: { hi: false, mid: false, low: true } }), 0);
    const low = (g.channels.A.eq.low as unknown as { gain: FakeParam }).gain;
    expect(low.value).toBe(-26);
  });

  it('KILL menang atas nilai knob, TANPA mengubah nilai knob itu', () => {
    const state = ch({ eq: { hi: 0, mid: 4, low: 0 }, eqKill: { hi: false, mid: true, low: false } });
    applyChannel(g.channels.A, state, 0);
    const mid = (g.channels.A.eq.mid as unknown as { gain: FakeParam }).gain;
    expect(mid.value).toBe(-26);
    // Nilai di STATE tetap 4: knob-nya tidak digerakkan, ia hanya berhenti
    // berpengaruh — "while they light up, each controller is not activated".
    expect(state.eq.mid).toBe(4);
  });

  it('menyalakan band lagi mengembalikan nilai knob ke jalur audio', () => {
    const eq = { hi: 0, mid: 4, low: 0 };
    applyChannel(g.channels.A, ch({ eq, eqKill: { hi: false, mid: true, low: false } }), 0);
    applyChannel(g.channels.A, ch({ eq, eqKill: { hi: false, mid: false, low: false } }), 0);
    const mid = (g.channels.A.eq.mid as unknown as { gain: FakeParam }).gain;
    expect(mid.value).toBe(4);
  });

  it('COLOR di tengah memarkir kedua filter pada posisi transparan', () => {
    applyChannel(g.channels.A, ch({ filter: 0 }), 0);
    const lp = g.channels.A.colorLp as unknown as { frequency: FakeParam; Q: FakeParam };
    const hp = g.channels.A.colorHp as unknown as { frequency: FakeParam; Q: FakeParam };
    expect(lp.frequency.setTargetAtTime).toHaveBeenCalledWith(18_000, 0, expect.any(Number));
    expect(hp.frequency.setTargetAtTime).toHaveBeenCalledWith(30, 0, expect.any(Number));
  });

  /**
   * Yang diperiksa adalah NILAI YANG MENDARAT, bukan bahwa setter-nya dipanggil:
   * `ramp()` sengaja melewati penulisan kalau nilainya sudah benar, dan itu
   * perilaku yang diinginkan — bukan kegagalan.
   *
   * Ini juga kriteria yang akan diulang dengan telinga nanti: kurva yang
   * dipajang di sisi crossfader dan kurva yang terdengar tidak boleh dua hal
   * yang berbeda.
   */
  it('gain crossfader yang MENDARAT sama dengan yang dihitung kurvanya', () => {
    const a = (g.channels.A.cross as unknown as { gain: FakeParam }).gain;
    const b = (g.channels.B.cross as unknown as { gain: FakeParam }).gain;
    for (const curve of ['smooth', 'sharp', 'cut'] as const) {
      for (const x of [0, 0.25, 0.5, 0.75, 1]) {
        const want = crossfaderGains(x, curve);
        applyCrossfader(g, x, curve, 0);
        expect(a.value).toBeCloseTo(want.a, 9);
        expect(b.value).toBeCloseTo(want.b, 9);
      }
    }
  });

  it('headphone lahir DIBISUKAN, hidup saat ada perangkat, mati lagi saat dilepas', () => {
    const level = (g.cueLevel as unknown as { gain: FakeParam }).gain;
    // Lahir nol: bus CUE tidak boleh terdengar sebelum ada yang memonitornya.
    expect(level.value).toBe(0);

    applyMaster(g, { masterDb: 0, cueDb: 0, cueMix: 0.5, cueMonitored: true }, 0);
    expect(level.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, expect.any(Number));

    applyMaster(g, { masterDb: 0, cueDb: 0, cueMix: 0.5, cueMonitored: false }, 0);
    expect(level.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, expect.any(Number));
  });

  it('CUE MIX membagi dua sumber headphone secara berlawanan', () => {
    applyMaster(g, { masterDb: 0, cueDb: 0, cueMix: 0.25, cueMonitored: true }, 0);
    const cueSide = (g.cueSide as unknown as { gain: FakeParam }).gain;
    const masterSide = (g.masterSide as unknown as { gain: FakeParam }).gain;
    expect(cueSide.value).toBeCloseTo(0.75, 9);
    expect(masterSide.value).toBeCloseTo(0.25, 9);
  });
});
