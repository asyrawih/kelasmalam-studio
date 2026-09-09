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
import {
  getAutoStemAudio,
  getAutoStemMask,
  isFullStemMask,
  type AutoStemAudio,
  type AutoStemMask,
} from '@kelasmalam/studio-core/stem/auto-stem';
import {
  EMPTY_PCM,
  PCM_CHUNK_FRAMES,
  audioBufferPcmSource,
  pcmFromChannels,
  type BufferLookup,
  type ExportAssetInfo,
  type ExportAssetSource,
  type ExportPayload,
  type ExportPcmRequest,
} from '@kelasmalam/engine/export/payload';

/**
 * Bentuk payload dan sumber PCM tinggal di engine (`export/payload`) supaya
 * worker export tidak perlu mengimpor studio; diekspor ulang dari sini supaya
 * pemakai di dalam studio tidak perlu tahu pembagian itu.
 */
export {
  PCM_CHUNK_FRAMES,
  audioBufferPcmSource,
  pcmFromChannels,
  type BufferLookup,
  type ExportAssetInfo,
  type ExportAssetSource,
  type ExportPayload,
  type ExportPcmRequest,
};


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

export interface ScnetExportLookup {
  readonly getAudio: (assetId: number) => AutoStemAudio | undefined;
  readonly getMask: (clipId: string) => AutoStemMask;
}

const DEFAULT_SCNET_EXPORT: ScnetExportLookup = {
  getAudio: getAutoStemAudio,
  getMask: (clipId) => getAutoStemMask(`studio:${clipId}`),
};

export function buildExportPayload(
  state: StudioState,
  getBuffer: BufferLookup,
  scnet: ScnetExportLookup = DEFAULT_SCNET_EXPORT,
): BuiltExportPayload {
  // Kecepatan RENDER, bukan kecepatan transport: mengubah kecepatan saat
  // mendengarkan tidak boleh diam-diam mengubah kecepatan file yang dihasilkan.
  // Keduanya sengaja jadi dua angka terpisah di store.
  const speed = state.renderSpeed > 0 ? state.renderSpeed : 1;
  /** Kunci = id UI; `assetId` di dalamnya id padat untuk engine. */
  const assets = new Map<string, ExportAssetInfo>();
  type Source =
    | { readonly kind: 'original'; readonly assetId: number }
    | { readonly kind: 'scnet'; readonly audio: AutoStemAudio; readonly mask: AutoStemMask };
  const sources = new Map<number, Source>();

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
  const denseId = new Map<string, number>();
  const toDense = (key: string): number => {
    let d = denseId.get(key);
    if (d === undefined) {
      d = denseId.size;
      denseId.set(key, d);
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
    const flat = lane.clips.flatMap((original) =>
      expandLoopClip(original, lane.speedRatio, state.sampleRate, (i) => `${original.id}~loop${i}`)
        .map((clip) => ({ clip, originalId: original.id })),
    );
    const clips = flat.flatMap(({ clip, originalId }) => {
      const buf = getBuffer(clip.assetId);
      if (buf === undefined) return [];
      const audio = scnet.getAudio(clip.assetId);
      const mask = scnet.getMask(originalId);
      const useScnet = audio !== undefined && audio.bufferedFrames >= audio.frames && !isFullStemMask(mask);
      const maskKey = useScnet
        ? `${Number(mask.vocals)}${Number(mask.drums)}${Number(mask.bass)}${Number(mask.other)}`
        : '';
      const key = useScnet ? `scnet:${clip.assetId}:${maskKey}` : `asset:${clip.assetId}`;
      const dense = toDense(key);
      if (!assets.has(key)) {
        const info = useScnet
          ? {
              assetId: dense,
              channels: 2,
              frames: audio.frames,
              sampleRate: audio.sampleRate,
              // SCNet memproses chunk independen; hanya PCM turunannya yang
              // otomatis dibersihkan. Asset original tetap bit-identik.
              autoDeclick: true,
            }
          : {
              assetId: dense,
              channels: Math.max(1, buf.numberOfChannels),
              frames: buf.length,
              sampleRate: buf.sampleRate,
            };
        assets.set(key, info);
        sources.set(dense, useScnet
          ? { kind: 'scnet', audio, mask }
          : { kind: 'original', assetId: clip.assetId });
      }
      const exportAsset = assets.get(key)!;
      return [{ clip, dense, useScnet, exportSampleRate: exportAsset.sampleRate }];
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
      clips: clips.map(({ clip: c, dense, useScnet, exportSampleRate }) => ({
        id: c.id,
        // Dikirim walau engine belum bisa memprosesnya. Sebelum ini, stem
        // terdengar di preview dan hilang dari file TANPA satu pun peringatan
        // — `map_project` sekarang bisa mengatakannya karena datanya sampai.
        // Preview memilih SCNet ATAU stem mid/side, bukan keduanya. Jangan
        // menerapkan REMOVE klasik lagi di atas PCM SCNet yang sudah dipisah.
        stem: useScnet || c.stem === undefined ? null : { ...c.stem },
        chain: c.chain.map((fx) => ({
          kind: fx.kind,
          enabled: fx.enabled,
          params: { ...fx.params },
        })),
        assetId: dense,
        start: c.start,
        len: c.len,
        // `AudioBufferSourceNode.start()` milik preview menerima DETIK. Preview
        // mengubah koordinat source project menjadi detik lewat
        // `sourceStart / projectRate`; AudioBuffer lalu membacanya pada rate
        // milik buffer. Asset export bisa berbeda rate (terutama SCNet yang
        // selalu 44,1 kHz), sedangkan engine menerima indeks FRAME langsung.
        // Karena itu offset harus masuk ke ruang frame asset export:
        //
        //   sourceStart / projectRate * exportAssetRate
        //
        // Tanpa konversi ini laju playback sudah benar, tetapi clip hasil
        // trim/slip/seek/loop mulai dari materi yang berbeda dari preview.
        sourceStart: c.sourceStart * (exportSampleRate / Math.max(1, state.sampleRate)),
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

  const originalPcm = audioBufferPcmSource(getBuffer, (dense) => {
    const source = sources.get(dense);
    return source?.kind === 'original' ? source.assetId : undefined;
  });
  let scnetStaging = new Float32Array(PCM_CHUNK_FRAMES);
  let stemStaging = new Float32Array(PCM_CHUNK_FRAMES);
  const pcm: ExportAssetSource = (req) => {
    const source = sources.get(req.asset.assetId);
    if (source?.kind !== 'scnet') return originalPcm(req);
    const n = Math.min(req.maxFrames, Math.max(0, source.audio.frames - req.offset));
    if (n <= 0) return EMPTY_PCM;
    if (scnetStaging.length < n) scnetStaging = new Float32Array(n);
    const out = scnetStaging.subarray(0, n);
    out.fill(0);
    for (const stem of ['vocals', 'drums', 'bass', 'other'] as const) {
      if (!source.mask[stem]) continue;
      const buffer = source.audio.stems[stem];
      if (stemStaging.length < n) stemStaging = new Float32Array(n);
      const part = stemStaging.subarray(0, n);
      if (typeof buffer.copyFromChannel === 'function') {
        buffer.copyFromChannel(part, req.channel, req.offset);
      } else {
        part.set(buffer.getChannelData(req.channel).subarray(req.offset, req.offset + n));
      }
      for (let i = 0; i < n; i += 1) out[i] = (out[i] ?? 0) + (part[i] ?? 0);
    }
    return out;
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
