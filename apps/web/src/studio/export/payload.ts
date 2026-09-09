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
} from '../../stem/auto-stem';

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
  /** Jalankan pass Rust auto de-click setelah seluruh PCM selesai disalin. */
  readonly autoDeclick?: boolean;
}

/** Satu permintaan potongan PCM: channel `channel`, mulai frame `offset`. */
export interface ExportPcmRequest {
  readonly asset: ExportAssetInfo;
  readonly channel: number;
  /** Frame pertama yang diminta, relatif terhadap awal asset. */
  readonly offset: number;
  /** Batas atas panjang potongan. Boleh dijawab lebih pendek, tidak lebih panjang. */
  readonly maxFrames: number;
}

/**
 * Sumber PCM — dijawab SEPOTONG demi SEPOTONG, bukan sekaligus satu asset.
 *
 * Dulu bentuknya `(info) => Float32Array[]`: satu panggilan menyerahkan seluruh
 * channel satu asset. Untuk sumber yang kebetulan sudah memegang datanya
 * (`AudioBuffer.getChannelData` mengembalikan view) itu gratis, tapi untuk
 * sumber mana pun yang harus MENYALIN dulu — lintas `postMessage` dari worker,
 * atau `copyFromChannel` yang menghindari salinan permanen di heap JS (lihat
 * `audioBufferPcmSource`) — bentuk itu memaksa satu asset penuh berwujud di
 * heap JS sekaligus. Satu lane 28 menit stereo = 610 MiB, di samping salinan
 * yang sama yang sedang ditulis ke linear memory.
 *
 * Dengan potongan, sumber yang menyalin cukup memakai satu buffer antara
 * sebesar [`PCM_CHUNK_FRAMES`] dan memakainya ulang. Sumber yang tidak perlu
 * menyalin tinggal mengembalikan `subarray` — tetap tanpa salinan.
 *
 * Boleh mengembalikan Promise: jalur worker menunggu potongannya datang dari
 * main thread.
 *
 * Yang dikembalikan boleh berupa view ke penyimpanan milik orang lain (termasuk
 * buffer antara yang dipakai ulang) — pemanggil hanya membacanya, dan
 * membacanya selesai sebelum permintaan berikutnya.
 *
 * Sengaja BUKAN bagian dari [`ExportPayload`]: payload harus tetap bisa
 * menyeberang `postMessage` ke worker export, dan fungsi tidak bisa
 * di-structured-clone.
 */
export type ExportAssetSource = (
  req: ExportPcmRequest,
) => Float32Array | Promise<Float32Array>;

/**
 * Panjang potongan PCM (frame) — 1 MiB per potong untuk f32.
 *
 * Besarnya tidak kritis: ia hanya menentukan berapa banyak PCM yang berwujud di
 * heap JS sekaligus untuk sumber yang menyalin. Cukup besar supaya biaya per
 * panggilan tidak terasa, cukup kecil supaya angkanya tidak pernah muncul di
 * pengukuran memori.
 */
export const PCM_CHUNK_FRAMES = 1 << 18;

const EMPTY_PCM = new Float32Array(0);

/**
 * Adapter: sumber yang memberi SELURUH channel satu asset → sumber berpotongan.
 *
 * Ada untuk pemanggil yang memang sudah memegang datanya di memori (tes, dan
 * jalur mana pun yang menerima PCM apa adanya). `get` dipanggil SEKALI per
 * asset — potongan berikutnya dilayani dari hasil yang sama — jadi ia tidak
 * mengubah biaya sumber yang tidak menyalin.
 */
export function pcmFromChannels(
  get: (info: ExportAssetInfo) => readonly Float32Array[],
): ExportAssetSource {
  let cachedId: number | null = null;
  let cached: readonly Float32Array[] = [];
  return (req: ExportPcmRequest): Float32Array => {
    if (cachedId !== req.asset.assetId) {
      cached = get(req.asset);
      cachedId = req.asset.assetId;
      if (cached.length < req.asset.channels) {
        throw new Error(
          `Asset ${req.asset.assetId}: sumber memberi ${cached.length} channel, ` +
            `butuh ${req.asset.channels}.`,
        );
      }
    }
    const src = cached[req.channel] as Float32Array | undefined;
    if (src === undefined) return EMPTY_PCM;
    if (req.offset >= src.length) return EMPTY_PCM;
    const end = Math.min(src.length, req.offset + req.maxFrames);
    return src.subarray(req.offset, end);
  };
}

/**
 * Sumber PCM dari cache `AudioBuffer` preview — TANPA `getChannelData`.
 *
 * `getChannelData` memang mengembalikan view, bukan salinan, jadi di atas
 * kertas ia yang paling murah. Di Gecko ia tidak gratis: `AudioBuffer` hasil
 * `decodeAudioData` menyimpan datanya di luar heap JS, dan permintaan pertama
 * lewat `getChannelData` MEMBANGKITKAN salinan JS penuh per channel yang lalu
 * menempel pada buffer itu selama ia hidup. Untuk export, harganya adalah satu
 * salinan permanen dari SELURUH audio project — muncul saat export berjalan dan
 * tidak pernah kembali sesudahnya.
 *
 * `copyFromChannel` membaca dari penyimpanan yang sama tanpa membangkitkan
 * salinan itu. Ia butuh tujuan, jadi di sini ada satu buffer antara sebesar
 * satu potongan yang dipakai ulang untuk semua channel semua asset.
 *
 * Tujuannya TIDAK boleh view ke linear memory di jalur mt: `copyFromChannel`
 * menolak view di atas `SharedArrayBuffer` (sama seperti
 * `getFloatTimeDomainData`, lihat audio-preview.ts). Karena itu potongannya
 * lewat buffer antara ini, bukan langsung ke tujuan akhir.
 */
export function audioBufferPcmSource(getBuffer: BufferLookup, uiIdOf: (dense: number) => number | undefined): ExportAssetSource {
  // `ArrayBuffer` eksplisit, bukan `Float32Array` polos: `copyFromChannel`
  // menolak view di atas `SharedArrayBuffer`, dan tipe polosnya ikut memuat
  // kemungkinan itu (sama seperti `masterTapBuf` di audio-preview.ts).
  let staging: Float32Array<ArrayBuffer> | null = null;
  return (req: ExportPcmRequest): Float32Array => {
    const uiId = uiIdOf(req.asset.assetId);
    const buf = uiId === undefined ? undefined : getBuffer(uiId);
    if (buf === undefined) {
      // Bisa terjadi kalau cache preview dibuang di tengah export. Diam-diam
      // melewatinya berarti file hasilnya senyap di bagian itu tanpa penjelasan.
      throw new Error(
        `PCM asset ${req.asset.assetId} hilang dari cache preview saat export berjalan.`,
      );
    }
    if (req.channel >= buf.numberOfChannels) {
      throw new Error(
        `Asset ${req.asset.assetId}: sumber memberi ${buf.numberOfChannels} channel, ` +
          `butuh ${req.asset.channels}.`,
      );
    }
    const n = Math.min(req.maxFrames, Math.max(0, buf.length - req.offset));
    if (n <= 0) return EMPTY_PCM;
    // Jalur lama tetap dipakai kalau `copyFromChannel` tidak ada (jsdom, dan
    // implementasi Web Audio yang lebih tua). Ia benar — hanya lebih mahal.
    if (typeof buf.copyFromChannel !== 'function') {
      return buf.getChannelData(req.channel).subarray(req.offset, req.offset + n);
    }
    if (staging === null || staging.length < n) staging = new Float32Array(Math.max(n, PCM_CHUNK_FRAMES));
    const dest = staging.subarray(0, n);
    buf.copyFromChannel(dest, req.channel, req.offset);
    return dest;
  };
}

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
