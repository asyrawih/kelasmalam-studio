/**
 * Card Clip Detail — waveform clip terpilih + aksi edit.
 *
 * Saat tidak ada seleksi, design menyembunyikan seluruh blok waveform
 * (`sc-if hasSel`) dan hanya menyisakan judul "PILIH CLIP DI TIMELINE".
 *
 * CATATAN KEJUJURAN: dari tombol aksi, hanya SPLIT AT PLAYHEAD yang murni
 * operasi timeline sehingga bisa dikerjakan sekarang. TRIM/NORMALIZE mengubah
 * audio dan butuh engine; sampai engine ada, tombolnya dinonaktifkan dengan
 * alasan yang terbaca, bukan diam-diam tidak melakukan apa-apa.
 *
 * FADE DIEDIT DENGAN MENARIK, BUKAN DENGAN MENGETIK. Versi sebelumnya memberi
 * dua tombol on/off 1000 ms plus dua kolom milidetik. Itu alat yang salah untuk
 * pekerjaan yang sebenarnya: transisi antar lagu panjangnya 4–16 detik dan
 * dinilai dengan telinga sambil melihat waveform — panjangnya tidak pernah
 * ditemukan dengan mengetik "6500". Karena itu handle-nya ada DI ATAS waveform,
 * bentuk kurvanya digambar di tempat yang sama, dan angkanya dalam detik.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Button, Card } from '../../ui/cyber';
import { useCanvasDraw } from '../../ui/lib/canvas';
import {
  DEFAULT_FADE_CURVE,
  findClip,
  formatTime,
  samplesToSec,
  type FadeCurve,
  type StudioClip,
} from '../model';
import { studioActions, useStudio, type StudioAsset } from '../store';
import {
  clampFadeMs,
  fadeInGain,
  fadeOutGain,
  FADE_PRESET_SEC,
  msToSec,
  samplesToFadeMs,
  secToMs,
  type FadeSide,
} from './fade';
import { computeNormalizeGain, NORMALIZE_TARGET_DB } from './normalize';
import { clipDetailGradient, drawClipWave } from './waveform';

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
}: {
  asset: StudioAsset | undefined;
  sourceStart: number;
  sourceLen: number;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasDraw(
    ref,
    (ctx, size) => {
      const gradient = clipDetailGradient(ctx, size.height);
      drawClipWave(ctx, asset, sourceStart, sourceLen, size.width, size.height, size.dpr, {
        outline: gradient,
        body: gradient,
        // Outline lebih redup dari badan: transien tetap terlihat sebagai
        // "kabut" di luar, energi utama tetap pekat di dalam.
        outlineAlpha: 0.55,
        bodyAlpha: 0.9,
        centerLine: '#ffd40024',
      });
    },
    [asset, sourceStart, sourceLen],
  );
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}

/**
 * Overlay fade: bidang teredam + GARIS GAIN SUNGGUHAN melintasi daerah fade.
 *
 * Kurvanya dihitung dari fungsi yang sama dengan yang dipakai audio, jadi garis
 * yang dilihat user adalah gain yang benar-benar akan terdengar. Menggambar
 * garis lurus untuk kedua kurva akan membuat pilihan LINEAR/EQUAL-POWER tampak
 * tidak berefek apa pun.
 */
function FadeOverlay({
  curve,
  inFrac,
  outFrac,
}: {
  readonly curve: FadeCurve;
  readonly inFrac: number;
  readonly outFrac: number;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasDraw(
    ref,
    (ctx, size) => {
      ctx.clearRect(0, 0, size.width, size.height);
      const { width: w, height: h } = size;

      const region = (fromX: number, toX: number, gainAt: (t: number) => number): void => {
        const span = toX - fromX;
        if (span <= 0) return;
        const steps = Math.max(8, Math.round(span));
        // 1. Bidang gelap DI ATAS kurva — bagian sinyal yang dibuang.
        ctx.beginPath();
        ctx.moveTo(fromX, 0);
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          ctx.lineTo(fromX + span * t, h * (1 - gainAt(t)));
        }
        ctx.lineTo(toX, 0);
        ctx.closePath();
        ctx.fillStyle = '#000000b3';
        ctx.fill();
        // 2. Garis kurvanya sendiri, warna aksen.
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = fromX + span * t;
          const y = h * (1 - gainAt(t));
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#ffd400';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      };

      if (inFrac > 0) region(0, w * inFrac, (t) => fadeInGain(curve, t));
      if (outFrac > 0) region(w * (1 - outFrac), w, (t) => fadeOutGain(curve, t));
    },
    [curve, inFrac, outFrac],
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
  fracOfClip,
  valueMs,
  dragging,
  onDrag,
  onReset,
  onNudge,
  onFocus,
}: {
  readonly side: FadeSide;
  readonly fracOfClip: number;
  readonly valueMs: number;
  readonly dragging: boolean;
  readonly onDrag: (fracOfClip: number) => void;
  readonly onReset: () => void;
  readonly onNudge: (deltaSec: number) => void;
  readonly onFocus: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);

  const posPct = side === 'in' ? fracOfClip * 100 : (1 - fracOfClip) * 100;

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
    const x = (e.clientX - rect.left) / rect.width;
    // Ke DALAM clip = fade lebih panjang. Untuk fade-out arahnya cermin.
    onDrag(side === 'in' ? x : 1 - x);
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

export function ClipDetailPanel(): JSX.Element {
  const lanes = useStudio((s) => s.lanes);
  const assets = useStudio((s) => s.assets);
  const selectedClipId = useStudio((s) => s.selectedClipId);
  const sampleRate = useStudio((s) => s.sampleRate);
  const playhead = useStudio((s) => s.playhead);
  const engineReady = useStudio((s) => s.engineReady);
  const [note, setNote] = useState<string | null>(null);
  const [dragSide, setDragSide] = useState<FadeSide | null>(null);

  const sel = findClip(lanes, selectedClipId);
  const startSec = sel === null ? 0 : samplesToSec(sel.clip.start, sampleRate);
  const lenSec = sel === null ? 0 : samplesToSec(sel.clip.len, sampleRate);
  const canSplit =
    sel !== null && playhead > sel.clip.start && playhead < sel.clip.start + sel.clip.len;

  // "Sudah dinormalisasi" = gain clip sudah digeser dari 0. Dipakai untuk
  // membuat tombolnya bisa dibatalkan, bukan sekali jalan.
  const normalized = sel !== null && Math.abs(sel.clip.gainDb) > 0.001;

  const clip = sel?.clip;
  const clipMs = clip === undefined ? 0 : samplesToFadeMs(clip.len, sampleRate);
  const curve: FadeCurve = clip?.fadeCurve === 'linear' ? 'linear' : DEFAULT_FADE_CURVE;

  /** Semua jalur (drag, keyboard, preset, ketik) lewat satu pintu ber-clamp. */
  const setFade = (side: FadeSide, ms: number): void => {
    if (clip === undefined) return;
    const v = Math.round(clampFadeMs(clip, side, ms, sampleRate));
    studioActions.updateClip(clip.id, side === 'in' ? { fadeInMs: v } : { fadeOutMs: v });
  };

  const inFrac = clipMs > 0 ? Math.min(1, (clip?.fadeInMs ?? 0) / clipMs) : 0;
  const outFrac = clipMs > 0 ? Math.min(1, (clip?.fadeOutMs ?? 0) / clipMs) : 0;

  return (
    <Card title="Clip Detail" subtitle="waveform dari clip yang dipilih" notched live>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '12px',
          marginBottom: '10px',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--cy-font-sans)',
            fontSize: '17px',
            fontWeight: 600,
            color: sel === null ? 'var(--cy-text-muted)' : sel.lane.color,
            letterSpacing: '.04em',
          }}
        >
          {sel === null ? 'PILIH CLIP DI TIMELINE' : sel.clip.label}
        </span>
        <span style={{ fontSize: '10px', letterSpacing: '.12em', color: 'var(--cy-text-dim)' }}>
          {sel === null
            ? '—'
            : `${sel.lane.name} · ${formatTime(startSec)} → ${formatTime(startSec + lenSec)} · ${lenSec.toFixed(1)} s`}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--cy-text-muted)' }}>
          {(sel === null ? 0 : sel.clip.len).toLocaleString('en-US')} samples
        </span>
      </div>

      {sel !== null && clip !== undefined ? (
        <>
          <div
            style={{
              position: 'relative',
              height: `${WAVE_HEIGHT}px`,
              background: '#000',
              border: '1px solid var(--cy-border)',
              // `overflow: visible` supaya handle di sudut tidak terpotong.
              overflow: 'visible',
              touchAction: 'none',
            }}
          >
            {/* Garis tengah ikut digambar di canvas (warna sama), jadi tidak
                ada lagi overlay DOM terpisah yang bisa desinkron dengannya. */}
            <DetailWave
              asset={assets[clip.assetId]}
              sourceStart={clip.sourceStart}
              sourceLen={clip.sourceLen}
            />
            <FadeOverlay curve={curve} inFrac={inFrac} outFrac={outFrac} />
            <FadeHandle
              side="in"
              fracOfClip={inFrac}
              valueMs={clip.fadeInMs}
              dragging={dragSide === 'in'}
              onFocus={() => setDragSide('in')}
              onDrag={(f) => setFade('in', f * clipMs)}
              onReset={() => setFade('in', 0)}
              onNudge={(d) => setFade('in', clip.fadeInMs + secToMs(d))}
            />
            <FadeHandle
              side="out"
              fracOfClip={outFrac}
              valueMs={clip.fadeOutMs}
              dragging={dragSide === 'out'}
              onFocus={() => setDragSide('out')}
              onDrag={(f) => setFade('out', f * clipMs)}
              onReset={() => setFade('out', 0)}
              onNudge={(d) => setFade('out', clip.fadeOutMs + secToMs(d))}
            />
            {/* Pembacaan langsung dalam DETIK — satuan yang dipakai orang untuk
                menilai transisi. Selalu terlihat, bukan hanya saat drag: nilai
                yang hilang begitu pointer dilepas tidak bisa dibandingkan. */}
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
              <span>IN {fmtSec(clip.fadeInMs)}</span>
              <span>OUT {fmtSec(clip.fadeOutMs)}</span>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '8px',
              marginTop: '12px',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={!engineReady}
              title={engineReady ? undefined : 'butuh engine audio'}
            >
              TRIM
            </Button>
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
              onClick={() => studioActions.splitClipAtPlayhead(clip.id)}
            >
              SPLIT AT PLAYHEAD
            </Button>
            <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--cy-text-dim)' }}>
              {note ?? 'edit di sini hanya mempengaruhi clip terpilih'}
            </span>
          </div>

          {/*
            Preset diberikan PER SISI, bukan ke "fade yang terakhir disentuh".
            Target implisit tidak terlihat di layar: user menekan `8s` dan baru
            tahu sisi mana yang berubah setelah nilainya berubah — dan yang
            tertimpa adalah fade yang sudah ia setel. Dua baris lima tombol
            kecil jauh lebih murah daripada satu keadaan tersembunyi.
          */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              marginTop: '12px',
              paddingTop: '10px',
              borderTop: '1px solid var(--cy-border)',
            }}
          >
            <FadeControls
              side="in"
              clip={clip}
              sampleRate={sampleRate}
              onSet={(ms) => setFade('in', ms)}
            />
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
              <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--cy-text-dim)' }}>
                gain clip {clip.gainDb > 0 ? '+' : ''}
                {clip.gainDb.toFixed(1)} dB
              </span>
            </div>
          </div>
        </>
      ) : null}
    </Card>
  );
}
