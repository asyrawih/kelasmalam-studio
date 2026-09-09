/**
 * Bar progres import DI DALAM lane yang bersangkutan.
 *
 * Kenapa di lane, bukan satu baris status global: import boleh berjalan
 * beberapa sekaligus, dan satu baris global tidak bisa menjawab pertanyaan
 * yang justru paling sering muncul — "yang mana yang belum selesai". Bar yang
 * duduk di lane tujuannya menjawab itu tanpa satu kata pun.
 *
 * Tiap job punya barisnya sendiri dan menumpuk ke bawah, jadi tiga lagu yang
 * dijatuhkan ke lane yang sama tetap terlihat tiga.
 */

import type { ImportJob, ImportStage } from '../store';

/** Nama tahap di layar. Sengaja pendek: ruangnya setinggi satu lane. */
const STAGE_LABEL: Record<ImportStage, string> = {
  reading: 'MEMBACA',
  decoding: 'DECODE',
  analyzing: 'ANALISIS',
};

export interface LaneImportOverlayProps {
  /** Job untuk SATU lane; pemanggil yang menyaringnya. */
  readonly jobs: readonly ImportJob[];
}

export function LaneImportOverlay({ jobs }: LaneImportOverlayProps): JSX.Element | null {
  if (jobs.length === 0) return null;
  return (
    <div
      data-import-overlay
      style={{
        position: 'absolute',
        inset: '4px 8px auto 8px',
        display: 'grid',
        gap: '3px',
        // Bar hanya MELAPOR; menyeret, memilih kotak, dan menjatuhkan file
        // berikutnya harus tetap tembus ke lane di bawahnya.
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      {jobs.map((job) => (
        <ImportRow key={job.id} job={job} />
      ))}
    </div>
  );
}

function ImportRow({ job }: { readonly job: ImportJob }): JSX.Element {
  const known = job.ratio !== null && Number.isFinite(job.ratio);
  const pct = known ? Math.max(0, Math.min(100, (job.ratio ?? 0) * 100)) : 100;
  const stage = STAGE_LABEL[job.stage];
  return (
    <div
      // Label mesin: satu-satunya kait yang stabil untuk tes, karena teksnya
      // sendiri dipotong secara visual saat nama file panjang.
      data-import-job={job.id}
      role="progressbar"
      aria-label={`import ${job.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(pct) : undefined}
      aria-valuetext={`${stage}${known ? ` ${Math.round(pct)}%` : ''}`}
      style={{
        background: 'rgba(0,0,0,.72)',
        border: '1px solid var(--cy-border-strong)',
        padding: '2px 5px',
        display: 'grid',
        gap: '2px',
        fontFamily: 'var(--cy-font-mono)',
      }}
    >
      <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', minWidth: 0 }}>
        <span
          style={{
            fontSize: '9px',
            letterSpacing: '.1em',
            color: 'var(--cy-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
          title={job.name}
        >
          {job.name}
        </span>
        <span
          style={{
            fontSize: '9px',
            letterSpacing: '.14em',
            color: 'var(--cy-accent)',
            marginLeft: 'auto',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {stage}
          {known ? ` ${Math.round(pct)}%` : ' …'}
        </span>
      </div>
      <div style={{ height: '3px', background: '#000', border: '1px solid var(--cy-border)' }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: 'linear-gradient(90deg,#ffd400,#ffb020 78%,#ff4d4d)',
            // Tahap tanpa ukuran digambar penuh tapi redup — bar penuh yang
            // pekat akan terbaca "selesai", padahal justru belum.
            opacity: known ? 1 : 0.35,
          }}
        />
      </div>
    </div>
  );
}
