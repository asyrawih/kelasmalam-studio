/**
 * Dialog impor YouTube — HANYA desktop (docs/23).
 *
 * Tiga hal di satu layar: keadaan perkakas (yt-dlp + qjs sudah ada atau
 * belum, dengan tombol SIAPKAN / PERBARUI dan bar unduhannya), satu URL
 * yang dilihat dulu (judul, kanal, durasi, perkiraan ukuran) SEBELUM diunduh,
 * lalu + LANE yang mengunduh audionya dan menaruhnya di playhead lane yang
 * dipilih — jalur `importBytesToLane` yang sama dengan drop berkas.
 *
 * Perkakas diunduh dari dialog ini saja, tidak pernah diam-diam: 40 MB binari
 * yang turun karena satu link di-drop adalah kejutan, dan di sini barnya
 * kelihatan. Rendernya hanya di desktop (`App.tsx` memeriksa host); di web
 * tombol pembukanya pun tidak ada.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { studioActions, studioStore, useStudio } from '../studio/store';
import { importBytesToLane } from '../studio/timeline/audio-import';
import { Button, ProgressBar } from '../ui/cyber';
import { isLocalError } from '../platform/local-invoke';
import {
  formatYoutubeDuration,
  isYoutubeUrl,
  subscribeYoutubeProgress,
  youtubeAudio,
  youtubeFileName,
  youtubeInfo,
  youtubeSetup,
  youtubeStatus,
  youtubeUpdate,
  type YoutubeInfo,
  type YoutubeProgress,
  type YoutubeStatus,
} from './api';

export interface YouTubeDialogProps {
  readonly onClose: () => void;
}

type Busy = 'status' | 'setup' | 'update' | 'info' | 'add' | null;

const inputStyle = {
  minWidth: 0,
  height: 38,
  padding: '0 12px',
  color: 'var(--cy-text)',
  background: 'var(--cy-surface-2)',
  border: '1px solid var(--cy-border)',
} as const;

function reasonOf(cause: unknown): string {
  if (isLocalError(cause)) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return '';
  const mb = bytes / 1_000_000;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Bar per unduhan yang sedang berjalan, dari event progres. */
function ProgressRow({ progress }: { readonly progress: YoutubeProgress }): JSX.Element {
  const label = progress.phase === 'tools' ? `MENGUNDUH ${progress.name.toUpperCase()}` : 'MENGUNDUH AUDIO';
  const ratio = progress.total > 0 ? progress.done / progress.total : null;
  return (
    <div style={{ marginTop: 8 }}>
      <ProgressBar
        label={ratio === null ? `${label} · ${formatBytes(progress.done) || '…'}` : label}
        value={ratio === null ? 0 : ratio * 100}
        showValue={ratio !== null}
        indeterminate={ratio === null}
      />
    </div>
  );
}

export function YouTubeDialog({ onClose }: YouTubeDialogProps): JSX.Element {
  const lanes = useStudio((s) => s.lanes);
  const selectedLaneId = useStudio((s) => s.selectedLaneId);
  const [laneId, setLaneId] = useState(selectedLaneId ?? lanes[0]?.id ?? '');
  const [status, setStatus] = useState<YoutubeStatus | null>(null);
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState<YoutubeInfo | null>(null);
  const [busy, setBusy] = useState<Busy>('status');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Unduhan yang sedang berjalan, per nama (binari atau id video). */
  const [progress, setProgress] = useState<Readonly<Record<string, YoutubeProgress>>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void youtubeStatus()
      .then((s) => {
        if (alive.current) setStatus(s);
      })
      .catch((cause: unknown) => {
        if (alive.current) setError(reasonOf(cause));
      })
      .finally(() => {
        if (alive.current) setBusy(null);
      });
    const unsubscribe = subscribeYoutubeProgress((p) => {
      if (!alive.current) return;
      setProgress((cur) => ({ ...cur, [`${p.phase}:${p.name}`]: p }));
    });
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => {
      alive.current = false;
      unsubscribe();
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);

  const ready = status?.ready === true;
  const inputIsYoutube = useMemo(() => isYoutubeUrl(url), [url]);

  async function run<T>(label: Exclude<Busy, null>, work: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      return await work();
    } catch (cause: unknown) {
      if (alive.current) setError(reasonOf(cause));
      return null;
    } finally {
      if (alive.current) {
        setBusy(null);
        setProgress({});
      }
    }
  }

  async function setup(): Promise<void> {
    const s = await run('setup', youtubeSetup);
    if (s !== null && alive.current) {
      setStatus(s);
      setNotice(s.ready ? `yt-dlp ${s.ytDlpVersion ?? ''} terpasang` : 'perkakas terunduh tapi yt-dlp tidak menjawab');
    }
  }

  async function update(): Promise<void> {
    const changed = await run('update', youtubeUpdate);
    if (changed === null || !alive.current) return;
    const s = await youtubeStatus().catch(() => null);
    if (s !== null) setStatus(s);
    setNotice(changed ? `yt-dlp diperbarui ke ${s?.ytDlpVersion ?? 'rilis terbaru'}` : 'yt-dlp sudah yang terbaru');
  }

  async function lookUp(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = url.trim();
    if (value === '') return;
    if (!isYoutubeUrl(value)) {
      setError('bukan URL YouTube');
      return;
    }
    setInfo(null);
    const got = await run('info', () => youtubeInfo(value));
    if (got !== null && alive.current) setInfo(got);
  }

  async function add(): Promise<void> {
    if (info === null) return;
    if (laneId === '') {
      setError('Pilih lane tujuan terlebih dahulu.');
      return;
    }
    const target = info;
    const placed = await run('add', async () => {
      const bytes = await youtubeAudio(target.webpageUrl === '' ? url.trim() : target.webpageUrl);
      const state = studioStore.getState();
      const result = await importBytesToLane(
        bytes,
        youtubeFileName(target),
        laneId,
        state.playhead,
        state.sampleRate,
      );
      if (!result.ok) throw new Error(result.reason ?? 'gagal membuat clip');
      return true;
    });
    if (placed === true) {
      studioActions.selectLane(laneId);
      onClose();
    }
  }

  const statusText =
    status === null
      ? busy === 'status'
        ? 'MEMERIKSA PERKAKAS'
        : 'PERKAKAS TIDAK DIKETAHUI'
      : status.ready
        ? `SIAP · yt-dlp ${status.ytDlpVersion ?? ''}`
        : 'PERKAKAS BELUM ADA';
  const statusColor = status?.ready === true ? '#00ffc2' : status === null ? 'var(--cy-text-dim)' : '#ff708d';
  const running = Object.values(progress);

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        background: '#05090de8',
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="youtube-title"
        style={{
          width: 'min(720px, 100%)',
          maxHeight: 'min(720px, 92vh)',
          overflow: 'auto',
          border: '1px solid var(--cy-accent)',
          background: 'var(--cy-surface-1)',
          boxShadow: '0 24px 80px #000',
          padding: 20,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div>
            <h2 id="youtube-title" style={{ margin: 0, color: 'var(--cy-text)', fontSize: 18 }}>
              YOUTUBE IMPORT
            </h2>
            <div style={{ color: 'var(--cy-text-dim)', fontSize: 10, marginTop: 5 }}>
              TEMPEL URL · LIHAT · INSERT TO LANE · HANYA DESKTOP
            </div>
          </div>
          <span
            role="status"
            style={{ marginLeft: 'auto', color: statusColor, fontSize: 10, whiteSpace: 'nowrap' }}
          >
            ● {statusText}
          </span>
          <Button variant="ghost" onClick={onClose}>
            ✕ CLOSE
          </Button>
        </header>

        {/*
          Perkakas: yt-dlp (Unlicense) + qjs (QuickJS-NG, MIT), diunduh dari
          rilis resmi masing-masing ke folder data aplikasi. Dari sini saja —
          lihat kepala berkas.
        */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: 10,
            marginBottom: 12,
            border: '1px solid var(--cy-border)',
            background: 'var(--cy-surface-2)',
          }}
        >
          <div style={{ minWidth: 0, flex: 1, color: 'var(--cy-text-dim)', fontSize: 11 }}>
            {ready
              ? 'yt-dlp dan qjs ada di folder data aplikasi. PERBARUI mengganti yt-dlp kalau rilis terbarunya berbeda — YouTube sering berubah.'
              : 'Butuh dua binari yang diunduh sekali (± 40 MB): yt-dlp dari rilis resminya (diverifikasi SHA-256) dan qjs (QuickJS-NG) sebagai runtime JavaScript.'}
          </div>
          {ready ? (
            <Button variant="ghost" disabled={busy !== null} onClick={() => void update()}>
              {busy === 'update' ? 'MEMPERBARUI…' : 'PERBARUI'}
            </Button>
          ) : (
            <Button variant="outline" disabled={busy !== null || status === null} onClick={() => void setup()}>
              {busy === 'setup' ? 'MENGUNDUH…' : 'SIAPKAN'}
            </Button>
          )}
        </div>
        {running.map((p) => (
          <ProgressRow key={`${p.phase}:${p.name}`} progress={p} />
        ))}

        <form
          onSubmit={(e) => void lookUp(e)}
          style={{ display: 'grid', gridTemplateColumns: '1fr minmax(150px,220px) auto', gap: 10, marginTop: 12 }}
        >
          <input
            autoFocus
            aria-label="URL YouTube"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=… atau https://youtu.be/…"
            style={inputStyle}
          />
          <select aria-label="Lane tujuan" value={laneId} onChange={(e) => setLaneId(e.target.value)} style={inputStyle}>
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={busy !== null || !ready || !inputIsYoutube}>
            {busy === 'info' ? 'MEMBACA…' : 'LIHAT'}
          </Button>
        </form>

        {error !== null ? (
          <p role="alert" style={{ color: '#ff708d', fontSize: 11 }}>
            {error}
          </p>
        ) : null}
        {notice !== null ? (
          <p style={{ color: 'var(--cy-text-dim)', fontSize: 11 }}>{notice}</p>
        ) : null}

        {info !== null ? (
          <article
            aria-label={info.title}
            style={{
              display: 'grid',
              gridTemplateColumns: '96px minmax(120px,1fr) auto',
              alignItems: 'center',
              gap: 12,
              padding: 10,
              marginTop: 14,
              border: '1px solid var(--cy-border)',
              background: 'var(--cy-surface-2)',
            }}
          >
            {info.thumbnail !== null ? (
              <img
                src={info.thumbnail}
                alt=""
                width="96"
                height="54"
                referrerPolicy="no-referrer"
                style={{ display: 'block', width: 96, height: 54, objectFit: 'cover', border: '1px solid var(--cy-border)' }}
              />
            ) : (
              <div
                aria-hidden="true"
                style={{ width: 96, height: 54, display: 'grid', placeItems: 'center', border: '1px solid var(--cy-border)', color: '#ff708d', fontSize: 20 }}
              >
                ▶
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--cy-text)', fontSize: 12 }}>
                {info.title}
              </strong>
              <span style={{ color: 'var(--cy-text-dim)', fontSize: 10 }}>
                {[info.uploader, formatYoutubeDuration(info.durationSec), info.ext.toUpperCase(), formatBytes(info.bytes)]
                  .filter((s) => s !== '')
                  .join(' · ')}
              </span>
            </div>
            <Button variant="outline" disabled={busy !== null || laneId === ''} onClick={() => void add()}>
              {busy === 'add' ? 'IMPORTING…' : '+ LANE'}
            </Button>
          </article>
        ) : busy === null && ready ? (
          <p style={{ textAlign: 'center', color: 'var(--cy-text-dim)', fontSize: 11, padding: 28 }}>
            Tempel URL video, tekan LIHAT, lalu + LANE. Link YouTube yang di-drop atau di-paste ke lane juga lewat jalur ini.
          </p>
        ) : null}
      </section>
    </div>
  );
}
