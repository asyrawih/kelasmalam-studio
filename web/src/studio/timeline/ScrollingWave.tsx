/**
 * WAVEFORM YANG BERGESER — playhead diam di tengah, materinya yang berjalan.
 *
 * Ini tampilan yang dipakai perkakas DJ (Rekordbox, Serato): mata berhenti
 * mengejar garis dan mulai membaca apa yang DATANG. Untuk kerja beat itu bukan
 * kemewahan — transien berikutnya selalu ada di tempat yang sama di layar.
 *
 * TIGA HAL YANG MEMBUATNYA BENAR:
 *
 * 1. POSISINYA DARI JAM AUDIO, bukan dari playhead di store. Playhead store
 *    maju 16×/detik dari `setInterval`; menggeser seluruh gambar dengan angka
 *    itu menghasilkan gerakan tersendat yang juga tidak pernah persis di posisi
 *    yang terdengar. `previewPositionSec()` membaca `ctx.currentTime` — jam
 *    yang sama dengan yang memutar sample-nya. Kalau tidak ada yang berbunyi,
 *    barulah playhead store dipakai (dan gambarnya memang diam).
 *
 * 2. SATU CANVAS, BUKAN DUA. Waveform, grid, dan playhead digambar bersama di
 *    tiap frame. Kalau waveform di canvas terpisah, ia harus ikut digambar
 *    ulang 60×/detik juga (isinya bergeser), jadi memisahkannya hanya menambah
 *    satu lapisan compositing tanpa menghemat apa pun. Ini kebalikan dari
 *    tampilan FULL, di mana waveform memang diam dan pantas dipisah.
 *
 * 3. RAF BERHENTI SAAT TIDAK BERBUNYI. Jendela yang membeku di posisi terakhir
 *    tidak perlu digambar ulang; loop rAF yang jalan terus hanya membakar
 *    baterai untuk gambar yang sama.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { fitCanvas } from '../../ui/lib/canvas';
import type { BeatGrid } from '../analysis/beat-grid';
import { samplesToSec, secToSamples, type Samples } from '../model';
import { auditionPositionSourceSec, previewPositionSec } from '../preview/audio-preview';
import type { StudioAsset } from '../store';
import { drawBeatGrid, drawPlayhead } from './beat-draw';
import { drawFadeCurves, type FadeRegions } from './fade-draw';
import { clipDetailGradient, drawClipWave, type BandColors } from './waveform';

export interface ScrollingWaveProps {
  readonly asset: StudioAsset | undefined;
  readonly grid: BeatGrid | null;
  readonly sampleRate: number;
  /** Batas materi yang boleh tampak, SOURCE-space. */
  readonly clipSourceStart: Samples;
  readonly clipSourceLen: Samples;
  /** Awal clip di TIMELINE + rasio lane — untuk memetakan posisi ke source. */
  readonly clipStart: Samples;
  readonly speedRatio: number;
  /** Lebar jendela yang tampak, SOURCE-space. */
  readonly windowLen: Samples;
  /** Playhead dari store — dipakai saat tidak ada yang berbunyi. */
  readonly playhead: Samples;
  readonly playing: boolean;
  /** true kalau clip ini sedang diaudisi — jendelanya ikut pemutar audisi. */
  readonly auditioning: boolean;
  /**
   * Pusat jendela yang dipaksa (SOURCE-space), atau null = ikut yang berbunyi.
   * Dipakai saat waveform sedang ditarik dan saat transport diam.
   */
  readonly center?: Samples | null;
  /**
   * Daerah fade clip, SOURCE-space. Digambar di jendela ini juga — fade tetap
   * terdengar saat di-zoom, jadi menyembunyikannya berarti user tidak bisa
   * melihat sesuatu yang sedang mempengaruhi suaranya.
   */
  readonly fade?: FadeRegions | null;
  /** Sorotan region loop, SOURCE-space. */
  readonly region?: { readonly sourceStart: Samples; readonly sourceLen: Samples } | null;
  /** true kalau region itu sedang benar-benar berbunyi (bukan cuma pratinjau). */
  readonly regionLive?: boolean;
  /**
   * Menarik waveform. `sourceAt` adalah posisi SOURCE yang berada di TENGAH
   * jendela (yaitu di bawah playhead) setelah tarikan.
   *
   * Tiga fase, karena tiga hal berbeda perlu terjadi: `start` membisukan audio
   * (lihat `scrubbing`), `move` menggeser, `end` menyalakannya lagi dari posisi
   * baru. Menggabungkannya jadi satu callback berarti pemanggil harus menebak
   * kapan tarikan selesai.
   */
  readonly onScrub?: (phase: 'start' | 'move' | 'end', sourceAt: Samples, fine: boolean) => void;
  /**
   * Jam yang BENAR-BENAR terdengar, dalam detik, pada koordinat yang sama
   * dengan `playhead`. `null` = tidak ada yang berbunyi, jadi `playhead` yang
   * dipakai.
   *
   * Default-nya `previewPositionSec` — jam transport Studio. Prop ini ada
   * supaya PEMAKAI KEDUA, deck DJ di `web/src/dj/`, bisa menyuntikkan jamnya
   * sendiri (satu per deck) tanpa menyalin seluruh komponen ini beserta ketiga
   * aturan di kepala berkas.
   *
   * Bentuknya FUNGSI, bukan angka, dan itu penting: ia dipanggil DI DALAM loop
   * rAF, jadi posisinya boleh bergerak 60×/detik tanpa satu render React pun.
   * Prop `center` di bawah tidak bisa dipakai untuk itu — ia dibaca dari
   * `latest.current`, yang hanya segar saat React me-render.
   */
  readonly positionSourceSec?: () => number | null;
  /**
   * Kalau diisi, waveform digambar per pita frekuensi dengan tiga warna ini,
   * bukan gradien amber Studio. Halaman DJ memakainya; timeline tidak, karena
   * di sana satu clip setinggi 88 px berbagi ruang dengan 31 clip lain dan
   * yang dicari adalah BATAS clip, bukan isi spektrumnya.
   */
  readonly bands?: BandColors | null;
  /** Warna sorotan region. Default cyan Studio; halaman DJ memakai amber deck. */
  readonly regionTint?: string;
  readonly regionStroke?: string;
  /** Tooltip canvas. Default menjelaskan tarik-untuk-loop ala Studio. */
  readonly title?: string;
  /**
   * Anchor grid (SOURCE-space) untuk digambar sebagai segitiga merah, atau
   * `null`. Hanya halaman DJ yang mengisinya, saat mode GRID EDIT menyala —
   * lihat `anchorAt` di `beat-draw.ts`.
   */
  readonly anchorAt?: Samples | null;
}

export function ScrollingWave(props: ScrollingWaveProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  // Props disimpan di ref supaya loop rAF tidak perlu dibuat ulang tiap render —
  // membuat ulang loop tiap 16 ms justru menghasilkan frame yang bolong.
  const latest = useRef(props);
  latest.current = props;
  const paintRef = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;

    const paint = (): void => {
      const p = latest.current;
      const size = fitCanvas(canvas);
      if (size === null) return;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);

      const { width: w, height: h } = size;
      const sr = p.sampleRate;

      const at = centerOf(p, sr);

      // Jendela dipusatkan di playhead, TIDAK di-clamp ke batas clip: kalau
      // di-clamp, playhead berhenti di tengah dan mulai merayap ke tepi di awal
      // dan akhir materi — persis inkonsistensi yang membuat mata harus mencari
      // lagi. Bagian di luar materi digambar sebagai ruang kosong.
      const half = p.windowLen / 2;
      const from = Math.round(at - half);
      const len = Math.max(1, Math.round(p.windowLen));

      // Waveform hanya untuk bagian jendela yang benar-benar berisi materi.
      const clipEnd = p.clipSourceStart + p.clipSourceLen;
      const visFrom = Math.max(from, p.clipSourceStart);
      const visTo = Math.min(from + len, clipEnd);
      if (visTo > visFrom) {
        const x0 = ((visFrom - from) / len) * w;
        const x1 = ((visTo - from) / len) * w;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, 0, x1 - x0, h);
        ctx.clip();
        ctx.translate(x0, 0);
        const gradient = clipDetailGradient(ctx, h);
        drawClipWave(ctx, p.asset, visFrom, visTo - visFrom, x1 - x0, h, size.dpr, {
          // Placeholder (asset hilang) tetap memakai gradien: ia menggambar
          // arsir, bukan pita, jadi warna pita tidak punya arti di sana.
          outline: gradient,
          body: gradient,
          outlineAlpha: 0.55,
          bodyAlpha: 0.9,
          centerLine: '#ffd40024',
          bands: p.bands ?? null,
        });
        ctx.restore();
      }

      // Fade DI ATAS waveform, DI BAWAH grid: bidang gelapnya harus menutupi
      // gelombang (itu bagian yang dibuang), tapi garis bar tetap harus terbaca.
      if (p.fade != null) {
        drawFadeCurves(ctx, { ...p.fade, from, len, width: w, height: h });
      }

      if (p.grid !== null) {
        drawBeatGrid(ctx, {
          grid: p.grid,
          sampleRate: sr,
          from,
          len,
          width: w,
          height: h,
          region: p.region ?? null,
          // Region yang belum berbunyi digambar lebih redup: ia PRATINJAU —
          // "kalau LOOP PLAY ditekan sekarang, ini yang akan berulang". Satu
          // warna untuk dua keadaan membuat user tidak bisa tahu mana yang
          // sedang bekerja.
          regionTint: p.regionTint ?? (p.regionLive === true ? '#6ee7ff28' : '#6ee7ff10'),
          regionStroke: p.regionStroke ?? (p.regionLive === true ? '#6ee7ff' : '#6ee7ff66'),
          anchorAt: p.anchorAt ?? null,
        });
      }
      // Playhead selalu tepat di tengah — itu seluruh gunanya tampilan ini.
      drawPlayhead(ctx, from + len / 2, from, len, w, h, '#ffffff');
    };

    paintRef.current = paint;
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Gambar ulang sekali setiap render. Tanpa deps SENGAJA: saat diam, render
  // hanya terjadi kalau ada yang benar-benar berubah (zoom, clip, playhead
  // di-seek), dan itu persis kapan gambarnya perlu diperbarui. Saat berbunyi,
  // satu repaint tambahan per render tidak berarti apa-apa di samping rAF.
  useEffect(() => {
    paintRef.current?.();
  });

  // Loop rAF HANYA bergantung pada `playing`.
  //
  // Ini yang dulu salah dan wajib dijaga: begitu `playhead` (yang maju 16×/detik)
  // ikut masuk daftar dependensi, loop-nya dibongkar-pasang 16×/detik juga —
  // gerakan yang seharusnya mulus justru berubah jadi tersendat, dengan gejala
  // yang mustahil ditebak dari kodenya.
  useEffect(() => {
    const moving = (props.playing || props.auditioning) && props.center == null;
    if (!moving || typeof requestAnimationFrame !== 'function') return;
    let raf = requestAnimationFrame(function frame(): void {
      paintRef.current?.();
      raf = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(raf);
  }, [props.playing, props.auditioning, props.center]);

  // ── Tarik waveform untuk memindahkan posisi ──
  //
  // Pointer capture dipasang di canvas-nya sendiri: canvas tidak pernah
  // remount selama tarikan, jadi gerakan tetap terlacak walau kursor keluar
  // dari kartu. Pola yang sama dengan handle fade.
  const drag = useRef<{ id: number; x: number; source: Samples } | null>(null);

  const centerSource = (): Samples => centerOf(latest.current, latest.current.sampleRate);

  const begin = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0 || latest.current.onScrub === undefined) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, source: centerSource() };
    setDragging(true);
    try {
      ref.current?.setPointerCapture(e.pointerId);
    } catch {
      // jsdom / browser lama: tarikan tetap jalan lewat bubbling biasa.
    }
    latest.current.onScrub('start', drag.current.source, e.shiftKey);
  };

  const at = (e: ReactPointerEvent<HTMLCanvasElement>): Samples | null => {
    const d = drag.current;
    const rect = ref.current?.getBoundingClientRect();
    if (d === null || rect === undefined || rect.width <= 0) return null;
    // Menarik ke KANAN membawa materi ke kanan, artinya MUNDUR dalam waktu —
    // arah yang sama dengan menggeser kertas di bawah jarum, dan kebalikan dari
    // "menggeser playhead". Membalikkannya membuat tangan terasa salah.
    return d.source - ((e.clientX - d.x) / rect.width) * latest.current.windowLen;
  };

  const move = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (drag.current?.id !== e.pointerId) return;
    const next = at(e);
    if (next !== null) latest.current.onScrub?.('move', next, e.shiftKey);
  };

  const end = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (drag.current?.id !== e.pointerId) return;
    const next = at(e) ?? drag.current.source;
    drag.current = null;
    setDragging(false);
    if (ref.current?.hasPointerCapture?.(e.pointerId) === true) {
      ref.current.releasePointerCapture(e.pointerId);
    }
    latest.current.onScrub?.('end', next, e.shiftKey);
  };

  return (
    <canvas
      ref={ref}
      data-scrolling-wave
      title={
        props.title ??
        'tarik untuk memindahkan posisi loop · tahan Shift untuk menempel ke ketukan, bukan bar'
      }
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        cursor: props.onScrub === undefined ? 'default' : dragging ? 'grabbing' : 'grab',
        touchAction: 'none',
      }}
    />
  );
}

/**
 * Pusat jendela, SOURCE-space. Tiga sumber, dengan urutan yang penting:
 *
 *  1. `center` yang dipaksa — saat waveform sedang ditarik, tangan yang menang.
 *  2. AUDISI, kalau clip ini sedang diaudisi. Inilah yang benar-benar terdengar
 *     dari panel ini; playhead timeline sedang berjalan di tempat lain dan
 *     tidak ada hubungannya.
 *  3. Playhead timeline, dipetakan ke source lewat rasio lane.
 */
function centerOf(p: ScrollingWaveProps, sr: number): Samples {
  if (p.center !== null && p.center !== undefined) return p.center;
  if (p.auditioning) {
    const src = auditionPositionSourceSec();
    if (src !== null) return secToSamples(src, sr);
  }
  const heardSec = (p.positionSourceSec ?? previewPositionSec)();
  const timelineAt = heardSec === null || !p.playing ? p.playhead : secToSamples(heardSec, sr);
  return p.clipSourceStart + (timelineAt - p.clipStart) * p.speedRatio;
}

/** Lebar jendela dalam detik — untuk pembacaan di layar. */
export function windowSeconds(windowLen: Samples, sampleRate: number): number {
  return samplesToSec(windowLen, sampleRate);
}
