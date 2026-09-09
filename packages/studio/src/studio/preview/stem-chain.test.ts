/**
 * Tes rantai stem. Web Audio tidak ada di jsdom, jadi kontekstnya dipalsukan —
 * tapi TIDAK hanya dicatat: fake di sini benar-benar MENGHITUNG graf yang
 * terbentuk, sehingga yang diuji adalah aritmetika rangkaiannya, bukan sekadar
 * "node-nya dibuat".
 *
 * Biquad diganti penguat konstan yang bergantung pada frekuensinya. Itu sah
 * untuk membuktikan hal yang paling penting di modul ini: identitas
 * `low + voice + high ≡ M` berlaku karena TOPOLOGI-nya (dua pengurangan),
 * berapa pun nilai transfer filternya. Kalau kabelnya salah — pita tertukar,
 * pembalik hilang, sisi masuk ke tempat yang keliru — identitas itu langsung
 * gagal, dan itulah cacat yang bisa benar-benar terjadi di sini.
 */

import { describe, expect, it } from 'vitest';

import { STEM_BYPASS, type StemMix } from '../model';
import { buildStemChain } from './stem-chain';

// ── Fake Web Audio yang bisa dihitung ────────────────────────────────────────

interface Edge {
  readonly from: FakeNode;
  readonly out: number;
  readonly in: number;
}

/** Transfer filter tiruan: monoton terhadap frekuensi, jadi dua pita yang
 *  tertukar menghasilkan angka yang berbeda. */
const kOf = (freq: number): number => 1000 / (1000 + freq);

class FakeNode {
  ins: Edge[] = [];
  gain = { value: 1, setTargetAtTime: () => undefined };
  frequency = { value: 0, setTargetAtTime: () => undefined };
  Q = { value: 1 };
  type = '';
  channelCount = 1;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  channels: number[] | null = null;

  constructor(readonly kind: 'gain' | 'biquad' | 'splitter' | 'merger' | 'source') {}

  connect(dest: FakeNode, out = 0, into = 0): FakeNode {
    dest.ins.push({ from: this, out, in: into });
    return dest;
  }
  disconnect(): void {}
}

class FakeCtx {
  currentTime = 0;
  sampleRate = 48_000;
  createGain(): FakeNode {
    return new FakeNode('gain');
  }
  createBiquadFilter(): FakeNode {
    return new FakeNode('biquad');
  }
  createChannelSplitter(): FakeNode {
    return new FakeNode('splitter');
  }
  createChannelMerger(): FakeNode {
    return new FakeNode('merger');
  }
}

/** Jumlahkan masukan sebuah node, kanal per kanal, dengan up-mix mono→stereo
 *  hanya kalau node-nya memang meminta interpretasi speaker. */
function evaluate(node: FakeNode, memo = new Map<FakeNode, number[]>()): number[] {
  const cached = memo.get(node);
  if (cached !== undefined) return cached;

  const pull = (e: Edge): number => evaluate(e.from, memo)[e.out] ?? 0;
  let out: number[];

  switch (node.kind) {
    case 'source':
      out = node.channels ?? [0, 0];
      break;
    case 'splitter': {
      // Meneruskan kanal apa adanya; konsumen memilih lewat `edge.out`.
      const src = node.ins[0];
      out = src === undefined ? [0, 0] : evaluate(src.from, memo);
      break;
    }
    case 'merger': {
      out = [0, 0];
      for (const e of node.ins) out[e.in] = (out[e.in] ?? 0) + pull(e);
      break;
    }
    case 'biquad': {
      let sum = 0;
      for (const e of node.ins) sum += pull(e);
      out = [sum * kOf(node.frequency.value)];
      break;
    }
    default: {
      // gain
      const stereo =
        node.channelCount === 2 &&
        node.channelCountMode === 'explicit' &&
        node.channelInterpretation === 'speakers';
      if (stereo) {
        let accL = 0;
        let accR = 0;
        for (const e of node.ins) {
          const ch = evaluate(e.from, memo);
          // Up-mix speaker: mono jadi L = R.
          accL += ch[0] ?? 0;
          accR += ch.length === 1 ? (ch[0] ?? 0) : (ch[1] ?? 0);
        }
        const acc = [accL, accR];
        out = [acc[0]! * node.gain.value, acc[1]! * node.gain.value];
      } else {
        let sum = 0;
        for (const e of node.ins) sum += pull(e);
        out = [sum * node.gain.value];
      }
    }
  }
  memo.set(node, out);
  return out;
}

/** Jalankan sepasang sampel L/R lewat rantai dan ambil keluarannya. */
function run(stem: StemMix, l: number, r: number, mono = false): [number, number] {
  const ctx = new FakeCtx();
  const chain = buildStemChain(ctx as unknown as BaseAudioContext, stem);
  const src = new FakeNode('source');
  src.channels = mono ? [l] : [l, r];
  src.connect(chain.input as unknown as FakeNode);
  const out = evaluate(chain.output as unknown as FakeNode);
  return [out[0] ?? 0, out[1] ?? 0];
}

/** Nilai yang SEHARUSNYA keluar, dihitung dari rumus di `model.ts` —
 *  independen dari cara rantainya dirangkai. */
function expected(stem: StemMix, l: number, r: number): [number, number] {
  const mid = (l + r) / 2;
  const side = (l - r) / 2;
  const low = mid * kOf(stem.bassSplitHz);
  const midHigh = mid - low;
  const voice = midHigh * kOf(stem.voiceTopHz);
  const high = midHigh - voice;
  const m = stem.bass * low + stem.vocal * voice + stem.other * high;
  const s = stem.other * side;
  return [m + s, m - s];
}

const near = (a: number, b: number): void => expect(a).toBeCloseTo(b, 9);

describe('rantai stem', () => {
  it('BYPASS transparan — keluaran sama persis dengan masukan', () => {
    for (const [l, r] of [
      [1, 1],
      [1, -1],
      [0.3, 0.9],
      [-0.7, 0.2],
    ] as const) {
      const [ol, or] = run(STEM_BYPASS, l, r);
      near(ol, l);
      near(or, r);
    }
  });

  it('cocok dengan rumus mid/side untuk kombinasi gain apa pun', () => {
    const cases: StemMix[] = [
      { ...STEM_BYPASS, vocal: 0 },
      { ...STEM_BYPASS, bass: 0 },
      { ...STEM_BYPASS, other: 0 },
      { ...STEM_BYPASS, vocal: 0.5, bass: 0.25, other: 0.75 },
      { ...STEM_BYPASS, vocal: 0, bassSplitHz: 90, voiceTopHz: 9000 },
    ];
    for (const stem of cases) {
      const [ol, or] = run(stem, 0.4, -0.6);
      const [el, er] = expected(stem, 0.4, -0.6);
      near(ol, el);
      near(or, er);
    }
  });

  it('sinyal yang HANYA di sisi selamat dari REMOVE VOCAL', () => {
    // L = -R → mid = 0. Tidak ada apa pun di tengah untuk dibuang.
    const stem: StemMix = { ...STEM_BYPASS, vocal: 0 };
    const [ol, or] = run(stem, 0.5, -0.5);
    near(ol, 0.5);
    near(or, -0.5);
  });

  it('sinyal yang HANYA di tengah kehilangan pita suaranya saat REMOVE VOCAL', () => {
    const stem: StemMix = { ...STEM_BYPASS, vocal: 0 };
    const [ol, or] = run(stem, 0.5, 0.5);
    const [el] = expected(stem, 0.5, 0.5);
    near(ol, el);
    near(or, el);
    expect(Math.abs(ol)).toBeLessThan(0.5); // benar-benar berkurang
  });

  it('REMOVE BASS hanya menyentuh pita bawah yang di tengah', () => {
    const stem: StemMix = { ...STEM_BYPASS, bass: 0 };
    const [ol] = run(stem, 1, 1);
    near(ol, 1 - kOf(stem.bassSplitHz));
  });

  it('materi MONO tetap mono dan tetap transparan saat bypass', () => {
    const [bl, br] = run(STEM_BYPASS, 0.6, 0, true);
    near(bl, 0.6);
    near(br, 0.6);
    // Dan REMOVE VOCAL pada mono memang membuang isi tengahnya — tidak
    // menghasilkan stereo palsu. Itu perilaku yang dijanjikan UI.
    const [vl, vr] = run({ ...STEM_BYPASS, vocal: 0 }, 0.6, 0, true);
    near(vl, vr);
    expect(Math.abs(vl)).toBeLessThan(0.6);
  });

  it('crossover ditempatkan di filter yang benar (pita tidak tertukar)', () => {
    // bassSplit dan voiceTop ditukar harus memberi hasil yang BERBEDA;
    // kalau sama, berarti kedua filter menerima sinyal yang sama.
    const a = run({ ...STEM_BYPASS, vocal: 0, bassSplitHz: 100, voiceTopHz: 8000 }, 1, 1);
    const b = run({ ...STEM_BYPASS, vocal: 0, bassSplitHz: 300, voiceTopHz: 2000 }, 1, 1);
    expect(a[0]).not.toBeCloseTo(b[0], 6);
  });
});
