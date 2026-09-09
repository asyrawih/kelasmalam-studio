/**
 * BAKE — bekukan pembuangan stem jadi asset baru.
 *
 * Kenapa perlu, padahal stem sudah berbunyi non-destruktif: waveform di layar
 * masih menunjukkan materi ASLI, dan rantai stem ikut dibangun ulang setiap
 * kali playback dimulai. Setelah user puas dengan setelannya, membekukannya
 * membuat yang dilihat = yang didengar, dan menghilangkan biaya prosesnya.
 *
 * Yang dibekukan HANYA pemisahan stem — bukan gain clip, fade, EQ lane, atau
 * kecepatan. Itu semua tetap non-destruktif dan tetap bisa diubah setelahnya.
 *
 * Renderingnya lewat `OfflineAudioContext` dengan `buildStemChain` yang SAMA
 * dengan yang dipakai preview dan export. Tidak ada implementasi kedua, jadi
 * hasil bake tidak bisa berbeda dari yang barusan didengar.
 */

import { STEM_BYPASS, isStemBypass, samplesToSec, type StudioClip } from '../model';
import { resolveBeatGrid } from '../analysis/beat-grid';
import { getBuffer, registerBuffer } from '../preview/audio-preview';
import { buildStemChain } from '../preview/stem-chain';
import { studioActions, studioStore } from '../store';
import { assetFromBuffer } from './audio-import';
import { stemOf } from './stem';

export interface BakeResult {
  readonly ok: boolean;
  readonly reason?: string;
  /** Asset baru yang dihasilkan, kalau berhasil. */
  readonly assetId?: number;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  const w = globalThis as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext ?? null;
}

/**
 * Render region clip lewat rantai stem-nya, jadikan asset baru, dan arahkan
 * clip ke sana.
 *
 * Mengembalikan alasan kegagalan alih-alih melempar — pola yang sama dengan
 * `importFileToLane`, supaya UI bisa menampilkannya tanpa merusak render.
 */
export async function bakeClipStem(clipId: string): Promise<BakeResult> {
  const state = studioStore.getState();
  const hit = state.lanes.flatMap((l) => l.clips).find((c) => c.id === clipId);
  if (hit === undefined) return { ok: false, reason: 'clip tidak ditemukan' };
  const clip: StudioClip = hit;
  if (isStemBypass(clip.stem)) return { ok: false, reason: 'tidak ada yang dibuang' };

  const buffer = getBuffer(clip.assetId);
  if (buffer === undefined) return { ok: false, reason: 'clip ini belum punya audio' };

  const Ctor = offlineCtor();
  if (Ctor === null) return { ok: false, reason: 'browser ini tidak punya OfflineAudioContext' };

  const sr = buffer.sampleRate;
  const frames = Math.max(1, Math.min(clip.sourceLen, buffer.length - clip.sourceStart));
  const stem = stemOf(clip);

  let rendered: AudioBuffer;
  try {
    // Dua kanal SELALU, juga untuk sumber mono: rantai stem bekerja di
    // domain M/S dan keluarannya memang stereo. Memaksanya kembali ke mono di
    // sini akan menjumlahkan L+R sekali lagi.
    const ctx = new Ctor(2, frames, sr);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const chain = buildStemChain(ctx, stem);
    src.connect(chain.input);
    chain.output.connect(ctx.destination);
    src.start(0, samplesToSec(clip.sourceStart, sr), samplesToSec(frames, sr));
    rendered = await ctx.startRendering();
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : 'render gagal' };
  }

  const source = state.assets[clip.assetId];
  const assetId = studioActions.newAssetId();
  const name = `${source?.name ?? 'clip'} [stem]`;
  studioActions.registerAsset(assetFromBuffer(assetId, name, rendered));
  registerBuffer(assetId, rendered);

  // Grid ikut pindah, digeser sesuai potongan yang diambil. Tanpa ini, downbeat
  // yang sudah disetel user dengan susah payah hilang begitu ia menekan BAKE —
  // dan asset baru tidak akan dianalisis ulang (tempo-nya null).
  const grid = resolveBeatGrid(source);
  if (grid !== null) {
    studioActions.setAssetBeatGrid(assetId, {
      bpm: grid.bpm,
      offsetSec: grid.offsetSec - samplesToSec(clip.sourceStart, sr),
    });
  }

  // Clip menunjuk asset baru, region kembali dari nol, dan setelan stem-nya
  // dinetralkan — kalau tidak, pemisahan yang sudah dibekukan akan diterapkan
  // untuk KEDUA kalinya di atas hasilnya sendiri.
  studioActions.updateClip(clip.id, { assetId, sourceStart: 0, sourceLen: frames });
  studioActions.setClipStem(clip.id, STEM_BYPASS);

  // Hasil bake TIDAK disimpan ke mana pun. Dulu byte WAV-nya ditulis ke
  // penyimpanan lokal supaya selamat dari refresh; penyimpanan itu sudah
  // dibuang, dan penggantinya menyimpan atas perintah user. Seperti asset hasil
  // import, hasil bake hidup selama sesi ini saja.
  return { ok: true, assetId };
}
