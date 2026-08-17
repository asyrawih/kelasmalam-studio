/**
 * Compile — pemilih format, statistik export, progress, dan tombol download.
 *
 * Seluruh statistik dihitung dari state store (design meng-hardcode-nya).
 */

import { useRef, useState } from 'react';
import { Card, ProgressBar } from '../../ui/cyber';
import { formatTime, isAudible, type ExportFormat, type StudioState } from '../model';
import { hasRenderableAudio } from '../preview/audio-preview';
import { runCompile, useExportAvailability } from './export-bridge';
import { studioActions, useStudio } from './store-adapter';

const FORMATS: readonly ExportFormat[] = ['AUTO', 'WAV', 'MP3'];

/** AUTO = WAV: default paling aman (lossless, tanpa dependensi encoder lossy). */
export const resolveFormat = (f: ExportFormat): 'WAV' | 'MP3' => (f === 'MP3' ? 'MP3' : 'WAV');

/** Kedalaman bit WAV yang di-encode Rust (docs/03 §3b). */
const WAV_DEPTHS = [16, 24, 32] as const;
type WavDepth = (typeof WAV_DEPTHS)[number];

/** WAV 16-bit PCM stereo — kedalaman default export. */
const WAV_BITS: WavDepth = 16;
const MP3_KBPS = 192;
const CHANNELS = 2;

export interface CompileStats {
  activeLanes: number;
  outputSeconds: number;
  bytes: number;
  label: string;
}

/** Statistik export dari state nyata. Diekspor supaya bisa dites terpisah. */
export function computeStats(state: StudioState, wavBits: WavDepth = WAV_BITS): CompileStats {
  const activeLanes = state.lanes.filter(
    (l) => l.clips.length > 0 && isAudible(l, state.lanes),
  ).length;

  // Panjang output = ujung clip terjauh pada lane yang terdengar; kalau tidak
  // ada clip sama sekali, 0 (bukan panjang timeline — kita tidak me-render
  // dua menit senyap).
  let endSample = 0;
  for (const lane of state.lanes) {
    if (!isAudible(lane, state.lanes)) continue;
    for (const c of lane.clips) endSample = Math.max(endSample, c.start + c.len);
  }
  const sr = state.sampleRate > 0 ? state.sampleRate : 48_000;
  // Varispeed: memutar 2x lebih cepat menghasilkan file separuh panjangnya.
  const speed = state.speed > 0 ? state.speed : 1;
  const outputSeconds = endSample / sr / speed;

  const fmt = resolveFormat(state.format);
  const bytes =
    fmt === 'WAV'
      ? 44 + outputSeconds * sr * CHANNELS * (wavBits / 8)
      : (outputSeconds * MP3_KBPS * 1000) / 8;

  return {
    activeLanes,
    outputSeconds,
    bytes,
    label: fmt === 'WAV' ? `WAV ${wavBits}-bit` : `MP3 ${MP3_KBPS} kbps`,
  };
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
}

function StatRow({ k, v, accent }: { k: string; v: string; accent?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex' }}>
      <span>{k}</span>
      <span style={{ marginLeft: 'auto', color: accent ? 'var(--cy-accent)' : 'var(--cy-text)' }}>
        {v}
      </span>
    </div>
  );
}

export function CompileCard(): JSX.Element {
  // Stats butuh banyak irisan sekaligus; berlangganan seluruh state di SATU
  // tempat (referensinya stabil — store menyimpan objek itu sendiri).
  const state = useStudio((s) => s);
  const engine = useExportAvailability();
  const [wavBits, setWavBits] = useState<WavDepth>(WAV_BITS);
  const stats = computeStats(state, wavBits);
  // Progress hidup di store (`exportProgress`, null saat idle) — supaya bagian
  // UI lain bisa ikut menampilkannya. Error export lokal saja.
  const [error, setError] = useState<string | null>(null);
  // Selisih antara yang didengar user dan yang akan ditulis ke file. Ditampilkan
  // SELALU kalau ada — export yang diam-diam berbeda dari preview adalah bug
  // yang paling mahal untuk ditemukan user sendiri (docs/03).
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  // Ref, bukan state: pembatalan dibaca dari dalam loop render yang sedang
  // berjalan, dan nilai dari closure state akan selamanya `false` di sana.
  const cancelRef = useRef(false);
  const progress = state.exportProgress;

  const exporting = progress !== null;
  // DUA syarat berbeda, dan alasannya harus dibedakan: timeline boleh penuh
  // clip tapi tidak ada satu pun yang punya PCM (clip demo, atau asset yang
  // belum selesai di-decode). Menyebut keduanya "tidak ada clip" akan membuat
  // user mencari-cari clip yang jelas-jelas ada di layar.
  const noAudibleClip = stats.outputSeconds <= 0;
  const noPcm = !noAudibleClip && !hasRenderableAudio(state);
  const disabled = !engine.ready || exporting || noAudibleClip || noPcm;
  const reason = !engine.ready
    ? engine.reason
    : noAudibleClip
      ? 'Tidak ada clip yang terdengar untuk di-render.'
      : noPcm
        ? 'Clip yang terdengar belum punya audio (PCM belum dimuat).'
        : exporting
          ? 'Export sedang berjalan.'
          : 'Render semua lane jadi satu file dan unduh.';

  return (
    <Card title="Compile" subtitle="semua lane → satu file" notched>
      <div style={{ display: 'grid', gap: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '4px' }}>
          {FORMATS.map((f) => {
            const active = state.format === f;
            return (
              <button
                key={f}
                type="button"
                className="cy-btn-reset cy-hover-accent-border"
                aria-pressed={active}
                onClick={() => studioActions.setFormat(f)}
                style={{
                  height: '30px',
                  border: '1px solid var(--cy-border)',
                  background: active ? 'var(--cy-accent)' : 'transparent',
                  color: active ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
                  fontFamily: 'var(--cy-font-mono)',
                  fontSize: '10px',
                  cursor: 'pointer',
                }}
              >
                {f}
              </button>
            );
          })}
        </div>

        {resolveFormat(state.format) === 'WAV' ? (
          <div
            role="group"
            aria-label="Kedalaman bit WAV"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '4px' }}
          >
            {WAV_DEPTHS.map((d) => {
              const active = wavBits === d;
              return (
                <button
                  key={d}
                  type="button"
                  className="cy-btn-reset cy-hover-accent-border"
                  aria-pressed={active}
                  disabled={exporting}
                  onClick={() => setWavBits(d)}
                  style={{
                    height: '24px',
                    border: '1px solid var(--cy-border)',
                    background: 'transparent',
                    color: active ? 'var(--cy-accent)' : 'var(--cy-text-muted)',
                    fontFamily: 'var(--cy-font-mono)',
                    fontSize: '9px',
                    cursor: exporting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {d === 32 ? 'F32' : `${d}-BIT`}
                </button>
              );
            })}
          </div>
        ) : null}

        <div style={{ display: 'grid', gap: '5px', fontSize: '10px', color: 'var(--cy-text-dim)' }}>
          <StatRow k="lanes aktif" v={String(stats.activeLanes)} />
          <StatRow k="panjang output" v={formatTime(stats.outputSeconds)} />
          <StatRow k="render speed" v={`${state.speed}x`} />
          <StatRow k="estimasi size" v={`${formatSize(stats.bytes)} · ${stats.label}`} accent />
        </div>

        <ProgressBar label="Mixdown" value={(progress ?? 0) * 100} showValue />

        <button
          type="button"
          className="cy-btn-reset cy-hover-accent-bg"
          disabled={disabled}
          title={reason}
          onClick={() => {
            setError(null);
            setWarnings([]);
            cancelRef.current = false;
            studioActions.setExportProgress(0);
            void runCompile({
              format: resolveFormat(state.format) === 'MP3' ? 'mp3' : 'wav',
              fileName: state.projectName.replace(/\.[^.]*$/, '') || 'mixdown',
              bitDepth: wavBits,
              quality: MP3_KBPS,
              onProgress: studioActions.setExportProgress,
              onWarnings: setWarnings,
              isCancelled: () => cancelRef.current,
            }).catch((e: unknown) => {
              studioActions.setExportProgress(null);
              setError(e instanceof Error ? e.message : String(e));
            });
          }}
          style={{
            width: '100%',
            height: '40px',
            border: '1px solid var(--cy-accent)',
            background: 'var(--cy-accent)',
            color: 'var(--cy-text-on-accent)',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '11px',
            letterSpacing: '.16em',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
            clipPath:
              'polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)',
          }}
        >
          ↓ COMPILE + DOWNLOAD
        </button>

        {exporting ? (
          <button
            type="button"
            className="cy-btn-reset"
            onClick={() => {
              cancelRef.current = true;
            }}
            style={{
              width: '100%',
              height: '26px',
              border: '1px solid var(--cy-border)',
              background: 'transparent',
              color: 'var(--cy-text-dim)',
              fontFamily: 'var(--cy-font-mono)',
              fontSize: '10px',
              letterSpacing: '.14em',
              cursor: 'pointer',
            }}
          >
            BATALKAN
          </button>
        ) : null}

        {warnings.length > 0 ? (
          <div
            role="status"
            style={{
              display: 'grid',
              gap: '3px',
              fontSize: '9px',
              lineHeight: 1.5,
              color: '#ffb020',
              border: '1px solid #ffb02055',
              padding: '6px',
            }}
          >
            <div style={{ letterSpacing: '.12em' }}>FILE AKAN BERBEDA DARI PREVIEW:</div>
            {warnings.map((w) => (
              <div key={w}>· {w}</div>
            ))}
          </div>
        ) : null}

        {!engine.ready ? (
          <div
            title={engine.reason}
            style={{ fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-text-muted)' }}
          >
            ENGINE BELUM DIBANGUN · EXPORT NONAKTIF
          </div>
        ) : null}
        {error !== null ? (
          <div style={{ fontSize: '9px', letterSpacing: '.1em', color: '#ff4d4d' }}>{error}</div>
        ) : null}
      </div>
    </Card>
  );
}
