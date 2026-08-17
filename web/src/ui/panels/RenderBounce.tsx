/**
 * Render / Bounce — `span 4` di design, di bawah Automation Lane.
 *
 * Design: ProgressBar berlabel `Master · WAV 24-bit` dengan showValue, lalu
 * tombol EXPORT (solid) + CANCEL (ghost) dan `ETA 00:11` rata kanan 10px.
 *
 * Diperluas sesuai docs/08 §Render / Bounce: pilihan format (WAV/MP3/OGG),
 * bit depth, dan rentang (project / selection / loop). Penambahan itu memakai
 * `Button` dan `Badge` yang sudah ada supaya tidak memperkenalkan bahasa
 * visual baru.
 *
 * Ini satu-satunya panel yang TIDAK berbicara ke audio thread sama sekali —
 * ia berbicara ke export worker (docs/03). Karena worker butuh snapshot
 * project ter-serialisasi dari Rust (`EngineClient.startExport({ snapshot })`)
 * dan serializer itu belum ada, tombol EXPORT dinonaktifkan dengan alasan yang
 * terbaca di tooltip — bukan diam-diam tidak melakukan apa-apa.
 */

import { Badge, Button, Card, ProgressBar } from '../cyber';
import { useUiStore } from '../../state';
import { uiActions } from '../../state/store';
import type { ExportJobState } from '../../state/store';

const FORMATS: readonly ExportJobState['format'][] = ['wav', 'mp3', 'ogg'];
const DEPTHS: readonly ExportJobState['bitDepth'][] = [16, 24, 32];
const RANGES: readonly ExportJobState['range'][] = ['project', 'selection', 'loop'];

function formatEta(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function RenderBounce(): JSX.Element {
  const job = useUiStore((s) => s.exportJob);
  const running = job.stage === 'render' || job.stage === 'encode';
  const pct = job.total > 0 ? (job.rendered / job.total) * 100 : 0;
  const label = `Master · ${job.format.toUpperCase()}${job.format === 'wav' ? ` ${job.bitDepth}-bit` : ''}`;

  return (
    <Card title="Render / Bounce" notched>
      <div style={{ display: 'grid', gap: '10px' }}>
        <ProgressBar label={label} value={pct} showValue />

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              className="cy-btn-reset cy-focusable"
              onClick={() => uiActions.patchExportJob({ format: f })}
              style={{ cursor: 'pointer' }}
            >
              <Badge tone={job.format === f ? 'accent' : 'default'} height={22}>
                {f}
              </Badge>
            </button>
          ))}
          {job.format === 'wav'
            ? DEPTHS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="cy-btn-reset cy-focusable"
                  onClick={() => uiActions.patchExportJob({ bitDepth: d })}
                  style={{ cursor: 'pointer' }}
                >
                  <Badge tone={job.bitDepth === d ? 'accent' : 'default'} height={22}>
                    {d} bit
                  </Badge>
                </button>
              ))
            : null}
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className="cy-btn-reset cy-focusable"
              onClick={() => uiActions.patchExportJob({ range: r })}
              style={{ cursor: 'pointer' }}
            >
              <Badge tone={job.range === r ? 'accent' : 'default'} height={22}>
                {r}
              </Badge>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            size="sm"
            disabled
            title="EXPORT butuh snapshot project ter-serialisasi dari Rust (docs/03 §3a); serializer-nya belum ada, jadi export worker belum bisa di-spawn."
          >
            EXPORT
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!running}
            onClick={() => uiActions.patchExportJob({ stage: 'cancelled' })}
          >
            CANCEL
          </Button>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '10px',
              color: 'var(--cy-text-muted)',
              alignSelf: 'center',
            }}
          >
            ETA {formatEta(job.etaMs)}
          </span>
        </div>
      </div>
    </Card>
  );
}
