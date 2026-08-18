/**
 * RANTAI STEM — mid/side + crossover komplementer, di Web Audio.
 *
 * Rumus dan batasnya ada di `StemMix` (`model.ts`). Yang perlu dijelaskan di
 * sini adalah CARA merangkainya, karena satu pilihan di bawah menentukan
 * seluruh sifat modul ini:
 *
 * PENGURANGAN, BUKAN FILTER KEDUA. Pita atas tidak dibuat dengan high-pass
 * melainkan dengan `M − LP(M)` (GainNode −1 yang dijumlahkan). Dengan begitu
 *
 *     low + voice + high  ≡  M
 *
 * berlaku PERSIS untuk biquad apa pun, pada frekuensi apa pun — bukan
 * "kira-kira" seperti sepasang LP/HP yang fasanya tidak pernah benar-benar
 * saling melengkapi. Konsekuensinya penting: dengan semua bagian disisakan
 * penuh, rantai ini transparan secara aritmetika. Bypass yang terbukti, bukan
 * bypass yang diklaim — dan itu yang membuat tombol REMOVE bisa dimatikan lagi
 * tanpa meninggalkan jejak pada suara.
 *
 * MASUKAN DI-UPMIX KE STEREO 'speakers'. Materi mono yang masuk langsung ke
 * ChannelSplitter akan terbaca sebagai L = sinyal, R = SENYAP (splitter
 * memakai interpretasi `discrete`), dan itu membuat `S` bukan nol pada materi
 * yang jelas-jelas tidak punya sisi — hasilnya "buang vokal" pada file mono
 * menghasilkan stereo aneh, bukan hasil yang jujur. Satu GainNode
 * ber-`channelInterpretation: 'speakers'` di depan memperbaikinya: mono jadi
 * L = R, `S = 0`, dan yang terjadi persis seperti yang dijanjikan UI.
 *
 * `BaseAudioContext` (bukan `AudioContext`) supaya `OfflineAudioContext` —
 * export dan BAKE — masuk tanpa cabang khusus, sama seperti `buildEqChain`.
 */

import type { StemMix } from '../model';
import { PARAM_RAMP_SEC } from './graph-builder';

export interface StemNodes {
  /** Sambungkan sumber ke sini. */
  readonly input: AudioNode;
  /** Sambungkan ini ke tujuan berikutnya. */
  readonly output: AudioNode;
  readonly gains: {
    readonly vocal: GainNode;
    readonly bass: GainNode;
    /** Bagian TENGAH dari "other" (di atas voiceTopHz). */
    readonly other: GainNode;
    /** Bagian SISI dari "other". Selalu bernilai sama dengan `other` —
     *  dua node karena sumbernya dua cabang, bukan dua parameter. */
    readonly otherSide: GainNode;
  };
  readonly filters: {
    readonly low: BiquadFilterNode;
    readonly voice: BiquadFilterNode;
  };
  /** Semua node, untuk di-disconnect saat playback berhenti. */
  readonly all: AudioNode[];
}

export function buildStemChain(audio: BaseAudioContext, stem: StemMix): StemNodes {
  const all: AudioNode[] = [];
  const keep = <T extends AudioNode>(n: T): T => {
    all.push(n);
    return n;
  };
  /** Gain sederhana; dipakai sebagai penjumlah (1), pembalik (−1), dan fader. */
  const gain = (v: number): GainNode => {
    const g = keep(audio.createGain());
    g.gain.value = v;
    return g;
  };

  // ── Masukan: paksa dua kanal dengan interpretasi speaker ──
  const input = gain(1);
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';

  const splitter = keep(audio.createChannelSplitter(2));
  input.connect(splitter);

  // ── M / S ──
  const mid = gain(1);
  const side = gain(1);
  const lToMid = gain(0.5);
  const rToMid = gain(0.5);
  const lToSide = gain(0.5);
  const rToSide = gain(-0.5);
  splitter.connect(lToMid, 0);
  splitter.connect(rToMid, 1);
  splitter.connect(lToSide, 0);
  splitter.connect(rToSide, 1);
  lToMid.connect(mid);
  rToMid.connect(mid);
  lToSide.connect(side);
  rToSide.connect(side);

  // ── Tiga pita dari M, lewat pengurangan (lihat catatan kepala berkas) ──
  const low = keep(audio.createBiquadFilter());
  low.type = 'lowpass';
  low.frequency.value = stem.bassSplitHz;
  mid.connect(low);

  const midHigh = gain(1);
  mid.connect(midHigh);
  const negLow = gain(-1);
  low.connect(negLow);
  negLow.connect(midHigh);

  const voice = keep(audio.createBiquadFilter());
  voice.type = 'lowpass';
  voice.frequency.value = stem.voiceTopHz;
  midHigh.connect(voice);

  const high = gain(1);
  midHigh.connect(high);
  const negVoice = gain(-1);
  voice.connect(negVoice);
  negVoice.connect(high);

  // ── Fader per bagian ──
  const bassGain = gain(stem.bass);
  const vocalGain = gain(stem.vocal);
  const otherGain = gain(stem.other);
  const otherSideGain = gain(stem.other);
  low.connect(bassGain);
  voice.connect(vocalGain);
  high.connect(otherGain);
  side.connect(otherSideGain);

  const midOut = gain(1);
  bassGain.connect(midOut);
  vocalGain.connect(midOut);
  otherGain.connect(midOut);

  // ── Kembali ke L/R: L = M + S, R = M − S ──
  const outL = gain(1);
  const outR = gain(1);
  midOut.connect(outL);
  midOut.connect(outR);
  otherSideGain.connect(outL);
  const negSide = gain(-1);
  otherSideGain.connect(negSide);
  negSide.connect(outR);

  const merger = keep(audio.createChannelMerger(2));
  outL.connect(merger, 0, 0);
  outR.connect(merger, 0, 1);

  return {
    input,
    output: merger,
    gains: { vocal: vocalGain, bass: bassGain, other: otherGain, otherSide: otherSideGain },
    filters: { low, voice },
    all,
  };
}

/**
 * Terapkan nilai baru ke rantai yang SEDANG BERBUNYI.
 *
 * Lewat `setTargetAtTime`, bukan dengan membangun ulang: menggeser slider
 * berarti puluhan perubahan per detik, dan merakit ulang graf di tengahnya
 * terdengar sebagai deretan klik, bukan sebagai perubahan level. Pola dan
 * konstantanya sama persis dengan cara EQ lane diperbarui di `audio-preview`.
 */
export function updateStemNodes(n: StemNodes, stem: StemMix, at: number): void {
  n.gains.bass.gain.setTargetAtTime(stem.bass, at, PARAM_RAMP_SEC);
  n.gains.vocal.gain.setTargetAtTime(stem.vocal, at, PARAM_RAMP_SEC);
  n.gains.other.gain.setTargetAtTime(stem.other, at, PARAM_RAMP_SEC);
  n.gains.otherSide.gain.setTargetAtTime(stem.other, at, PARAM_RAMP_SEC);
  n.filters.low.frequency.setTargetAtTime(stem.bassSplitHz, at, PARAM_RAMP_SEC);
  n.filters.voice.frequency.setTargetAtTime(stem.voiceTopHz, at, PARAM_RAMP_SEC);
}
