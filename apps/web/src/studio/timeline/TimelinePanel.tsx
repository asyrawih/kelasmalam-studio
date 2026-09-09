/**
 * Card Timeline — pengatur semua bagian: toolbar zoom, ruler, kolom lane,
 * area clip yang menggulir, dan strip overview.
 *
 * Tiga hal yang dikerjakan di sini dan tidak di anak-anaknya, karena ketiganya
 * butuh elemen scroller yang sama:
 *   1. sinkronisasi ruler  (`marginLeft = -scrollLeft`, sama seperti design)
 *   2. matematika zoom     (FIT = null; selain itu px/detik, di-anchor ke kursor)
 *   3. `follow()`          (auto-scroll mengikuti playhead saat play)
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { Card } from '../../ui/cyber';
import { LANE_HEIGHT_IDS, findClip, samplesToSec } from '../model';
import { studioActions, useStudio } from '../store';
import { ClipArea } from './ClipArea';
import { ClipDetailDialog } from './ClipDetailDialog';
import { LaneHeaders } from './LaneHeaders';
import { useClipboardImport } from '../shortcuts/useClipboardImport';
import { DurationBounds } from './DurationBounds';
import { OverviewStrip } from './OverviewStrip';
import { TimelineRuler } from './TimelineRuler';

const ZOOM_BUTTON = {
  height: '28px',
  border: '1px solid var(--cy-border-strong)',
  background: 'var(--cy-surface-2)',
  color: 'var(--cy-text-dim)',
  fontFamily: 'var(--cy-font-mono)',
  cursor: 'pointer',
} as const;

export function TimelinePanel(): JSX.Element {
  const lanesCount = useStudio((s) => s.lanes.length);
  const lanes = useStudio((s) => s.lanes);
  const duration = useStudio((s) => s.duration);
  const sampleRate = useStudio((s) => s.sampleRate);
  const playhead = useStudio((s) => s.playhead);
  const playing = useStudio((s) => s.playing);
  const pxPerSecond = useStudio((s) => s.pxPerSecond);
  const selectedClipId = useStudio((s) => s.selectedClipId);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const scrubbingRef = useRef(false);
  const anchorRef = useRef<{ time: number; offsetX: number } | null>(null);

  const [view, setView] = useState({ left: 0, width: 100 });
  const [fitPxPerSec, setFitPxPerSec] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  /**
   * Dialog Clip Detail, dibuka double-click di area clip.
   *
   * State-nya duduk DI SINI, bukan di dalam `ClipArea`: dialog dipasang lewat
   * portal, dan React tetap mengalirkan event-nya menyusuri POHON REACT, bukan
   * pohon DOM. Dipasang di dalam scroller, setiap pointerdown di dalam dialog
   * (menarik handle fade, menekan tombol) akan sampai ke `beginBackgroundDrag`
   * milik scroller dan memulai kotak seleksi di belakang dialog.
   *
   * Sengaja tidak disimpan di store: ini keadaan sesi yang paling pendek
   * umurnya — sama seperti `maximizedPanel`, membukanya kembali sendiri setelah
   * refresh hanya akan menutupi timeline tanpa diminta.
   */
  const [detailOpen, setDetailOpen] = useState(false);
  // Tempel URL dari clipboard → clip. Dipasang di sini supaya pesan gagalnya
  // muncul di tempat yang sama dengan kegagalan drop file.
  useClipboardImport(setImportError);

  const durationSec = duration > 0 ? samplesToSec(duration, sampleRate) : 0;
  const trackWidth =
    pxPerSecond === null ? '100%' : `${Math.round(Math.max(1, durationSec * pxPerSecond))}px`;

  /** Ruler + kotak viewport overview mengikuti scroll. */
  const syncView = useCallback((): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const total = el.scrollWidth;
    if (rulerRef.current !== null) {
      rulerRef.current.style.marginLeft = `${-el.scrollLeft}px`;
    }
    // Guard pembagian nol: sebelum layout, scrollWidth = 0.
    if (total <= 0) return;
    const next = {
      left: (el.scrollLeft / total) * 100,
      width: Math.min(100, (el.clientWidth / total) * 100),
    };
    setView((cur) => (cur.left === next.left && cur.width === next.width ? cur : next));
    const perSec = durationSec > 0 ? el.clientWidth / durationSec : 0;
    setFitPxPerSec((cur) => (Math.abs(cur - perSec) < 0.01 ? cur : perSec));
  }, [durationSec]);

  // Sinkronisasi awal + saat ukuran container berubah.
  useEffect(() => {
    syncView();
    const el = scrollerRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => syncView());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncView]);

  // Setelah zoom berubah, kembalikan titik waktu yang tadi ada di bawah kursor
  // ke posisi piksel yang sama — zoom "tentang pointer".
  useLayoutEffect(() => {
    syncView();
    const el = scrollerRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (el === null || anchor === null || durationSec <= 0 || el.scrollWidth <= 0) return;
    const target = (anchor.time / durationSec) * el.scrollWidth - anchor.offsetX;
    el.scrollLeft = Math.max(0, target);
    syncView();
  }, [pxPerSecond, durationSec, syncView]);

  /** Zoom relatif. Basis saat FIT adalah px/detik efektif yang sedang tampil. */
  const zoomBy = useCallback(
    (mult: number, anchor?: { time: number; offsetX: number }): void => {
      const el = scrollerRef.current;
      const base =
        pxPerSecond ?? (el !== null && durationSec > 0 ? el.clientWidth / durationSec : 0);
      const safeBase = base > 0 ? base : 10;
      if (anchor !== undefined) anchorRef.current = anchor;
      studioActions.setZoom(safeBase * mult);
    },
    [pxPerSecond, durationSec],
  );

  /**
   * `wheel` → zoom.
   *
   * Dipasang manual, BUKAN lewat `onWheel` React: React memasang listener wheel
   * sebagai passive, sehingga `preventDefault()` diabaikan dan halaman ikut
   * menggulir saat user men-zoom.
   *
   * Dipasang di SELURUH KARTU timeline, bukan hanya di area clip yang
   * menggulir. Aturannya jadi satu kalimat yang bisa dipegang: **kursor di
   * timeline → gulir berarti zoom, halaman tidak ikut bergerak.**
   *
   * Dua versi sebelumnya salah karena membelah kartu ini jadi zona-zona.
   * Mula-mula hanya area clip; lalu badan timeline tanpa toolbar. Keduanya
   * membuat "scroll = zoom" bekerja atau tidak tergantung beberapa piksel
   * posisi kursor — dan batas zonanya tidak terlihat sama sekali di layar.
   * Fitur yang benar separuh waktu lebih membingungkan daripada fitur yang
   * tidak ada.
   *
   * Halaman tetap bisa digulir: arahkan kursor ke panel lain (Clip Detail,
   * rail) atau ke ruang di luar kartu.
   */
  useEffect(() => {
    const body = cardRef.current;
    if (body === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) < 1) return;
      const el = scrollerRef.current;
      if (el === null) return;
      e.preventDefault();
      if (e.shiftKey) {
        // Wheel vertikal paling mudah dijangkau mouse. Dengan Shift, gunakan
        // delta itu untuk menggulir timeline secara horizontal.
        el.scrollLeft += e.deltaY;
        syncView();
        return;
      }
      const rect = el.getBoundingClientRect();
      // Kursor bisa berada di kolom nama lane (di kiri area gulir), jadi
      // offsetnya DIJEPIT: zoom berjangkar di tepi terdekat, bukan di titik
      // negatif yang membuat timeline melompat jauh.
      const offsetX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const total = el.scrollWidth;
      const time = total > 0 ? ((el.scrollLeft + offsetX) / total) * durationSec : 0;
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, { time, offsetX });
    };
    body.addEventListener('wheel', onWheel, { passive: false });
    return () => body.removeEventListener('wheel', onWheel);
  }, [zoomBy, durationSec, syncView]);

  // follow(): jaga playhead tetap terlihat. Tidak saat FIT (seluruh project
  // sudah terlihat) dan tidak saat user sedang men-drag.
  useEffect(() => {
    const el = scrollerRef.current;
    // Auto-follow tidak boleh melawan user: mati saat pan DAN saat scrub.
    if (el === null || pxPerSecond === null || draggingRef.current || scrubbingRef.current || !playing)
      return;
    const total = el.scrollWidth;
    if (total <= 0 || duration <= 0) return;
    const x = total * (playhead / duration);
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth * 0.9) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
      syncView();
    }
  }, [playhead, playing, pxPerSecond, duration, syncView]);

  const laneHeight = useStudio((s) => s.laneHeight);
  const selectedCount = useStudio((s) => s.selectedClipIds.length);
  const sel = findClip(lanes, selectedClipId);
  /**
   * SCRUB: drag playhead di ruler.
   *
   * Konversi x→waktu memakai rect dari track DALAM ruler (`rulerRef`), bukan
   * elemen luarnya. Track dalam sudah digeser `marginLeft = -scrollLeft`, jadi
   * rect-nya otomatis memperhitungkan posisi scroll DAN zoom — tidak perlu
   * menambahkan scrollLeft secara manual (sumber off-by-one klasik).
   */
  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = rulerRef.current;
      if (track === null) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0 || durationSec <= 0) return; // hindari NaN
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      studioActions.setPlayhead(Math.round(frac * durationSec * sampleRate));
    },
    [durationSec, sampleRate],
  );

  const onScrubDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Cegah drag-select bawaan browser: tanpa ini, gerakan mouse menyeret
      // seleksi teks label ruler alih-alih menggeser playhead.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubbingRef.current = true;
      // Transport TIDAK dihentikan. Dulu iya — alasannya "posisi akhir jadi
      // tidak pasti kalau audio langsung lanjut". Yang menjawab itu sekarang
      // bukan diam, melainkan scrub audio: selama digeser, yang terdengar
      // adalah butiran materi DI BAWAH playhead (`scrubTo`), jadi posisinya
      // justru dinilai dengan telinga, bukan ditebak. Begitu dilepas, `endScrub`
      // menaikkan `seekEpoch` dan lagu lanjut dari titik yang baru.
      studioActions.beginScrub();
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );

  const onScrubMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!scrubbingRef.current) return;
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );

  const onScrubUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Melepas drag = titik di mana audio dijadwalkan ulang dari posisi baru.
    studioActions.endScrub();
  }, []);

  const zoomLabel =
    pxPerSecond === null ? `FIT · ${Math.round(fitPxPerSec)} px/s` : `${Math.round(pxPerSecond)} px/s`;

  return (
    <div ref={cardRef} data-tl-card>
      <Card
        title="Timeline"
        subtitle="klik lane kosong = pilih berkas · drag = pilih area · Shift+drag = pan · Shift+scroll = gulir timeline · scroll = zoom · Space = play 3 dtk sebelum cursor"
        notched
        glow
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '10px',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            aria-label="zoom out"
            className="cy-hover-accent-border"
            onClick={() => zoomBy(1 / 1.6)}
            style={{ ...ZOOM_BUTTON, width: '32px', fontSize: '13px' }}
          >
            −
          </button>
          <button
            type="button"
            aria-label="zoom in"
            className="cy-hover-accent-border"
            onClick={() => zoomBy(1.6)}
            style={{ ...ZOOM_BUTTON, width: '32px', fontSize: '13px' }}
          >
            +
          </button>
          <button
            type="button"
            className="cy-hover-accent-border"
            onClick={() => studioActions.setZoom(null)}
            style={{ ...ZOOM_BUTTON, padding: '0 10px', fontSize: '10px' }}
          >
            FIT
          </button>
          <span style={{ fontSize: '10px', letterSpacing: '.12em', color: 'var(--cy-accent)' }}>
            {zoomLabel}
          </span>
          {/* Tinggi lane. Di samping zoom karena keduanya menjawab pertanyaan yang
              sama — "seberapa besar materinya di layar" — hanya sumbunya beda. */}
          <span
            style={{
              marginLeft: '6px',
              fontSize: '9px',
              letterSpacing: '.16em',
              color: 'var(--cy-text-muted)',
            }}
          >
            H
          </span>
          {LANE_HEIGHT_IDS.map((id) => (
            <button
              key={id}
              type="button"
              aria-label={`tinggi lane ${id}`}
              aria-pressed={laneHeight === id}
              className="cy-hover-accent-border"
              onClick={() => studioActions.setLaneHeight(id)}
              style={{
                ...ZOOM_BUTTON,
                width: '26px',
                fontSize: '10px',
                color: laneHeight === id ? 'var(--cy-accent)' : 'var(--cy-text-dim)',
                borderColor: laneHeight === id ? 'var(--cy-accent)' : 'var(--cy-border)',
              }}
            >
              {id}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--cy-text-dim)' }}>
            {selectedCount > 1
              ? `SELECTED: ${selectedCount} CLIP`
              : sel === null
                ? 'NO CLIP SELECTED'
                : `SELECTED: ${sel.clip.label}`}
          </span>
          <button
            type="button"
            className="cy-hover-accent-border"
            onClick={() => studioActions.addLane()}
            style={{
              height: '28px',
              padding: '0 12px',
              border: '1px dashed var(--cy-border-strong)',
              background: 'transparent',
              color: 'var(--cy-text-muted)',
              fontFamily: 'var(--cy-font-mono)',
              fontSize: '10px',
              letterSpacing: '.12em',
              cursor: 'pointer',
            }}
          >
            + LANE
          </button>
        </div>

        <div
          data-tl-body
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,148px) minmax(0,1fr)',
            border: '1px solid var(--cy-border)',
            background: '#000',
            maxWidth: '100%',
          }}
        >
          <div
            style={{
              borderRight: '1px solid var(--cy-border)',
              borderBottom: '1px solid var(--cy-border)',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              padding: '0 10px',
              fontSize: '9px',
              letterSpacing: '.18em',
              color: 'var(--cy-text-muted)',
            }}
          >
            LANES
          </div>
          <TimelineRuler
            ref={rulerRef}
            durationSec={durationSec}
            pxPerSecond={pxPerSecond}
            trackWidth={trackWidth}
            onScrubDown={onScrubDown}
            onScrubMove={onScrubMove}
            onScrubUp={onScrubUp}
          />
          <div
            style={{
              gridColumn: 'span 2',
              display: 'grid',
              gridTemplateColumns: 'minmax(0,148px) minmax(0,1fr)',
            }}
          >
            <LaneHeaders />
            <ClipArea
              scrollerRef={scrollerRef}
              trackWidth={trackWidth}
              onScroll={syncView}
              onDraggingChange={(d) => {
                draggingRef.current = d;
              }}
              onImportError={setImportError}
              onOpenDetail={() => setDetailOpen(true)}
            />
          </div>
        </div>

        <OverviewStrip viewLeftPct={view.left} viewWidthPct={view.width} />
        <DurationBounds />

        {importError !== null ? (
          <div style={{ marginTop: '8px', fontSize: '10px', color: '#ff4d4d' }}>
            IMPORT GAGAL — {importError}
          </div>
        ) : null}
        {lanesCount === 0 ? (
          <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--cy-text-muted)' }}>
            TIDAK ADA LANE — TEKAN “+ LANE”
          </div>
        ) : null}
      </Card>
      {/* Di luar <Card>, tapi masih di dalam pohon React timeline: isinya
          membaca clip yang dipajang dari <BeatProvider> di akar aplikasi. */}
      {detailOpen ? <ClipDetailDialog onClose={() => setDetailOpen(false)} /> : null}
    </div>
  );
}
