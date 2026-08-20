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

/**
 * Keterangan satu asset — TANPA PCM-nya.
 *
 * Dulu bentuk ini membawa `data: Float32Array` yang sudah rata, dan
 * `buildExportPayload` membuatnya untuk SEMUA asset sekaligus di muka. Untuk
 * project 4 lane × 27 menit itu 2,4 GiB di heap JS, ditahan sampai export
 * selesai, di samping 2,4 GiB yang sama di linear memory dan 2,4 GiB lagi di
 * `AudioBuffer` cache preview — tiga salinan dari audio yang sama.
 *
 * Sekarang PCM-nya diambil satu per satu lewat [`ExportAssetSource`], tepat
 * sebelum didaftarkan. Efek keduanya: penjaga memori bisa menolak project yang
 * terlalu besar SEBELUM satu byte PCM pun berwujud — janji yang selama ini
 * tertulis di komentarnya tapi tidak ditepati, karena ia berjalan sesudah
 * perataan selesai.
 */
export interface ExportAssetInfo {
  readonly assetId: number;
  readonly channels: number;
  readonly frames: number;
  readonly sampleRate: number;
}

/**
 * Sumber PCM satu asset: satu `Float32Array` per channel.
 *
 * Dipanggil SEKALI per asset, sesaat sebelum PCM-nya disalin ke linear memory.
 * Yang dikembalikan boleh berupa view ke penyimpanan milik orang lain
 * (`AudioBuffer.getChannelData` memang begitu) — pemanggil hanya membacanya,
 * dan membacanya selesai sebelum panggilan berikutnya.
 *
 * Sengaja BUKAN bagian dari [`ExportPayload`]: payload harus tetap bisa
 * menyeberang `postMessage` ke worker export, dan fungsi tidak bisa
 * di-structured-clone.
 */
export type ExportAssetSource = (info: ExportAssetInfo) => readonly Float32Array[];

export interface ExportPayload {
  /** JSON untuk `snapshotFromStudioJson`. */
  readonly json: string;
  /** Asset yang harus didaftarkan sebelum render — keterangannya saja. */
  readonly assets: readonly ExportAssetInfo[];
  /** Panjang output (sample, ruang OUTPUT sesudah transport speed). */
  readonly endSample: number;
}

/** Sumber PCM — `audio-preview.getBuffer` memenuhi bentuk ini apa adanya. */
export type BufferLookup = (assetId: number) => AudioBuffer | undefined;

/**
 * Susun payload export dari state store.
 *
 * `endSample` dihitung di sini dan bukan di Rust karena UI sudah menampilkan
 * angka yang sama di kartu Compile — dua perhitungan berarti dua jawaban.
 */
export interface BuiltExportPayload {
  readonly payload: ExportPayload;
  /** PCM-nya, diambil belakangan satu per satu. */
  readonly pcm: ExportAssetSource;
}

export function buildExportPayload(
  state: StudioState,
  getBuffer: BufferLookup,
): BuiltExportPayload {
  // Kecepatan RENDER, bukan kecepatan transport: mengubah kecepatan saat
  // mendengarkan tidak boleh diam-diam mengubah kecepatan file yang dihasilkan.
  // Keduanya sengaja jadi dua angka terpisah di store.
  const speed = state.renderSpeed > 0 ? state.renderSpeed : 1;
  /** Kunci = id UI; `assetId` di dalamnya id padat untuk engine. */
  const assets = new Map<number, ExportAssetInfo>();

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
        // Hanya keterangannya. PCM-nya tidak disentuh sampai `pcm()` dipanggil.
        assets.set(clip.assetId, {
          assetId: toDense(clip.assetId),
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
      // Disalin apa adanya, termasuk `params`. Nama parameter dan rentangnya
      // adalah urusan katalog di Rust, jadi menambah efek ke-7 tidak menyentuh
      // berkas ini sama sekali — itulah gunanya berkas ini tetap BODOH.
      chain: lane.chain.map((fx) => ({
        kind: fx.kind,
        enabled: fx.enabled,
        params: { ...fx.params },
      })),
      clips: clips.map((c) => ({
        id: c.id,
        // Dikirim walau engine belum bisa memprosesnya. Sebelum ini, stem
        // terdengar di preview dan hilang dari file TANPA satu pun peringatan
        // — `map_project` sekarang bisa mengatakannya karena datanya sampai.
        stem: c.stem === undefined ? null : { ...c.stem },
        chain: c.chain.map((fx) => ({
          kind: fx.kind,
          enabled: fx.enabled,
          params: { ...fx.params },
        })),
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

  // Balik arah pemetaannya: pemanggil `pcm()` hanya memegang id padat, dan
  // `getBuffer` hanya mengenal id UI.
  const uiIdByDense = new Map<number, number>();
  for (const [uiId, info] of assets) uiIdByDense.set(info.assetId, uiId);

  const pcm: ExportAssetSource = (info) => {
    const uiId = uiIdByDense.get(info.assetId);
    const buf = uiId === undefined ? undefined : getBuffer(uiId);
    if (buf === undefined) {
      // Bisa terjadi kalau cache preview dibuang di tengah export. Diam-diam
      // melewatinya berarti file hasilnya senyap di bagian itu tanpa penjelasan.
      throw new Error(
        `PCM asset ${info.assetId} hilang dari cache preview saat export berjalan.`,
      );
    }
    const channels = Math.max(1, buf.numberOfChannels);
    // `getChannelData` mengembalikan view, bukan salinan — dan itu memang yang
    // diinginkan: satu-satunya salinan terjadi saat menulis ke linear memory.
    return Array.from({ length: channels }, (_, c) => buf.getChannelData(c));
  };

  const payload: ExportPayload = {
    json: JSON.stringify({
      sampleRate: state.sampleRate,
      speed,
      // Amplify master: diterapkan setelah semua lane dijumlahkan. Dikirim ke
      // engine supaya file hasilnya selevel dengan yang didengar di preview.
      masterGainDb: state.masterGainDb,
      masterChain: state.masterChain.map((fx) => ({
        kind: fx.kind,
        enabled: fx.enabled,
        params: { ...fx.params },
      })),
      lanes,
    }),
    assets: [...assets.values()],
    endSample: Math.round(endTimeline / speed),
  };

  return { payload, pcm };
}

/**
 * Penanda tiap hal yang BENAR-BENAR ikut ke payload export.
 *
 * Diturunkan dari JSON yang dikirim, bukan dari state — kalau diturunkan dari
 * state, ia akan melaporkan hal yang tidak pernah diserialisasi dan justru
 * menutupi lubang yang mau dicari.
 *
 * Pasangannya `BuiltGraph.features`; `parity.test.ts` menuntut
 * `preview ⊆ export`. Perbandingan sample tidak mungkin — Node tidak punya Web
 * Audio, dan biquad Web Audio bukan implementasi yang sama dengan Rust — tapi
 * "apa yang diterapkan" bisa dibandingkan, dan itu persis kelas kegagalan yang
 * pernah benar-benar terjadi: `clip.stem` dipakai preview dan tidak pernah
 * dikirim ke export.
 */
export function payloadFeatures(json: string): Set<string> {
  const out = new Set<string>();
  const p = JSON.parse(json) as {
    masterChain?: { kind: string }[];
    lanes?: {
      id: string;
      eq?: { bands?: unknown[] };
      chain?: { kind: string }[];
      clips?: {
        id: string;
        fadeInMs?: number;
        fadeOutMs?: number;
        stem?: unknown;
        chain?: { kind: string }[];
      }[];
    }[];
  };
  (p.masterChain ?? []).forEach((fx, i) => out.add(`masterFx:${i}:${fx.kind}`));
  for (const lane of p.lanes ?? []) {
    out.add(`laneGain:${lane.id}`);
    if ((lane.eq?.bands ?? []).length > 0) out.add(`eq:${lane.id}`);
    (lane.chain ?? []).forEach((fx, i) => out.add(`fx:${lane.id}:${i}:${fx.kind}`));
    for (const c of lane.clips ?? []) {
      out.add(`clipGain:${c.id}`);
      if ((c.fadeInMs ?? 0) > 0 || (c.fadeOutMs ?? 0) > 0) out.add(`fade:${c.id}`);
      if (c.stem !== null && c.stem !== undefined) out.add(`stem:${c.id}`);
      (c.chain ?? []).forEach((fx, i) => out.add(`clipFx:${c.id}:${i}:${fx.kind}`));
    }
  }
  return out;
}
