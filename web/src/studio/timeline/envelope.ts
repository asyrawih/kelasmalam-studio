/**
 * Peak pyramid untuk waveform — SATU implementasi yang dipakai import,
 * pemulihan dari IndexedDB, dan semua penggambar canvas.
 *
 * Bentuknya mengikuti docs/06 §6c: bucket 64 / 512 / 4096 sample, tiap bucket
 * menyimpan `min`, `max`, dan `rms`. Tiga hal yang perlu dijelaskan:
 *
 * 1. KENAPA PYRAMID, BUKAN SATU RESOLUSI TETAP. Versi lama membuat 2048 bucket
 *    untuk file apa pun. Lagu 162 detik berarti ~79 ms per bucket; di master
 *    yang keras hampir setiap bucket memuat puncak ~1.0, jadi setiap batang
 *    mentok dan waveform-nya jadi persegi panjang rata. Bucket 64 sample
 *    (~1,3 ms) menyimpan transien; level yang lebih kasar hanya dipakai saat
 *    zoom memang tidak membutuhkan detail itu.
 *
 * 2. KENAPA min/max TERPISAH, BUKAN abs-peak. Satu kolom pixel menggambarkan
 *    rentang yang benar-benar ditempuh sinyal. `abs` memaksa simetri palsu —
 *    vokal dan brass yang asimetris terlihat salah. `rms` disimpan TERPISAH
 *    sebagai badan yang lebih terang di dalam outline: outline = transien,
 *    badan = energi. Satu saja tidak cukup untuk membedakan bagian sunyi dari
 *    bagian keras yang sama-sama menyentuh puncak.
 *
 * 3. KENAPA LEVEL ATAS DIBANGUN DARI LEVEL BAWAH. `min(min(a),min(b))` sama
 *    persis dengan `min(a∪b)`, jadi level 1 & 2 tidak butuh pass baru melewati
 *    PCM: totalnya ~1,14 × N, bukan 3 × N.
 *
 * 4. KENAPA TIAP BUCKET JUGA MENYIMPAN TIGA PUNCAK PITA. Waveform monokrom
 *    hanya menjawab "seberapa keras"; yang dicari mata DJ adalah "keras KARENA
 *    APA" — kick, vokal, atau hi-hat. Rekordbox menjawab itu dengan warna, dan
 *    warnanya bukan hiasan: ia satu-satunya cara mengenali intro tanpa kick,
 *    breakdown, dan drop dari sudut mata sambil tangan sedang di jog. Karena
 *    itu tiap bucket menyimpan `low`/`mid`/`high` = |puncak| sinyal setelah
 *    dipisah crossover (di bawah), dan penggambar tinggal memetakannya ke
 *    tiga warna. Pemisahannya dilakukan DI SINI, sekali saat import, karena
 *    memfilter ulang 17 juta sample tiap kali user scroll jelas mustahil.
 *
 * Memori (diukur, 3 menit stereo @48k = 8,64 juta frame per channel):
 * level 0 = 135.000 bucket × 6 × 4 B = 3,24 MB; level 1+2 menambah ~14% →
 * terukur 3,70 MB per asset (0,428 B per frame). Tiga larik pita menggandakannya
 * dari 1,76 MB versi monokrom — dan itu tetap ~19 × lebih kecil dari PCM-nya
 * sendiri (~69 MB), yang membuat harganya tidak pernah jadi bahan pertimbangan.
 *
 * KENAPA TIDAK DI WORKER: `buildEnvelope` untuk file 3 menit stereo terukur
 * 76 ms (Apple Silicon, satu pass melewati 17,3 juta sample; 49 ms sebelum
 * pemisahan pita ditambahkan). Ia berjalan
 * tepat setelah `decodeAudioData`, yang untuk file yang sama makan waktu jauh
 * lebih lama dan memang sudah asinkron; memindahkan 49 ms ini ke worker berarti
 * men-transfer PCM keluar-masuk — ongkos salin yang sebanding dengan kerjanya
 * sendiri. Kalau nanti import berpindah ke `audio/import-worker`, pyramid
 * dibangun di Rust di sana dan fungsi ini tinggal membungkus hasilnya.
 */

/** Ukuran bucket per level, dalam sample. Faktor 8 antar level (docs/06 §6c). */
export const BUCKET_SIZES = [64, 512, 4096] as const;

/**
 * Titik potong crossover, Hz. `low` = di bawah `LOW_HZ`, `mid` = di antara,
 * `high` = di atas `HIGH_HZ`.
 *
 * 200 Hz memisahkan kick + bassline dari badan lagu: fundamental kick klub ada
 * di 40–100 Hz dan harmonik keduanya masih di bawah 200. Menaikkannya ke 300
 * menarik badan snare dan nada rendah vokal pria ikut membiru, dan waveform-nya
 * berhenti berkata "ini bagian yang punya kick".
 *
 * 2 kHz memisahkan hi-hat, ride, dan konsonan dari nada. Fundamental vokal dan
 * hampir semua nada instrumen ada di bawahnya, jadi pita atas berisi hampir
 * murni transien perkusi tinggi — persis yang bikin bagian yang "berdesir"
 * kelihatan putih. Menurunkannya ke 1 kHz membuat setiap vokal ikut memutih.
 */
export const LOW_HZ = 200;
export const HIGH_HZ = 2000;

/** Sample rate yang dipakai kalau sumbernya tidak menyebutkan — hanya
 *  mempengaruhi lebar pita, bukan bentuk min/max. */
const FALLBACK_SR = 48000;

/**
 * Koefisien satu kutub untuk lowpass `fc`: `y += a · (x − y)`.
 *
 * Dipakai DUA KALI bertingkat per crossover (12 dB/okt). Kenapa tidak satu
 * kutub saja: dengan 6 dB/okt, sebuah kick 60 Hz masih menyumbang ~-10 dB ke
 * pita mid, jadi bagian yang cuma punya kick tetap ikut menyala oranye dan
 * warnanya berhenti membedakan apa pun. Kenapa tidak biquad Linkwitz-Riley
 * yang benar: ia butuh state ganda + koefisien per pita di loop yang berjalan
 * puluhan juta kali, sementara yang dibutuhkan di sini bukan crossover yang
 * datar-jumlahnya, melainkan pemisahan yang cukup untuk MEWARNAI satu batang
 * setinggi 40 px.
 */
function onePole(fc: number, sampleRate: number): number {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : FALLBACK_SR;
  return 1 - Math.exp((-2 * Math.PI * fc) / sr);
}

/** Sumber PCM. `AudioBuffer` memenuhi bentuk ini secara struktural, sehingga
 *  tes bisa memberi sinyal sintetis tanpa Web Audio. */
export interface PcmSource {
  readonly numberOfChannels: number;
  readonly length: number;
  /** Dibutuhkan crossover pita. `AudioBuffer` selalu punya; sumber sintetis di
   *  tes boleh menghilangkannya dan mendapat `FALLBACK_SR`. */
  readonly sampleRate?: number;
  getChannelData(channel: number): Float32Array;
}

export interface EnvelopeLevel {
  /** Jumlah sample per bucket di level ini. */
  readonly bucket: number;
  /** Nilai terendah sinyal di bucket, ≤ 0. */
  readonly min: Float32Array;
  /** Nilai tertinggi sinyal di bucket, ≥ 0. */
  readonly max: Float32Array;
  /** Akar rata-rata kuadrat di bucket, ≥ 0. */
  readonly rms: Float32Array;
  /** |Puncak| pita bawah (< {@link LOW_HZ}) di bucket, ≥ 0. */
  readonly low: Float32Array;
  /** |Puncak| pita tengah di bucket, ≥ 0. */
  readonly mid: Float32Array;
  /** |Puncak| pita atas (> {@link HIGH_HZ}) di bucket, ≥ 0. */
  readonly high: Float32Array;
}

export interface Envelope {
  /** Index 0 = paling halus (64 sample). */
  readonly levels: readonly EnvelopeLevel[];
  /** Jumlah frame source yang diwakili. */
  readonly frames: number;
}

/** Satu kolom hasil pembacaan. Pemanggil menyediakan buffer dan memakainya
 *  ulang tiap redraw — jalur gambar tidak boleh mengalokasi. */
export interface EnvelopeColumns {
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly rms: Float32Array;
  readonly low: Float32Array;
  readonly mid: Float32Array;
  readonly high: Float32Array;
}

export function allocColumns(width: number): EnvelopeColumns {
  const n = Math.max(0, Math.floor(width));
  return {
    min: new Float32Array(n),
    max: new Float32Array(n),
    rms: new Float32Array(n),
    low: new Float32Array(n),
    mid: new Float32Array(n),
    high: new Float32Array(n),
  };
}

/**
 * Gabungan channel untuk tampilan: `min` = terendah lintas channel, `max` =
 * tertinggi lintas channel, `rms` = akar dari rata-rata kuadrat SEMUA sample di
 * semua channel (mean-square, bukan rata-rata rms per channel — yang kedua
 * meremehkan energi saat channel-nya tidak seimbang). `low`/`mid`/`high` =
 * |puncak| tertinggi lintas channel pada masing-masing pita.
 *
 * Pita dihitung DI DALAM pass yang sama, bukan di pass tersendiri: filter-nya
 * berjalan atas sample yang barusan dibaca, jadi ongkos tambahannya murni
 * aritmetika (enam kutub + tiga perbandingan per sample) tanpa satu pun
 * pembacaan memori baru. Satu pass terpisah per pita akan membaca PCM tiga kali
 * lagi — dan pembacaan memori itulah, bukan perkaliannya, yang mahal di sini.
 *
 * Kita sengaja TIDAK menggambar per-channel lane: tinggi clip di timeline 88 px
 * dan membaginya dua membuat kedua waveform terlalu pendek untuk dibaca.
 */
export function buildEnvelope(pcm: PcmSource): Envelope {
  const frames = Math.max(0, pcm.length);
  const levels: EnvelopeLevel[] = [];

  // ---- Level 0: satu-satunya yang menyentuh raw sample.
  const bucket0 = BUCKET_SIZES[0];
  const count0 = Math.max(1, Math.ceil(frames / bucket0));
  const min0 = new Float32Array(count0);
  const max0 = new Float32Array(count0);
  const rms0 = new Float32Array(count0);
  const low0 = new Float32Array(count0);
  const mid0 = new Float32Array(count0);
  const high0 = new Float32Array(count0);
  // f64 untuk akumulasi: menjumlahkan 64 × N kuadrat di f32 kehilangan presisi
  // pada material yang sunyi, dan hasilnya rms yang "menempel" di nol.
  const sumSq = new Float64Array(count0);
  const channels = Math.max(0, pcm.numberOfChannels);
  // Bucket selalu pangkat dua, jadi index bucket = geser bit — bukan pembagian,
  // di loop yang berjalan puluhan juta kali. Diturunkan dari BUCKET_SIZES[0]
  // supaya mengubah konstanta itu tidak diam-diam merusak indexing.
  const shift0 = Math.log2(bucket0);

  const aLow = onePole(LOW_HZ, pcm.sampleRate ?? FALLBACK_SR);
  const aHigh = onePole(HIGH_HZ, pcm.sampleRate ?? FALLBACK_SR);

  for (let ch = 0; ch < channels; ch += 1) {
    const data = pcm.getChannelData(ch);
    const n = Math.min(frames, data.length);
    // State filter di-reset per channel — kalau dibawa lintas channel, sample
    // pertama channel kanan "mengingat" sample terakhir channel kiri.
    let lo1 = 0;
    let lo2 = 0;
    let mh1 = 0;
    let mh2 = 0;
    let ml1 = 0;
    let ml2 = 0;
    let hi1 = 0;
    let hi2 = 0;
    for (let i = 0; i < n; i += 1) {
      const b = i >> shift0;
      const v = data[i] ?? 0;
      if (v < min0[b]!) min0[b] = v;
      if (v > max0[b]!) max0[b] = v;
      sumSq[b]! += v * v;

      // Tiga filter TERPISAH, bukan satu lowpass yang diselisihkan.
      //
      // Versi selisih (`mid = lp2k − lp200`) sekilas lebih murah dan punya sifat
      // manis "low + mid + high == v", tapi ia salah untuk keperluan ini: dua
      // lowpass menggeser FASA secara berbeda, jadi selisihnya tidak pernah
      // nol meski isinya cuma satu nada. Terukur pada sinus 60 Hz murni:
      // low 0,92 tapi mid 0,50 — sebuah kick tanpa apa pun di atasnya
      // menggambar oranye setinggi 55% dari birunya, dan warnanya berhenti
      // berarti. Highpass sungguhan (`x − lowpass` satu kutub, ditumpuk dua
      // kali) menurunkan angka itu ke 0,09.
      //
      // low = LP2 @ LOW_HZ.
      lo1 += aLow * (v - lo1);
      lo2 += aLow * (lo1 - lo2);
      // mid = HP2 @ LOW_HZ → LP2 @ HIGH_HZ.
      mh1 += aLow * (v - mh1);
      const mhA = v - mh1;
      mh2 += aLow * (mhA - mh2);
      const mhB = mhA - mh2;
      ml1 += aHigh * (mhB - ml1);
      ml2 += aHigh * (ml1 - ml2);
      // high = HP2 @ HIGH_HZ.
      hi1 += aHigh * (v - hi1);
      const hA = v - hi1;
      hi2 += aHigh * (hA - hi2);
      const hB = hA - hi2;

      const l = lo2 < 0 ? -lo2 : lo2;
      const ma = ml2 < 0 ? -ml2 : ml2;
      const ha = hB < 0 ? -hB : hB;
      if (l > low0[b]!) low0[b] = l;
      if (ma > mid0[b]!) mid0[b] = ma;
      if (ha > high0[b]!) high0[b] = ha;
    }
  }

  for (let b = 0; b < count0; b += 1) {
    const lo = b * bucket0;
    const hi = Math.min(frames, lo + bucket0);
    const n = Math.max(0, hi - lo) * channels;
    // Bucket kosong (asset nol frame) → 0, bukan NaN dari 0/0.
    rms0[b] = n > 0 ? Math.sqrt(sumSq[b]! / n) : 0;
  }
  levels.push({
    bucket: bucket0,
    min: min0,
    max: max0,
    rms: rms0,
    low: low0,
    mid: mid0,
    high: high0,
  });

  // ---- Level di atasnya: agregasi dari level sebelumnya.
  for (let li = 1; li < BUCKET_SIZES.length; li += 1) {
    const bucket = BUCKET_SIZES[li]!;
    const prev = levels[li - 1]!;
    const ratio = bucket / prev.bucket;
    const count = Math.max(1, Math.ceil(frames / bucket));
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    const rms = new Float32Array(count);
    const low = new Float32Array(count);
    const mid = new Float32Array(count);
    const high = new Float32Array(count);
    const prevCount = prev.min.length;
    for (let i = 0; i < count; i += 1) {
      let lo = 0;
      let hi = 0;
      let sq = 0;
      let used = 0;
      let bl = 0;
      let bm = 0;
      let bh = 0;
      for (let k = 0; k < ratio; k += 1) {
        const j = i * ratio + k;
        if (j >= prevCount) break;
        if (prev.min[j]! < lo) lo = prev.min[j]!;
        if (prev.max[j]! > hi) hi = prev.max[j]!;
        sq += prev.rms[j]! * prev.rms[j]!;
        // Puncak pita: max dari max — EKSAK, sama seperti min/max, jadi
        // warna di zoom jauh tidak pernah menyimpang dari warna di zoom dekat.
        if (prev.low[j]! > bl) bl = prev.low[j]!;
        if (prev.mid[j]! > bm) bm = prev.mid[j]!;
        if (prev.high[j]! > bh) bh = prev.high[j]!;
        used += 1;
      }
      min[i] = lo;
      max[i] = hi;
      low[i] = bl;
      mid[i] = bm;
      high[i] = bh;
      // Rata-rata kuadrat dari anak-anaknya. Eksak selama bucket anak penuh;
      // bucket terakhir (yang mungkin parsial) sedikit over-weighted, dan itu
      // perbedaan di bawah satu pixel di ujung asset.
      rms[i] = used > 0 ? Math.sqrt(sq / used) : 0;
    }
    levels.push({ bucket, min, max, rms, low, mid, high });
  }

  return { levels, frames };
}

/**
 * Level yang dipakai untuk `samplesPerPixel`. Kita memilih level TERKASAR yang
 * masih memberi ≥ 1 bucket per pixel, supaya jumlah bucket yang dibaca per
 * pixel tetap 1–8 berapa pun zoom-nya.
 */
export function levelFor(samplesPerPixel: number): number {
  if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 0) return 0;
  for (let li = BUCKET_SIZES.length - 1; li >= 0; li -= 1) {
    if (samplesPerPixel >= BUCKET_SIZES[li]!) return li;
  }
  return 0;
}

/**
 * Isi `out` untuk rentang source `[from, from + len)` pada lebar `width` kolom.
 *
 * Clip yang di-speed-up TIDAK butuh pyramid baru: `width` mengecil karena
 * `len_timeline = source_len / ratio`, sehingga `samplesPerPixel` naik dan
 * pembacaan otomatis men-*stride* pyramid dengan faktor ratio (docs/06 §6c).
 * Tidak ada regenerasi, tidak ada invalidasi.
 */
export function readEnvelope(
  env: Envelope,
  from: number,
  len: number,
  width: number,
  out: EnvelopeColumns,
): void {
  const w = Math.min(Math.floor(width), out.min.length);
  if (w <= 0) return;
  // Rentang tak masuk akal (asset kosong / clip nol) → nol, bukan NaN.
  if (!(len > 0) || env.frames <= 0) {
    out.min.fill(0, 0, w);
    out.max.fill(0, 0, w);
    out.rms.fill(0, 0, w);
    out.low.fill(0, 0, w);
    out.mid.fill(0, 0, w);
    out.high.fill(0, 0, w);
    return;
  }

  const level = env.levels[levelFor(len / w)] ?? env.levels[0]!;
  const { bucket, min: lmin, max: lmax, rms: lrms, low: llow, mid: lmid, high: lhigh } = level;
  const buckets = lmin.length;

  for (let px = 0; px < w; px += 1) {
    const s0 = from + (px * len) / w;
    const s1 = from + ((px + 1) * len) / w;
    const b0 = Math.max(0, Math.floor(s0 / bucket));
    const b1 = Math.min(buckets - 1, Math.max(b0, Math.ceil(s1 / bucket) - 1));
    let lo = 0;
    let hi = 0;
    let sq = 0;
    let used = 0;
    let bl = 0;
    let bm = 0;
    let bh = 0;
    for (let b = b0; b <= b1; b += 1) {
      if (lmin[b]! < lo) lo = lmin[b]!;
      if (lmax[b]! > hi) hi = lmax[b]!;
      sq += lrms[b]! * lrms[b]!;
      if (llow[b]! > bl) bl = llow[b]!;
      if (lmid[b]! > bm) bm = lmid[b]!;
      if (lhigh[b]! > bh) bh = lhigh[b]!;
      used += 1;
    }
    out.min[px] = lo;
    out.max[px] = hi;
    out.rms[px] = used > 0 ? Math.sqrt(sq / used) : 0;
    out.low[px] = bl;
    out.mid[px] = bm;
    out.high[px] = bh;
  }
}

/** Puncak absolut satu rentang source — dibaca dari level terkasar, karena
 *  agregasi min/max eksak sehingga hasilnya sama dengan level 0. */
export function envelopePeak(env: Envelope, from: number, len: number): number {
  const level = env.levels[env.levels.length - 1] ?? env.levels[0]!;
  if (level === undefined || !(len > 0)) return 0;
  const b0 = Math.max(0, Math.floor(from / level.bucket));
  const b1 = Math.min(level.min.length - 1, Math.ceil((from + len) / level.bucket) - 1);
  let peak = 0;
  for (let b = b0; b <= b1; b += 1) {
    peak = Math.max(peak, Math.abs(level.min[b]!), Math.abs(level.max[b]!));
  }
  return peak;
}

/** Total byte yang dipakai sebuah envelope — untuk log/diagnostik, bukan UI. */
export function envelopeBytes(env: Envelope): number {
  return env.levels.reduce(
    (n, l) =>
      n +
      l.min.byteLength +
      l.max.byteLength +
      l.rms.byteLength +
      l.low.byteLength +
      l.mid.byteLength +
      l.high.byteLength,
    0,
  );
}
