/**
 * Penggambar waveform di canvas.
 *
 * KENAPA CANVAS, BUKAN `<div>` PER BATANG. Versi lama membuat 44 div per clip
 * dan 260 div untuk panel detail. Itu memberi batas keras pada kerapatan
 * (satu batang tidak bisa lebih tipis dari satu elemen + gap), dan — lebih
 * penting — sebuah div hanya punya SATU tinggi, sehingga envelope min/max yang
 * asimetris tidak bisa digambar sama sekali. Canvas menggambar satu kolom per
 * DEVICE pixel, jadi detailnya ikut naik saat user zoom.
 *
 * Bentuk yang digambar, dari luar ke dalam:
 *   1. outline min/max — poligon terisi, dicerminkan pada garis tengah;
 *   2. badan RMS — bentuk yang sama tapi lebih terang/pekat, selalu di dalam
 *      outline. Ini yang membuat bagian sunyi terlihat sunyi meskipun
 *      transiennya menyentuh puncak.
 *
 * VIRTUALISASI. Penggambar menerima `win` opsional: bagian mana dari lebar
 * penuh yang benar-benar punya canvas di bawahnya. `width` tetap lebar penuh
 * clip, jadi pemetaan sample→pixel tidak berubah saat user menggulir — hanya
 * kolom yang tidak terlihat yang berhenti dihitung. Alasan lengkapnya, termasuk
 * batas dimensi canvas browser yang dulu terlewat pada lagu panjang, ada di
 * `wave-window.ts`.
 *
 * MODE PITA (`WaveStyle.bands`). Kalau style membawa tiga warna, dua lapis di
 * atas diganti TIGA lapis — satu per pita frekuensi, digambar dari yang paling
 * tinggi ke yang paling pendek (low → mid → high). Hasilnya bacaan yang sama
 * dengan waveform berwarna Rekordbox: tepi biru = kick/bass, badan oranye =
 * vokal dan badan lagu, inti putih = hi-hat dan desis. Lihat `envelope.ts` §4
 * untuk alasan datanya dihitung saat import, dan `BAND_GAIN` di bawah untuk
 * alasan tiap pita punya penguatan tampilannya sendiri.
 */

import type { StudioAsset } from '../store';
import { loopTileCount } from './clip-loop';
import { allocColumns, readEnvelope, type EnvelopeColumns } from './envelope';
import type { WaveWindow } from './wave-window';

/** Buffer kolom yang dipakai ulang lintas semua canvas. Menggambar tidak boleh
 *  mengalokasi: pada zoom/scroll fungsi ini terpanggil puluhan kali per gerakan.
 *
 *  Ia hanya TUMBUH, tidak pernah menyusut — dan itu aman justru karena
 *  virtualisasi: sejak clip timeline hanya menggambar jendela yang terlihat
 *  (lihat `wave-window.ts`), jumlah kolom terbesar yang pernah diminta kira-kira
 *  selebar viewport dikali dpr, bukan selebar project. Sebelum itu, satu kali
 *  zoom pada lagu panjang bisa menumbuhkannya ke jutaan kolom dan menahan
 *  puluhan MB selama halaman hidup. */
let scratch: EnvelopeColumns = allocColumns(0);
function columnsFor(width: number): EnvelopeColumns {
  if (scratch.min.length < width) scratch = allocColumns(width);
  return scratch;
}

export interface WaveStyle {
  /** Warna outline min/max. Boleh gradien (panel Clip Detail). */
  readonly outline: string | CanvasGradient;
  /** Warna badan RMS. Kalau sama dengan outline, bedanya cuma opacity. */
  readonly body: string | CanvasGradient;
  readonly outlineAlpha: number;
  readonly bodyAlpha: number;
  /** Garis tengah; null = tidak digambar. */
  readonly centerLine: string | null;
  /**
   * Kalau ada, waveform digambar per pita frekuensi alih-alih outline + RMS.
   * `outline` tetap dipakai untuk placeholder saat asset-nya tidak ada.
   */
  readonly bands?: BandColors | null;
}

/** Tiga warna pita. Dipisah jadi tipe sendiri supaya tema bisa menggantinya di
 *  satu tempat, bukan di tiap pemanggil. */
export interface BandColors {
  readonly low: string;
  readonly mid: string;
  readonly high: string;
}

/**
 * Palet pita bawaan.
 *
 * Biru untuk bawah, amber untuk tengah, dan hijau untuk atas. Hijau membuat
 * hi-hat/transien tetap terang di background hitam tanpa berubah jadi bidang
 * putih yang bertabrakan dengan grid dan playhead.
 */
export const BAND_COLORS: BandColors = {
  low: '#2f6fe0',
  mid: '#ffb020',
  high: '#35e36f',
};

/**
 * Penguatan tampilan per pita.
 *
 * Bukan koreksi kosmetik: setelah crossover, energi materi musik turun tajam ke
 * atas (pita atas sebuah track master jarang melewati 0,2 puncak walau hi-hat-
 * nya jelas terdengar), dan filter satu kutub bertingkat sendiri hanya mencapai
 * ~0,75 pada sinus penuh di pita atas. Digambar apa adanya, pita atas jadi
 * garis setipis satu pixel dan warnanya berhenti memberi tahu apa pun.
 *
 * Batas atasnya keras dan sudah terbukti dari render uji: pada penguatan 3
 * setiap hi-hat MENTOK ke tinggi penuh, dan karena pita atas digambar terakhir,
 * hasilnya tembok putih yang menutupi biru dan amber sepenuhnya — warna yang
 * lebih buruk daripada tidak berwarna. Angka di bawah menaikkan pita atas
 * sampai terbaca tapi masih di bawah langit-langit pada materi normal.
 */
const BAND_GAIN = { low: 1, mid: 1.35, high: 1.7 } as const;

/**
 * Opacity per pita. Menurun ke atas, dan itu yang membuat tumpang-tindih
 * menjadi INFORMASI, bukan penutup: pita atas yang digambar terakhir masih
 * meloloskan amber dan biru di bawahnya, persis seperti low∩mid yang tampil
 * cokelat di rekordbox. Dengan tiga lapis buram, satu pita yang kebetulan
 * paling tinggi akan menghapus dua lainnya dari layar.
 */
const BAND_ALPHA = { low: 0.95, mid: 0.85, high: 0.78 } as const;

/** Gradien vertikal khas panel Clip Detail (#ffb020 → #ffd400 → #ffb020). */
export function clipDetailGradient(
  ctx: CanvasRenderingContext2D,
  height: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, '#ffb020');
  g.addColorStop(0.5, '#ffd400');
  g.addColorStop(1, '#ffb020');
  return g;
}

/**
 * Gambar envelope asset untuk rentang source `[from, from+len)`.
 *
 * `width`/`height` dalam CSS pixel (konteks sudah ter-skala dpr oleh
 * `useCanvasDraw`); `dpr` dipakai untuk menentukan JUMLAH kolom, supaya satu
 * kolom = satu device pixel.
 *
 * `win` menyatakan bagian mana dari `width` yang benar-benar punya canvas di
 * bawahnya (lihat `wave-window.ts`). `width` TETAP lebar penuh clip walaupun
 * `win` menyempit — itu yang membuat pemetaan sample→pixel tidak berubah saat
 * user menggulir, sehingga bentuk yang tergambar sama persis dengan versi
 * lebar-penuh. Titik asal konteks dianggap ada di `win.x`; pemanggil yang
 * memasang canvas di posisi itu tidak perlu men-translate apa pun.
 *
 * `win === null` berarti "gambar seluruh lebar" — dipakai panel Clip Detail dan
 * strip overview, yang canvas-nya memang tidak pernah lebih lebar dari layar.
 */
export function drawAssetWave(
  ctx: CanvasRenderingContext2D,
  asset: StudioAsset,
  from: number,
  len: number,
  width: number,
  height: number,
  dpr: number,
  style: WaveStyle,
  win: WaveWindow | null = null,
): void {
  // Canvas nol-ukuran (elemen belum di-layout, clip selebar 0%): tidak ada yang
  // bisa digambar dan semua pembagian di bawah akan menghasilkan NaN.
  if (!(width > 0) || !(height > 0)) return;

  const winX = win === null ? 0 : win.x;
  const winW = win === null ? width : win.w;
  // Jendela nol lebar bukan kesalahan — clip yang baru saja tergulir keluar
  // layar sah menghasilkannya. Yang salah adalah menggambarnya.
  if (!(winW > 0)) return;

  // Rentang source diiris dengan proporsi yang sama seperti jendelanya. Ini
  // satu-satunya tempat virtualisasi terjadi: sisa fungsi ini tidak tahu bahwa
  // ia sedang menggambar sepotong.
  const winFrom = from + (winX / width) * len;
  const winLen = (winW / width) * len;

  const cols = Math.max(1, Math.floor(winW * Math.max(1, dpr)));
  const cw = winW / cols;
  const cy = height / 2;
  const half = height / 2;
  const cs = columnsFor(cols);
  readEnvelope(asset.envelope, winFrom, winLen, cols, cs);

  if (style.centerLine !== null) {
    ctx.fillStyle = style.centerLine;
    ctx.fillRect(0, cy - 0.5, winW, 1);
  }

  // Outline: satu path yang menyusuri semua max lalu balik lewat semua min.
  // Satu `fill` untuk seluruh waveform — bukan satu per kolom — supaya biaya
  // gambar tetap konstan berapa pun kerapatannya.
  const paint = (
    values: (i: number) => { top: number; bottom: number },
    color: string | CanvasGradient,
    alpha: number,
  ): void => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < cols; i += 1) {
      const { top } = values(i);
      ctx.lineTo(i * cw, top);
      ctx.lineTo((i + 1) * cw, top);
    }
    for (let i = cols - 1; i >= 0; i -= 1) {
      const { bottom } = values(i);
      ctx.lineTo((i + 1) * cw, bottom);
      ctx.lineTo(i * cw, bottom);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  // Tinggi minimum 1 px: tanpa ini, bagian yang benar-benar sunyi hilang sama
  // sekali dan waveform-nya terlihat "putus", bukan sunyi.
  const clampAmp = (v: number): number => Math.min(1, Math.abs(v)) * half;

  if (style.bands != null) {
    // Urutan low → mid → high itu WAJIB, bukan selera: tiap lapis menimpa yang
    // sebelumnya, jadi yang digambar belakangan harus yang biasanya paling
    // pendek. Dibalik, pita bawah menutupi keduanya dan gambarnya jadi biru
    // polos — data lengkap, warna nihil.
    const layers = [
      { values: cs.low, color: style.bands.low, gain: BAND_GAIN.low, alpha: BAND_ALPHA.low },
      { values: cs.mid, color: style.bands.mid, gain: BAND_GAIN.mid, alpha: BAND_ALPHA.mid },
      { values: cs.high, color: style.bands.high, gain: BAND_GAIN.high, alpha: BAND_ALPHA.high },
    ] as const;
    for (const layer of layers) {
      paint(
        (i) => {
          const a = Math.max(0.5, clampAmp((layer.values[i] ?? 0) * layer.gain));
          return { top: cy - a, bottom: cy + a };
        },
        layer.color,
        // `bodyAlpha` tetap dihormati sebagai peredup KESELURUHAN — strip
        // overview memakainya untuk duduk lebih tenang di belakang penanda cue.
        layer.alpha * style.bodyAlpha,
      );
    }
    return;
  }

  paint(
    (i) => ({
      top: cy - Math.max(0.5, clampAmp(cs.max[i] ?? 0)),
      bottom: cy + Math.max(0.5, clampAmp(cs.min[i] ?? 0)),
    }),
    style.outline,
    style.outlineAlpha,
  );
  paint(
    (i) => {
      const r = Math.max(0.5, clampAmp(cs.rms[i] ?? 0));
      return { top: cy - r, bottom: cy + r };
    },
    style.body,
    style.bodyAlpha,
  );
}

/**
 * Gambar placeholder untuk clip yang asset-nya tidak ada (demo, atau file yang
 * gagal di-decode ulang saat project dipulihkan).
 *
 * Sengaja TIDAK menyerupai audio: garis putus-putus di tengah + arsir diagonal.
 * Versi lama memakai mock deterministik dari `clip.seed` yang terlihat persis
 * seperti waveform sungguhan — dan waveform palsu yang menyamar sebagai audio
 * nyata adalah bug yang paling mahal untuk ditemukan di UI editing.
 */
export function drawPlaceholderWave(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string | CanvasGradient,
): void {
  if (!(width > 0) || !(height > 0)) return;
  const cy = height / 2;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(width, cy);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.globalAlpha = 0.14;
  ctx.beginPath();
  const step = 8;
  for (let x = -height; x < width; x += step) {
    ctx.moveTo(x, height);
    ctx.lineTo(x + height, 0);
  }
  ctx.stroke();
  ctx.restore();
}

/** Pilih otomatis: envelope asli kalau asset-nya ada, kalau tidak placeholder. */
export function drawClipWave(
  ctx: CanvasRenderingContext2D,
  asset: StudioAsset | undefined,
  sourceStart: number,
  sourceLen: number,
  width: number,
  height: number,
  dpr: number,
  style: WaveStyle,
  win: WaveWindow | null = null,
): void {
  if (asset === undefined) {
    // Placeholder digambar selebar CANVAS-nya, bukan selebar clip: arsir
    // diagonal dan garis putus-putus tidak memetakan apa pun ke sample, jadi
    // tidak ada yang bisa melenceng, dan menggambarnya sepanjang clip penuh
    // justru mengembalikan biaya yang baru saja dihilangkan.
    drawPlaceholderWave(ctx, win === null ? width : win.w, height, style.outline);
    return;
  }
  drawAssetWave(ctx, asset, sourceStart, sourceLen, width, height, dpr, style, win);
}

/**
 * Lebar minimum satu ubin loop sebelum menggambarnya jadi sia-sia. Di bawah ini
 * satu putaran lebih tipis dari beberapa piksel dan yang tergambar bukan lagi
 * bentuk, melainkan derau.
 */
export const MIN_LOOP_TILE_PX = 3;
/** Seam digambar hanya kalau ubinnya cukup lebar untuk dilihat sebagai batas. */
const SEAM_MIN_TILE_PX = 8;

/**
 * Waveform clip yang LOOP: satu putaran, DIULANG, bukan materi yang memanjang.
 *
 * Ini bukan hiasan. Clip yang loop hanya membaca `[sourceStart, sourceStart +
 * loopLen)`, jadi menggambar `sourceLen` apa adanya akan menampilkan materi yang
 * TIDAK berbunyi — dan pada clip yang lebih panjang dari file-nya, sebagian
 * kotaknya bahkan kosong. Gambar yang tidak cocok dengan yang terdengar adalah
 * cacat yang paling mahal di UI editing (lihat `drawPlaceholderWave`).
 *
 * Biayanya tetap sebanding dengan LEBAR, bukan jumlah ubin: tiap ubin hanya
 * menggambar kolom sebanyak lebarnya sendiri.
 */
export function drawLoopedClipWave(
  ctx: CanvasRenderingContext2D,
  asset: StudioAsset | undefined,
  sourceStart: number,
  sourceLen: number,
  loopLen: number,
  width: number,
  height: number,
  dpr: number,
  style: WaveStyle,
  win: WaveWindow | null = null,
): void {
  if (asset === undefined) {
    drawPlaceholderWave(ctx, win === null ? width : win.w, height, style.outline);
    return;
  }
  if (!(width > 0) || !(height > 0) || !(loopLen > 0) || !(sourceLen > 0)) return;

  const winX = win === null ? 0 : win.x;
  const winW = win === null ? width : win.w;
  if (!(winW > 0)) return;

  const tiles = loopTileCount(sourceLen, loopLen);
  const tileW = (loopLen / sourceLen) * width;
  if (tiles <= 1 || tileW < MIN_LOOP_TILE_PX) {
    // Ubin sub-piksel: yang tergambar per putaran tidak akan terbaca berapa pun
    // usahanya. Satu putaran diregangkan sepanjang clip — materinya jujur
    // (memang itu yang berbunyi), hanya JUMLAH putarannya yang tidak terbaca,
    // dan pada kerapatan ini ia memang tidak pernah terbaca.
    drawAssetWave(ctx, asset, sourceStart, loopLen, width, height, dpr, style, win);
    return;
  }

  // Hanya ubin yang benar-benar tersentuh jendela. Tanpa batas ini, clip loop
  // sepanjang 27 menit tetap membayar satu iterasi per putaran walau canvas-nya
  // sudah sesempit viewport — jumlah putarannya bisa puluhan ribu.
  const first = Math.max(0, Math.floor(winX / tileW));
  const last = Math.min(tiles - 1, Math.ceil((winX + winW) / tileW) - 1);

  for (let i = first; i <= last; i++) {
    const tileLeft = i * tileW;
    // Ubin TERAKHIR hampir selalu terpotong di tengah putaran, persis seperti
    // bunyinya — loop berhenti di ujung clip, bukan di ujung putaran.
    const tileVisibleW = Math.min(tileW, width - tileLeft);
    if (!(tileVisibleW > 0)) break;
    // Irisan ubin ini yang jatuh di dalam jendela, dalam koordinat UBIN.
    const from = Math.max(0, winX - tileLeft);
    const to = Math.min(tileVisibleW, winX + winW - tileLeft);
    if (!(to > from)) continue;
    ctx.save();
    // Digeser ke posisi ubin RELATIF terhadap jendela — titik asal canvas ada
    // di `winX`, bukan di awal clip.
    ctx.translate(tileLeft + from - winX, 0);
    // `tileW` tetap lebar penuh satu putaran supaya pemetaan sample→pixel di
    // dalam ubin tidak berubah saat ubinnya terpotong tepi layar. Irisan yang
    // digambar dibatasi lewat jendela, bukan lewat `ctx.clip` — memotong
    // dengan clip tetap membayar seluruh kolom ubin, dan itulah biaya yang
    // sedang dihilangkan di sini.
    drawAssetWave(ctx, asset, sourceStart, loopLen, tileW, height, dpr, style, {
      x: from,
      w: to - from,
    });
    ctx.restore();
  }

  if (tileW >= SEAM_MIN_TILE_PX && typeof style.outline === 'string') {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = style.outline;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    for (let i = Math.max(1, first); i <= last + 1 && i < tiles; i++) {
      const x = Math.round(i * tileW - winX) + 0.5;
      if (x >= winW) break;
      if (x < 0) continue;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    ctx.stroke();
    ctx.restore();
  }
}
