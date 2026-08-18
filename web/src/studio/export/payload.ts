/**
 * Model studio → JSON yang dimengerti `snapshotFromStudioJson` (Rust).
 *
 * File ini sengaja BODOH: ia hanya menyalin field dan mengganti nama. SEMUA
 * keputusan semantik — solo jadi mute, lane speed jadi speed clip, ms jadi
 * sample, transport speed jadi skala timeline — dikerjakan di
 * `crates/wasm-bridge/src/studio.rs`. Kalau pemetaan hidup di dua tempat,
 * keduanya akan berselisih tanpa ada yang menyadarinya, dan bedanya cuma
 * terdengar di file hasil export.
 *
 * Yang TIDAK dikirim: clip tanpa PCM. Clip demo tanpa asset nyata dilewati di
 * preview (`graph-builder.ts`), jadi ia juga harus dilewati di sini — kalau
 * tidak, engine akan menjadwalkan voice untuk asset yang tidak pernah
 * didaftarkan dan hasilnya senyap tanpa penjelasan.
 */

import type { StudioState } from '../model';
import { expandLoopClip } from '../timeline/clip-loop';

export interface ExportAssetPcm {
  readonly assetId: number;
  /** Semua channel BERURUTAN: channel `c` mulai di `c * frames`. */
  readonly data: Float32Array;
  readonly channels: number;
  readonly frames: number;
  readonly sampleRate: number;
}

export interface ExportPayload {
  /** JSON untuk `snapshotFromStudioJson`. */
  readonly json: string;
  /** PCM yang harus didaftarkan sebelum render. */
  readonly assets: readonly ExportAssetPcm[];
  /** Panjang output (sample, ruang OUTPUT sesudah transport speed). */
  readonly endSample: number;
}

/** Sumber PCM — `audio-preview.getBuffer` memenuhi bentuk ini apa adanya. */
export type BufferLookup = (assetId: number) => AudioBuffer | undefined;

/**
 * Ratakan `AudioBuffer` jadi satu Float32Array planar.
 *
 * `getChannelData` mengembalikan view ke buffer internal; disalin karena data
 * ini menyeberang ke linear memory WASM dan tidak boleh berubah di tengah jalan.
 */
export function flattenBuffer(buf: AudioBuffer): Float32Array {
  const channels = Math.max(1, buf.numberOfChannels);
  const frames = buf.length;
  const out = new Float32Array(channels * frames);
  for (let c = 0; c < channels; c++) out.set(buf.getChannelData(c), c * frames);
  return out;
}

/**
 * Susun payload export dari state store.
 *
 * `endSample` dihitung di sini dan bukan di Rust karena UI sudah menampilkan
 * angka yang sama di kartu Compile — dua perhitungan berarti dua jawaban.
 */
export function buildExportPayload(state: StudioState, getBuffer: BufferLookup): ExportPayload {
  // Kecepatan RENDER, bukan kecepatan transport: mengubah kecepatan saat
  // mendengarkan tidak boleh diam-diam mengubah kecepatan file yang dihasilkan.
  // Keduanya sengaja jadi dua angka terpisah di store.
  const speed = state.renderSpeed > 0 ? state.renderSpeed : 1;
  const assets = new Map<number, ExportAssetPcm>();

  /**
   * PENOMORAN ULANG ASSET: id UI → 0,1,2,… untuk engine.
   *
   * `AssetId` di Rust adalah `u32` (index ke tabel asset), sedangkan id di UI
   * dibuat dari timestamp dan besarnya ~1.7e15 — jauh melewati batas u32, jadi
   * deserialisasi snapshot menolaknya mentah-mentah. Menomori ulang di batas
   * ini menyelesaikannya tanpa migrasi: project yang sudah tersimpan tetap
   * memakai id lamanya, dan engine hanya pernah melihat index rapat 0..n-1.
   *
   * Rapat juga lebih baik untuk engine: tabel asetnya di-index langsung, bukan
   * di-hash.
   */
  const denseId = new Map<number, number>();
  const toDense = (uiId: number): number => {
    let d = denseId.get(uiId);
    if (d === undefined) {
      d = denseId.size;
      denseId.set(uiId, d);
    }
    return d;
  };

  const lanes = state.lanes.map((lane) => {
    // LOOP CLIP DIJABARKAN DI SINI, bukan dikirim sebagai field baru.
    //
    // Engine Rust belum mengenal `loopLen`; menambahkannya ke protokol snapshot
    // berarti dua tafsir tentang loop (Web Audio dan Rust) yang bedanya hanya
    // terdengar di file hasil export. Deretan clip lurus adalah hal yang SUDAH
    // dimengerti kedua sisi — lihat `timeline/clip-loop.ts` untuk satu selisih
    // yang diakui (fade-out lebih panjang dari satu putaran).
    const flat = lane.clips.flatMap((c) =>
      expandLoopClip(c, lane.speedRatio, state.sampleRate, (i) => `${c.id}~loop${i}`),
    );
    const clips = flat.filter((clip) => {
      const buf = getBuffer(clip.assetId);
      if (buf === undefined) return false;
      if (!assets.has(clip.assetId)) {
        assets.set(clip.assetId, {
          assetId: toDense(clip.assetId),
          data: flattenBuffer(buf),
          channels: Math.max(1, buf.numberOfChannels),
          frames: buf.length,
          sampleRate: buf.sampleRate,
        });
      }
      return true;
    });

    return {
      id: lane.id,
      mute: lane.mute,
      solo: lane.solo,
      gainDb: lane.gainDb,
      speedRatio: lane.speedRatio,
      eq: {
        bands: lane.eq.bands.map((b) => ({
          kind: b.kind,
          freq: b.freq,
          q: b.q,
          gainDb: b.gainDb,
        })),
      },
      clips: clips.map((c) => ({
        id: c.id,
        assetId: toDense(c.assetId),
        start: c.start,
        len: c.len,
        sourceStart: c.sourceStart,
        gainDb: c.gainDb,
        fadeInMs: c.fadeInMs,
        fadeOutMs: c.fadeOutMs,
        fadeCurve: c.fadeCurve,
      })),
    };
  });

  // Ujung clip terjauh di lane yang TERDENGAR — bukan panjang timeline. Kita
  // tidak me-render dua menit senyap hanya karena timeline-nya sepanjang itu.
  // `isAudible` tidak dipakai di sini: aturan solo hidup di Rust, dan menyalin
  // ulang di sini justru membuka celah kedua model berselisih. Yang dipakai
  // adalah mute/solo mentah lewat rumus yang sama persis.
  const anySolo = state.lanes.some((l) => l.solo);
  let endTimeline = 0;
  for (const lane of lanes) {
    if (lane.mute || (anySolo && !lane.solo)) continue;
    for (const c of lane.clips) endTimeline = Math.max(endTimeline, c.start + c.len);
  }

  return {
    json: JSON.stringify({
      sampleRate: state.sampleRate,
      speed,
      // Amplify master: diterapkan setelah semua lane dijumlahkan. Dikirim ke
      // engine supaya file hasilnya selevel dengan yang didengar di preview.
      masterGainDb: state.masterGainDb,
      lanes,
    }),
    assets: [...assets.values()],
    endSample: Math.round(endTimeline / speed),
  };
}
