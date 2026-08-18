/**
 * Card Clip Detail — waveform clip terpilih + aksi edit.
 *
 * Saat tidak ada seleksi, design menyembunyikan seluruh blok waveform
 * (`sc-if hasSel`) dan hanya menyisakan judul "PILIH CLIP DI TIMELINE".
 *
 * CATATAN: semua aksi di sini murni operasi timeline — tidak satu pun butuh
 * engine. TRIM sempat duduk di sini sebagai tombol mati dengan alasan "butuh
 * engine"; itu keliru, dan sekarang trim dikerjakan dengan menarik tepi clip
 * langsung di timeline (`timeline/clip-trim.ts`).
 *
 * FADE DIEDIT DENGAN MENARIK, BUKAN DENGAN MENGETIK. Versi sebelumnya memberi
 * dua tombol on/off 1000 ms plus dua kolom milidetik. Itu alat yang salah untuk
 * pekerjaan yang sebenarnya: transisi antar lagu panjangnya 4–16 detik dan
 * dinilai dengan telinga sambil melihat waveform — panjangnya tidak pernah
 * ditemukan dengan mengetik "6500". Karena itu handle-nya ada DI ATAS waveform,
 * bentuk kurvanya digambar di tempat yang sama, dan angkanya dalam detik.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Button } from '../../ui/cyber';
import { useCanvasDraw } from '../../ui/lib/canvas';
import {
  DEFAULT_FADE_CURVE,
  formatTime,
  samplesToSec,
  type FadeCurve,
  type Samples,
  type StudioClip,
} from '../model';
import { studioActions, useStudio, type StudioAsset } from '../store';
import {
  clampFadeMs,
  FADE_PRESET_SEC,
  msToSec,
  secToMs,
  type FadeSide,
} from './fade';
import { BeatOverlay, LoopRegionPicker, formatBars } from './BeatSection';
import { useBeatShared } from './beat-context';
import { activeLoopLen } from './clip-loop';
import { drawFadeCurves, fadeSourceLen, type FadeRegions } from './fade-draw';
import { computeNormalizeGain, NORMALIZE_TARGET_DB } from './normalize';
import { ScrollingWave } from './ScrollingWave';
import { clipDetailGradient, drawClipWave, drawLoopedClipWave } from './waveform';

/** Tinggi kotak waveform; handle diletakkan relatif terhadap ini. */
const WAVE_HEIGHT = 150;
/** Langkah keyboard, dalam detik. Shift = langkah halus untuk penyetelan akhir. */
const KEY_STEP_SEC = 0.1;
const KEY_STEP_FINE_SEC = 0.01;

const fmtSec = (ms: number): string => `${msToSec(ms).toFixed(2)} s`;

/** Input durasi fade dalam DETIK; diterapkan saat blur/Enter, bukan tiap ketikan. */
function SecField({
  label,
  valueMs,
  onCommit,
}: {
  readonly label: string;
  readonly valueMs: number;
  readonly onCommit: (ms: number) => void;
}): JSX.Element {
  const [text, setText] = useState(msToSec(valueMs).toFixed(2));
  useEffect(() => setText(msToSec(valueMs).toFixed(2)), [valueMs]);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <input
        aria-label={`${label} (detik)`}
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number.parseFloat(text);
          onCommit(Number.isFinite(n) && n > 0 ? secToMs(n) : 0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        style={{
          width: '58px',
          height: '24px',
          background: '#000',
          border: '1px solid var(--cy-border)',
          color: 'var(--cy-text)',
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '11px',
          padding: '0 6px',
          outline: 'none',
          textAlign: 'right',
        }}
      />
      <span style={{ fontSize: '9px', color: 'var(--cy-text-muted)' }}>s</span>
    </label>
  );
}

/**
 * Waveform besar clip terpilih. Warna gradien vertikal
 * `#ffb020 → #ffd400 → #ffb020` dan garis tengah `#ffd40024` sengaja sama
 * persis dengan versi DOM sebelumnya — yang berubah cuma cara menggambarnya.
 */
function DetailWave({
  asset,
  sourceStart,
  sourceLen,
  loopLen = null,
}: {
  asset: StudioAsset | undefined;
  sourceStart: number;
  sourceLen: number;
  /** Putaran (SOURCE) kalau clip ini loop. Default null = digambar lurus. */
  loopLen?: number | null;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasDraw(
    ref,
    (ctx, size) => {
      const gradient = clipDetailGradient(ctx, size.height);
      const wave = {
        outline: gradient,
        body: gradient,
        // Outline lebih redup dari badan: transien tetap terlihat sebagai
        // "kabut" di luar, energi utama tetap pekat di dalam.
        outlineAlpha: 0.55,
        bodyAlpha: 0.9,
        centerLine: '#ffd40024',
      };
      if (loopLen !== null) {
        drawLoopedClipWave(
          ctx,
          asset,
          sourceStart,
          sourceLen,
          loopLen,
          size.width,
          size.height,
          size.dpr,
          wave,
        );
        return;
      }
      drawClipWave(ctx, asset, sourceStart, sourceLen, size.width, size.height, size.dpr, wave);
    },
    [asset, sourceStart, sourceLen, loopLen],
  );
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}

/**
 * Overlay fade di atas kotak waveform.
 *
 * Menggambar lewat `drawFadeCurves` — implementasi yang SAMA dengan yang dipakai
 * jendela geser. Dua salinan berarti bentuk kurva bisa berbeda hanya karena user
 * menekan tombol zoom.
 */
function FadeOverlay({
  fade,
  from,
  len,
}: {
  readonly fade: FadeRegions;
  readonly from: Samples;
  readonly len: Samples;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasDraw(
    ref,
    (ctx, size) => {
      ctx.clearRect(0, 0, size.width, size.height);
      drawFadeCurves(ctx, { ...fade, from, len, width: size.width, height: size.height });
    },
    [fade, from, len],
  );
  return (
    <canvas
      ref={ref}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
}

/**
 * Handle fade di sudut atas waveform.
 *
 * Pointer capture dipasang di HANDLE-nya sendiri (bukan di kotak waveform):
 * handle tidak pernah remount selama drag, dan capture di elemen itu membuat
 * gerakan tetap terlacak walau kursor keluar dari card.
 */
function FadeHandle({
  side,
  xFrac,
  valueMs,
  dragging,
  onDrag,
  onReset,
  onNudge,
  onFocus,
}: {
  readonly side: FadeSide;
  /**
   * Posisi gagang sebagai fraksi JENDELA yang sedang tampak (0..1), bukan
   * fraksi clip. Itu yang membuatnya benar di tampilan utuh MAUPUN di jendela
   * geser — di jendela geser, fraksi clip menunjuk tempat yang bukan tempatnya.
   */
  readonly xFrac: number;
  readonly valueMs: number;
  readonly dragging: boolean;
  /** Fraksi JENDELA tempat pointer berada. Pemanggil yang menerjemahkannya. */
  readonly onDrag: (xFrac: number) => void;
  readonly onReset: () => void;
  readonly onNudge: (deltaSec: number) => void;
  readonly onFocus: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);

  const posPct = xFrac * 100;

  const begin = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = e.pointerId;
    onFocus();
    try {
      ref.current?.setPointerCapture(e.pointerId);
    } catch {
      // jsdom / browser lama: drag tetap jalan lewat bubbling biasa.
    }
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current !== e.pointerId) return;
    const box = ref.current?.parentElement;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0) return;
    // Fraksi jendela apa adanya; arah "ke dalam clip" diurus pemanggil, yang
    // tahu di mana batas clip berada di dalam jendela ini.
    onDrag((e.clientX - rect.left) / rect.width);
  };

  const end = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current !== e.pointerId) return;
    drag.current = null;
    if (ref.current?.hasPointerCapture?.(e.pointerId) === true) {
      ref.current.releasePointerCapture(e.pointerId);
    }
  };

  const label = side === 'in' ? 'Fade in' : 'Fade out';
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={`${label} handle`}
      aria-valuetext={fmtSec(valueMs)}
      aria-valuenow={Number(msToSec(valueMs).toFixed(2))}
      data-fade-handle={side}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const step = e.shiftKey ? KEY_STEP_FINE_SEC : KEY_STEP_SEC;
        // Panah menggerakkan HANDLE ke arah panahnya, bukan "menambah nilai":
        // di sisi kanan, ← berarti menarik masuk = fade lebih panjang.
        const towardInside = side === 'in' ? e.key === 'ArrowRight' : e.key === 'ArrowLeft';
        onNudge(towardInside ? step : -step);
      }}
      title={`${label}: tarik ke dalam untuk memperpanjang · dobel-klik = 0`}
      style={{
        position: 'absolute',
        top: '-1px',
        left: `${posPct}%`,
        transform: 'translateX(-50%)',
        width: '14px',
        height: '14px',
        background: dragging ? '#ffd400' : '#ffd400cc',
        border: '1px solid #050505',
        // Notch 3px — bahasa bentuk yang sama dengan tombol Card.
        clipPath: 'polygon(0 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%)',
        cursor: 'ew-resize',
        touchAction: 'none',
        zIndex: 2,
        boxShadow: dragging ? '0 0 10px #ffd400' : 'none',
      }}
    />
  );
}

/** Satu blok kontrol untuk satu sisi fade: angka + preset panjang transisi. */
/**
 * EDITOR FADE — permukaan tersendiri yang TIDAK PERNAH BERGERAK.
 *
 * Kenapa terpisah dari kotak waveform utama: kotak itu bisa berada dalam mode
 * jendela geser, dan di sana gambarnya berjalan saat play. Menyetel kurva di
 * atas permukaan yang bergeser berarti sasarannya kabur dari bawah tangan —
 * gerakan halus yang justru dibutuhkan untuk menilai transisi jadi mustahil.
 *
 * Di sini clip digambar UTUH dan diam: apa pun yang sedang terjadi di transport,
 * yang terlihat tetap bentuk fade-nya. Itu satu-satunya hal yang sedang diatur.
 */
function FadeEditor({
  clip,
  asset,
  sampleRate,
  speedRatio,
  onClose,
}: {
  readonly clip: StudioClip;
  readonly asset: StudioAsset | undefined;
  readonly sampleRate: number;
  readonly speedRatio: number;
  readonly onClose: () => void;
}): JSX.Element {
  const [dragSide, setDragSide] = useState<FadeSide | null>(null);
  const curve: FadeCurve = clip.fadeCurve === 'linear' ? 'linear' : DEFAULT_FADE_CURVE;
  const fade: FadeRegions = {
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceStart + clip.sourceLen,
    fadeInSource: fadeSourceLen(clip.fadeInMs, sampleRate, speedRatio),
    fadeOutSource: fadeSourceLen(clip.fadeOutMs, sampleRate, speedRatio),
    curve,
  };
  const xOf = (source: number): number =>
    clip.sourceLen > 0 ? (source - clip.sourceStart) / clip.sourceLen : -1;

  const setFade = (side: FadeSide, ms: number): void => {
    const v = Math.round(clampFadeMs(clip, side, ms, sampleRate));
    studioActions.updateClip(clip.id, side === 'in' ? { fadeInMs: v } : { fadeOutMs: v });
  };
  /** Fraksi kotak → milidetik fade. Kotaknya SELALU seluruh clip di sini. */
  const setFromFrac = (side: FadeSide, f: number): void => {
    const source = (side === 'in' ? f : 1 - f) * clip.sourceLen;
    setFade(side, (Math.max(0, source) / speedRatio / sampleRate) * 1000);
  };

  return (
    <div
      data-fade-editor
      role="dialog"
      aria-label="editor fade"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--cy-surface-1)',
        border: '1px solid var(--cy-accent)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 5,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '6px 8px',
          borderBottom: '1px solid var(--cy-border)',
        }}
      >
        <span style={{ fontSize: '9px', letterSpacing: '.18em', color: 'var(--cy-accent)' }}>
          FADE
        </span>
        <span style={{ fontSize: '10px', color: 'var(--cy-text-dim)' }}>
          tarik gagang di sudut · dobel-klik = nol · panah = geser
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          <Button
            size="sm"
            variant={curve === 'linear' ? 'outline' : 'ghost'}
            onClick={() => studioActions.updateClip(clip.id, { fadeCurve: 'linear' })}
            style={{ padding: '0 8px' }}
          >
            LINEAR
          </Button>
          <Button
            size="sm"
            variant={curve === 'equalPower' ? 'outline' : 'ghost'}
            onClick={() => studioActions.updateClip(clip.id, { fadeCurve: 'equalPower' })}
            style={{ padding: '0 8px' }}
          >
            EQUAL-POWER
          </Button>
          <Button size="sm" variant="ghost" aria-label="tutup editor fade" onClick={onClose}>
            ✕
          </Button>
        </span>
      </div>

      <div
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          margin: '10px 12px 12px',
          background: '#000',
          border: '1px solid var(--cy-border)',
          overflow: 'visible',
          touchAction: 'none',
        }}
      >
        <DetailWave
          asset={asset}
          sourceStart={clip.sourceStart}
          sourceLen={clip.sourceLen}
          loopLen={activeLoopLen(clip)}
        />
        <FadeOverlay fade={fade} from={clip.sourceStart} len={clip.sourceLen} />
        <FadeHandle
          side="in"
          xFrac={xOf(fade.sourceStart + fade.fadeInSource)}
          valueMs={clip.fadeInMs}
          dragging={dragSide === 'in'}
          onFocus={() => setDragSide('in')}
          onDrag={(f) => setFromFrac('in', f)}
          onReset={() => setFade('in', 0)}
          onNudge={(d) => setFade('in', clip.fadeInMs + secToMs(d))}
        />
        <FadeHandle
          side="out"
          xFrac={xOf(fade.sourceEnd - fade.fadeOutSource)}
          valueMs={clip.fadeOutMs}
          dragging={dragSide === 'out'}
          onFocus={() => setDragSide('out')}
          onDrag={(f) => setFromFrac('out', f)}
          onReset={() => setFade('out', 0)}
          onNudge={(d) => setFade('out', clip.fadeOutMs + secToMs(d))}
        />
        <div
          style={{
            position: 'absolute',
            right: '6px',
            bottom: '6px',
            display: 'flex',
            gap: '10px',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '10px',
            letterSpacing: '.08em',
            color: '#ffd400',
            background: '#050505cc',
            padding: '2px 6px',
            pointerEvents: 'none',
          }}
        >
          <span>IN {fmtSec(clip.fadeInMs)}</span>
          <span>OUT {fmtSec(clip.fadeOutMs)}</span>
        </div>
      </div>
    </div>
  );
}

function FadeControls({
  side,
  clip,
  sampleRate,
  onSet,
}: {
  readonly side: FadeSide;
  readonly clip: StudioClip;
  readonly sampleRate: number;
  readonly onSet: (ms: number) => void;
}): JSX.Element {
  const valueMs = side === 'in' ? clip.fadeInMs : clip.fadeOutMs;
  const label = side === 'in' ? 'FADE IN' : 'FADE OUT';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      <span
        style={{
          fontSize: '9px',
          letterSpacing: '.16em',
          color: 'var(--cy-text-muted)',
          width: '62px',
        }}
      >
        {label}
      </span>
      <SecField label={label} valueMs={valueMs} onCommit={onSet} />
      {FADE_PRESET_SEC.map((sec) => {
        const ms = secToMs(sec);
        const reachable = clampFadeMs(clip, side, ms, sampleRate);
        return (
          <Button
            key={sec}
            size="sm"
            variant={Math.abs(valueMs - ms) < 1 ? 'outline' : 'ghost'}
            disabled={reachable < ms}
            title={
              reachable < ms
                ? 'clip terlalu pendek (atau fade sisi lain memakan ruangnya)'
                : `${label.toLowerCase()} ${sec} detik`
            }
            onClick={() => onSet(ms)}
            style={{ padding: '0 8px' }}
          >
            {sec}s
          </Button>
        );
      })}
    </div>
  );
}

/**
 * Baris identitas clip: nama, lane, durasi, dan penanda keadaan seleksi.
 *
 * Dipakai di beberapa popup menu — masing-masing harus menyatakan clip MANA
 * yang sedang diubahnya. Popup yang mengedit sesuatu tanpa menyebut apa yang
 * diedit adalah cara paling mudah membuat orang mengubah clip yang salah.
 */
export function ClipHeader(): JSX.Element {
  const sampleRate = useStudio((s) => s.sampleRate);
  const selectedCount = useStudio((s) => s.selectedClipIds.length);
  const { shown: sel, isSelected } = useBeatShared();
  const startSec = sel === null ? 0 : samplesToSec(sel.clip.start, sampleRate);
  const lenSec = sel === null ? 0 : samplesToSec(sel.clip.len, sampleRate);

  return (
    <div
      data-clip-header
      style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}
    >
      <span
        style={{
          fontFamily: 'var(--cy-font-sans)',
          fontSize: '14px',
          fontWeight: 600,
          color:
            sel === null ? 'var(--cy-text-muted)' : isSelected ? sel.lane.color : 'var(--cy-text-dim)',
          letterSpacing: '.04em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '46ch',
        }}
      >
        {sel === null ? 'PILIH CLIP DI TIMELINE' : sel.clip.label}
      </span>
      {sel !== null && !isSelected ? (
        <span
          style={{
            fontSize: '9px',
            letterSpacing: '.14em',
            color: 'var(--cy-text-muted)',
            border: '1px solid var(--cy-border-strong)',
            padding: '1px 6px',
          }}
          title="clip ini tidak sedang tersorot di timeline, tapi edit di sini tetap berlaku untuknya"
        >
          TIDAK TERPILIH
        </span>
      ) : null}
      {/* Penanda seleksi ganda. Editor mana pun SELALU bekerja untuk satu clip —
          beat, loop, stem, fade tidak punya arti untuk empat clip sekaligus.
          Menyatakannya jauh lebih jujur daripada membiarkan user mengira
          perubahannya berlaku untuk semuanya. */}
      {selectedCount > 1 && isSelected ? (
        <span
          style={{
            fontSize: '9px',
            letterSpacing: '.14em',
            color: 'var(--cy-accent)',
            border: '1px solid var(--cy-accent)',
            padding: '1px 6px',
          }}
          title="edit di sini hanya berlaku untuk clip yang ditandai putih di timeline"
        >
          {selectedCount} CLIP TERPILIH
        </span>
      ) : null}
      <span style={{ fontSize: '10px', letterSpacing: '.12em', color: 'var(--cy-text-dim)' }}>
        {sel === null
          ? '—'
          : `${sel.lane.name} · ${formatTime(startSec)} → ${formatTime(startSec + lenSec)} · ${lenSec.toFixed(1)} s`}
      </span>
    </div>
  );
}

/**
 * Kotak waveform clip + seluruh interaksinya: grid, jendela geser, tarik untuk
 * menaruh loop, dan handle fade.
 *
 * Berdiri sendiri (mengambil clip & state beat dari `BeatProvider`) supaya bisa
 * dipasang di dalam popup menu LOOP tanpa satu pun prop.
 */
export function ClipWavePanel({ height = WAVE_HEIGHT }: { readonly height?: number }): JSX.Element {
  const assets = useStudio((s) => s.assets);
  const sampleRate = useStudio((s) => s.sampleRate);
  const playhead = useStudio((s) => s.playhead);
  const playing = useStudio((s) => s.playing);
  const [dragSide, setDragSide] = useState<FadeSide | null>(null);
  /**
   * Pusat jendela yang dipaksa oleh tarikan (SOURCE-space), null = ikut yang
   * berbunyi.
   *
   * Menarik waveform di sini TIDAK menyentuh playhead timeline: panel ini punya
   * pemutar dan posisinya sendiri, dan mengatur loop di satu clip tidak boleh
   * menggeser tempat lagu di lane lain sedang berbunyi.
   */
  const [dragCenter, setDragCenter] = useState<number | null>(null);
  const [fadeOpen, setFadeOpen] = useState(false);
  const { shown: sel, beat } = useBeatShared();

  const clip = sel?.clip;
  const speedRatio = sel?.lane.speedRatio ?? 1;

  /**
   * JENDELA yang digambar di kotak waveform.
   *
   * Saat audisi berjalan tanpa zoom, kotaknya menampilkan HANYA region yang
   * berulang — itu yang membuat "2 bar" bisa benar-benar dilihat, bukan jadi
   * sorotan setipis rambut di dalam lagu lima menit.
   */
  const follow = beat.windowLen !== null;
  const loopZoom = !follow && beat.looping && beat.region !== null;
  /** Fade disembunyikan di kedua tampilan sempit — lihat catatan di bawah. */
  const zoomed = follow || loopZoom;
  const viewStart =
    loopZoom && beat.region !== null ? beat.region.sourceStart : (clip?.sourceStart ?? 0);
  const viewLen = loopZoom && beat.region !== null ? beat.region.sourceLen : (clip?.sourceLen ?? 0);

  /**
   * Playhead di SOURCE-space TANPA dibatasi ke dalam clip. Dipakai sebagai pusat
   * jendela geser — di sana jendela memang boleh menjorok keluar materi.
   */
  const playheadSourceRaw =
    clip === undefined ? 0 : clip.sourceStart + (playhead - clip.start) * speedRatio;

  /**
   * Jendela yang BENAR-BENAR tampak, SOURCE-space — termasuk saat jendela geser
   * aktif. Gagang fade dipasang dari sini, bukan dari fraksi clip; di jendela
   * geser nilainya mengikuti playhead, jadi gagangnya bergerak bersama gambarnya.
   */
  const windowFrom =
    follow && beat.windowLen !== null
      ? (dragCenter ?? playheadSourceRaw) - beat.windowLen / 2
      : viewStart;
  const windowLen = follow && beat.windowLen !== null ? beat.windowLen : viewLen;
  const xOf = (source: number): number =>
    windowLen > 0 ? (source - windowFrom) / windowLen : -1;

  /**
   * Menarik waveform di jendela geser.
   *
   * Satu tarikan mengerjakan dua hal sekaligus, dan memang harus begitu: pusat
   * jendela mengikuti tangan secara MULUS (kalau ia ikut menempel ke bar,
   * gambarnya tersentak-sentak dan tidak terasa seperti menarik apa pun),
   * sedangkan awal region MENEMPEL ke bar (loop yang mulai di tengah ketukan
   * tidak ada gunanya).
   */
  const scrubTo = (phase: 'start' | 'move' | 'end', sourceAt: number, fine: boolean): void => {
    if (clip === undefined) return;
    const limit = clip.sourceStart + clip.sourceLen;
    const at = Math.max(clip.sourceStart, Math.min(limit, sourceAt));
    if (phase === 'start') {
      beat.setRegionDragging(true);
      setDragCenter(at);
      return;
    }
    setDragCenter(at);
    beat.moveTo(at, fine);
    if (phase !== 'end') return;
    // Baru di sini perpindahannya sampai ke pemutar audisi — satu penjadwalan
    // ulang per tarikan, bukan satu per pixel.
    beat.setRegionDragging(false);
    // Dilepas: kalau audisi sedang berjalan, jendela kembali MENGIKUTI-nya.
    if (beat.looping) setDragCenter(null);
  };

  // Tampilan beku dilepas saat audisi menyala dan saat pindah clip: keduanya
  // membuat "pusat jendela yang dipilih tangan" kehilangan artinya.
  const auditioning = beat.looping;
  const clipId = clip?.id;
  useEffect(() => {
    if (auditioning) setDragCenter(null);
  }, [auditioning]);
  useEffect(() => {
    setDragCenter(null);
  }, [clipId]);

  /** Playhead di SOURCE-space, null kalau tidak sedang berada di clip ini. */
  const playheadSource =
    clip !== undefined && playhead >= clip.start && playhead < clip.start + clip.len
      ? clip.sourceStart + (playhead - clip.start) * speedRatio
      : null;
  const curve: FadeCurve = clip?.fadeCurve === 'linear' ? 'linear' : DEFAULT_FADE_CURVE;

  const setFade = (side: FadeSide, ms: number): void => {
    if (clip === undefined) return;
    const v = Math.round(clampFadeMs(clip, side, ms, sampleRate));
    studioActions.updateClip(clip.id, side === 'in' ? { fadeInMs: v } : { fadeOutMs: v });
  };

  /**
   * Gagang dilepas di fraksi `f` dari JENDELA → berapa milidetik fade-nya.
   *
   * Dua konversi, dan keduanya wajib: fraksi jendela → sample SOURCE, lalu
   * source → waktu TIMELINE lewat `speedRatio` (fade diukur di waktu timeline).
   * Melewatkan yang kedua membuat fade di lane yang di-speed-up meleset persis
   * sebesar rasionya — dan itu hanya terdengar, tidak terlihat.
   */
  const setFadeFromWindow = (side: FadeSide, f: number): void => {
    if (clip === undefined || windowLen <= 0) return;
    const at = windowFrom + f * windowLen;
    const source = side === 'in' ? at - clip.sourceStart : clip.sourceStart + clip.sourceLen - at;
    setFade(side, (Math.max(0, source) / speedRatio / sampleRate) * 1000);
  };

  /**
   * Daerah fade di SOURCE-space — satu-satunya bentuk yang benar di kedua
   * tampilan. Dari sini datang gambar kurvanya DAN posisi gagangnya.
   */
  const fade: FadeRegions | null =
    clip === undefined
      ? null
      : {
          sourceStart: clip.sourceStart,
          sourceEnd: clip.sourceStart + clip.sourceLen,
          fadeInSource: fadeSourceLen(clip.fadeInMs, sampleRate, speedRatio),
          fadeOutSource: fadeSourceLen(clip.fadeOutMs, sampleRate, speedRatio),
          curve,
        };

  if (sel === null || clip === undefined) {
    return (
      <div
        data-clip-wave
        style={{
          height: `${height}px`,
          border: '1px dashed var(--cy-border)',
          display: 'grid',
          placeItems: 'center',
          fontSize: '10px',
          letterSpacing: '.14em',
          color: 'var(--cy-text-muted)',
        }}
      >
        BELUM ADA CLIP
      </div>
    );
  }

  return (
    <div
      data-clip-wave
      style={{
        position: 'relative',
        height: `${height}px`,
        background: '#000',
        border: '1px solid var(--cy-border)',
        // `overflow: visible` supaya handle di sudut tidak terpotong.
        overflow: 'visible',
        touchAction: 'none',
      }}
    >
      {/* DUA PENGGAMBAR YANG SALING MENIADAKAN.
          FULL: waveform diam di canvas sendiri (mahal, jarang berubah), grid +
          playhead di canvas overlay yang bergerak 16×/detik. Jendela geser:
          semuanya di SATU canvas rAF, karena di sana waveform-nya memang ikut
          bergerak tiap frame. */}
      {follow && beat.windowLen !== null ? (
        <ScrollingWave
          asset={assets[clip.assetId]}
          grid={beat.grid}
          sampleRate={sampleRate}
          clipSourceStart={clip.sourceStart}
          clipSourceLen={clip.sourceLen}
          clipStart={clip.start}
          speedRatio={speedRatio}
          windowLen={beat.windowLen}
          playhead={playhead}
          playing={playing}
          auditioning={beat.looping}
          center={dragCenter}
          // Region SELALU digambar, bukan hanya saat berbunyi: seluruh gunanya
          // menarik waveform adalah melihat di mana loop-nya akan jatuh SEBELUM
          // menekan LOOP PLAY.
          region={beat.region}
          regionLive={beat.looping}
          onScrub={scrubTo}
        />
      ) : (
        <>
          <DetailWave
            asset={assets[clip.assetId]}
            sourceStart={viewStart}
            sourceLen={viewLen}
            // Saat kotak sedang menampilkan REGION-nya saja (audisi), ubin loop
            // tidak dipakai: yang tergambar memang sudah satu putaran.
            loopLen={loopZoom ? null : activeLoopLen(clip)}
          />
          {fade === null ? null : <FadeOverlay fade={fade} from={viewStart} len={viewLen} />}
          <BeatOverlay
            grid={beat.grid}
            region={loopZoom ? null : beat.region}
            sourceStart={viewStart}
            sourceLen={viewLen}
            sampleRate={sampleRate}
            playheadSource={playheadSource}
          />
        </>
      )}
      {/* Penangkap pointer duduk DI BAWAH handle fade (zIndex 1 vs 2): menaruh
          awal loop tidak boleh merebut drag yang dimaksudkan untuk fade. */}
      <LoopRegionPicker
        enabled={beat.grid !== null && !zoomed}
        onPick={(frac, fine) => beat.moveTo(clip.sourceStart + frac * clip.sourceLen, fine)}
      />
      {/* GAGANG FADE hanya di tampilan yang DIAM.
          Bukan karena tidak bisa dipetakan — bisa, dan sempat begitu — tapi
          karena permukaannya bergeser saat play: menarik gagang di atas gambar
          yang sedang berjalan berarti sasarannya kabur dari bawah tangan. Untuk
          menyetel fade dengan tenang ada tombol FADE, yang membuka editor
          tersendiri dengan permukaan yang tidak pernah bergerak. */}
      {fade === null || follow ? null : (
        <>
          <FadeHandle
            side="in"
            xFrac={xOf(fade.sourceStart + fade.fadeInSource)}
            valueMs={clip.fadeInMs}
            dragging={dragSide === 'in'}
            onFocus={() => setDragSide('in')}
            onDrag={(f) => setFadeFromWindow('in', f)}
            onReset={() => setFade('in', 0)}
            onNudge={(d) => setFade('in', clip.fadeInMs + secToMs(d))}
          />
          <FadeHandle
            side="out"
            xFrac={xOf(fade.sourceEnd - fade.fadeOutSource)}
            valueMs={clip.fadeOutMs}
            dragging={dragSide === 'out'}
            onFocus={() => setDragSide('out')}
            onDrag={(f) => setFadeFromWindow('out', f)}
            onReset={() => setFade('out', 0)}
            onNudge={(d) => setFade('out', clip.fadeOutMs + secToMs(d))}
          />
        </>
      )}
      {/* Tombol pembuka editor fade.
          Fade dulu diatur langsung di kotak ini, dan itu keliru begitu jendela
          geser ada: permukaannya berjalan saat play. Tombol memindahkan
          pekerjaan itu ke permukaan yang diam, dan sekaligus membuat "menyetel
          fade" jadi sesuatu yang dimasuki dengan sengaja — bukan sesuatu yang
          bisa tergeser tanpa sadar saat tangan meleset di atas waveform. */}
      <Button
        size="sm"
        variant={fadeOpen ? 'outline' : 'ghost'}
        aria-label="buka editor fade"
        title="atur fade di permukaan yang tidak bergerak"
        onClick={() => setFadeOpen((v) => !v)}
        style={{
          position: 'absolute',
          right: '6px',
          top: '6px',
          height: '22px',
          padding: '0 8px',
          fontSize: '9px',
          background: '#050505cc',
          zIndex: 3,
        }}
      >
        FADE
      </Button>
      {fadeOpen ? (
        <FadeEditor
          clip={clip}
          asset={assets[clip.assetId]}
          sampleRate={sampleRate}
          speedRatio={speedRatio}
          onClose={() => setFadeOpen(false)}
        />
      ) : null}
      {zoomed ? (
        <div
          data-loop-badge
          style={{
            position: 'absolute',
            left: '6px',
            top: '6px',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '10px',
            letterSpacing: '.12em',
            color: '#6ee7ff',
            background: '#050505cc',
            padding: '2px 6px',
            pointerEvents: 'none',
          }}
        >
          {beat.looping ? `LOOP ${formatBars(beat.bars)} BAR` : `VIEW ${beat.zoom} BAR`}
        </div>
      ) : null}
      {/* Pembacaan langsung dalam DETIK — satuan yang dipakai orang untuk
          menilai transisi. Selalu terlihat, bukan hanya saat drag: nilai yang
          hilang begitu pointer dilepas tidak bisa dibandingkan. */}
      <div
        data-fade-readout
        style={{
          position: 'absolute',
          right: '6px',
          bottom: '6px',
          display: 'flex',
          gap: '10px',
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '10px',
          letterSpacing: '.08em',
          color: '#ffd400',
          background: '#050505cc',
          padding: '2px 6px',
          pointerEvents: 'none',
        }}
      >
        {zoomed ? (
          <span>
            {follow && beat.windowLen !== null
              ? `jendela ${samplesToSec(beat.windowLen, sampleRate).toFixed(2)} s`
              : `region ${samplesToSec(viewLen, sampleRate).toFixed(2)} s`}
          </span>
        ) : (
          <>
            <span>IN {fmtSec(clip.fadeInMs)}</span>
            <span>OUT {fmtSec(clip.fadeOutMs)}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Aksi clip + fade. Isi popup menu CLIP. */
export function ClipEditPanel(): JSX.Element {
  const sampleRate = useStudio((s) => s.sampleRate);
  const playhead = useStudio((s) => s.playhead);
  const [note, setNote] = useState<string | null>(null);
  const { shown: sel, beat } = useBeatShared();
  const clip = sel?.clip;

  const canSplit =
    sel !== null && playhead > sel.clip.start && playhead < sel.clip.start + sel.clip.len;
  // "Sudah dinormalisasi" = gain clip sudah digeser dari 0. Dipakai untuk
  // membuat tombolnya bisa dibatalkan, bukan sekali jalan.
  const normalized = sel !== null && Math.abs(sel.clip.gainDb) > 0.001;
  const curve: FadeCurve = clip?.fadeCurve === 'linear' ? 'linear' : DEFAULT_FADE_CURVE;

  const setFade = (side: FadeSide, ms: number): void => {
    if (clip === undefined) return;
    const v = Math.round(clampFadeMs(clip, side, ms, sampleRate));
    studioActions.updateClip(clip.id, side === 'in' ? { fadeInMs: v } : { fadeOutMs: v });
  };

  if (clip === undefined) {
    return <span style={{ fontSize: '10px', color: 'var(--cy-text-dim)' }}>belum ada clip</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        {/*
          Tombol TRIM sudah TIDAK ADA di sini.
          Ia dulu mati permanen (`disabled={!engineReady}`, tanpa handler) karena
          memotong dianggap butuh engine. Ternyata tidak: trim hanyalah mengubah
          jendela clip ke dalam materinya, murni operasi timeline. Sekarang
          dikerjakan dengan MENARIK TEPI clip langsung di timeline — tempat mata
          sudah melihat batas yang mau digeser. Tombol yang membuka dialog untuk
          menggeser batas yang terlihat di layar hanya menambah satu lompatan.
        */}
        <Button
          size="sm"
          variant="ghost"
          title={
            normalized
              ? `sudah dinormalisasi ke ${NORMALIZE_TARGET_DB} dBFS — klik untuk kembali ke 0 dB`
              : `naikkan puncak clip ke ${NORMALIZE_TARGET_DB} dBFS`
          }
          onClick={() => {
            if (normalized) {
              studioActions.updateClip(clip.id, { gainDb: 0 });
              setNote(null);
              return;
            }
            const r = computeNormalizeGain(clip);
            if (!r.ok) {
              setNote(r.reason ?? 'gagal');
              return;
            }
            studioActions.updateClip(clip.id, { gainDb: r.gainDb ?? 0 });
            setNote(`gain clip → ${(r.gainDb ?? 0) > 0 ? '+' : ''}${r.gainDb} dB`);
          }}
        >
          NORMALIZE
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canSplit}
          title={
            beat.snap && beat.grid !== null
              ? 'belah di ketukan terdekat dari playhead'
              : 'belah tepat di playhead'
          }
          onClick={() =>
            studioActions.splitClipAt(
              clip.id,
              beat.snap && beat.grid !== null ? beat.snapTimeline(playhead) : playhead,
            )
          }
        >
          SPLIT AT PLAYHEAD
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--cy-text-dim)' }}>
          {note ?? `gain clip ${clip.gainDb > 0 ? '+' : ''}${clip.gainDb.toFixed(1)} dB`}
        </span>
      </div>

      {/*
        Preset diberikan PER SISI, bukan ke "fade yang terakhir disentuh".
        Target implisit tidak terlihat di layar: user menekan `8s` dan baru tahu
        sisi mana yang berubah setelah nilainya berubah — dan yang tertimpa
        adalah fade yang sudah ia setel. Dua baris lima tombol kecil jauh lebih
        murah daripada satu keadaan tersembunyi.
      */}
      <FadeControls side="in" clip={clip} sampleRate={sampleRate} onSet={(ms) => setFade('in', ms)} />
      <FadeControls
        side="out"
        clip={clip}
        sampleRate={sampleRate}
        onSet={(ms) => setFade('out', ms)}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: '9px',
            letterSpacing: '.16em',
            color: 'var(--cy-text-muted)',
            width: '62px',
          }}
        >
          CURVE
        </span>
        <Button
          size="sm"
          variant={curve === 'linear' ? 'outline' : 'ghost'}
          onClick={() => studioActions.updateClip(clip.id, { fadeCurve: 'linear' })}
        >
          LINEAR
        </Button>
        <Button
          size="sm"
          variant={curve === 'equalPower' ? 'outline' : 'ghost'}
          onClick={() => studioActions.updateClip(clip.id, { fadeCurve: 'equalPower' })}
        >
          EQUAL-POWER
        </Button>
        <span style={{ fontSize: '10px', color: 'var(--cy-text-dim)' }}>
          {curve === 'linear'
            ? 'linear: untuk fade tunggal ke sunyi.'
            : 'equal-power: untuk transisi antar lagu — tanpa lubang di tengah.'}
        </span>
      </div>
    </div>
  );
}
