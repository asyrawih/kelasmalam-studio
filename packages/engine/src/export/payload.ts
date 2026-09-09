/**
 * BENTUK payload export dan sumber PCM-nya — bagian pipeline export yang tidak
 * tahu apa-apa tentang state Studio (docs/25 P3, cicilan P4 `studio-core`).
 *
 * Yang MENYUSUN payload dari `StudioState` (`buildExportPayload`) tetap di
 * `@kelasmalam/studio/studio/export/payload`; yang ada di sini hanya tipe
 * yang harus dimengerti `run-export.ts` dan `audio/export-worker.ts` —
 * keduanya milik engine, dan engine tidak boleh mengimpor studio.
 *
 * Yang TIDAK dikirim: fungsi. Payload harus bisa menyeberang `postMessage` ke
 * worker export, jadi sumber PCM (`ExportAssetSource`) sengaja terpisah dari
 * `ExportPayload`.
 */

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

/** Potongan kosong = "sumbernya habis"; satu objek bersama, tidak pernah ditulis. */
export const EMPTY_PCM = new Float32Array(0);

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
