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
import { saveAsset } from '../persist/db';
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

  // Simpan byte-nya supaya hasil bake selamat dari refresh: persistence
  // menyimpan BYTE per asset dan men-decode ulang saat boot (lihat
  // persist/persistence.ts), jadi asset yang tidak punya byte akan hilang.
  // Kegagalan di sini tidak membatalkan bake — audionya sudah benar di sesi
  // ini, dan itu lebih baik daripada membuang pekerjaan user.
  try {
    await saveAsset({ id: assetId, name, bytes: encodeWavFloat32(rendered) });
  } catch {
    return { ok: true, assetId, reason: 'hasil bake tidak bisa disimpan — hilang saat refresh' };
  }

  return { ok: true, assetId };
}

/**
 * WAV IEEE-float 32-bit, ditulis di sini dan BUKAN lewat `encoders/wav.ts`.
 *
 * Encoder itu adalah encoder EXPORT: ia punya pilihan bit depth dan dither, dan
 * ia berjalan di atas Rust sehingga menuntut modul WASM sudah termuat. BAKE
 * tidak butuh satu pun dari itu — yang diperlukan hanya wadah lossless yang
 * bisa dibaca kembali oleh `decodeAudioData`. Menggantungkannya pada engine
 * berarti tombol BAKE gagal justru di keadaan yang paling sering terjadi
 * sekarang: build WASM belum ada.
 *
 * Float32 (bukan PCM 16-bit): hasil render adalah float, dan membulatkannya
 * berarti setiap kali membekukan stem user membayar satu lapis kuantisasi.
 */
function encodeWavFloat32(buf: AudioBuffer): ArrayBuffer {
  const channels = buf.numberOfChannels;
  const frames = buf.length;
  const bytesPerSample = 4;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);

  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // 3 = IEEE float
  view.setUint16(22, channels, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Interleave. Data kanal diambil sekali per kanal (bukan per frame):
  // `getChannelData` menyalin di sebagian implementasi, dan memanggilnya di
  // dalam loop frame mengubah operasi O(n) jadi O(n²).
  const planar: Float32Array[] = [];
  for (let c = 0; c < channels; c++) planar.push(buf.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      view.setFloat32(at, planar[c]![i] ?? 0, true);
      at += 4;
    }
  }
  return out;
}
