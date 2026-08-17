/**
 * Header bar — baris paling atas design: judul + subjudul, pemisah, ringkasan
 * project yang memotong dirinya sendiri kalau sempit, lalu badge status dan
 * tombol CLOSE di kanan.
 */

import { Badge, Button } from '../../ui/cyber';
import { useStudio } from '../store';

export interface StudioHeaderProps {
  readonly onClose?: () => void;
}

export function StudioHeader({ onClose }: StudioHeaderProps): JSX.Element {
  const projectName = useStudio((s) => s.projectName);
  const laneCount = useStudio((s) => s.lanes.length);
  const sampleRate = useStudio((s) => s.sampleRate);
  const engineReady = useStudio((s) => s.engineReady);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '14px 24px',
        borderBottom: '1px solid var(--cy-border)',
        background: 'var(--cy-surface-1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
        <span
          style={{
            fontFamily: 'var(--cy-font-sans)',
            fontSize: '22px',
            fontWeight: 700,
            letterSpacing: '.06em',
            color: 'var(--cy-text)',
          }}
        >
          AUDIO STUDIO
        </span>
        <span style={{ fontSize: '11px', letterSpacing: '.16em', color: 'var(--cy-accent)' }}>
          // TIMELINE MIX
        </span>
      </div>
      <div style={{ height: '22px', width: '1px', background: 'var(--cy-border)' }} />
      <div
        style={{
          minWidth: 0,
          fontSize: '11px',
          color: 'var(--cy-text-dim)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {`${projectName} · ${laneCount} LANES · ${Math.round(sampleRate / 1000)} kHz · STEREO`}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
        {/* Design menulis READY tanpa syarat. Kita tidak boleh mengklaim siap
            kalau engine belum ada — badge-nya berubah, bukan berbohong. */}
        <Badge tone={engineReady ? 'success' : 'default'} dot>
          {engineReady ? 'READY' : 'UI ONLY'}
        </Badge>
        <Button size="sm" variant="ghost" onClick={onClose}>
          ✕ CLOSE
        </Button>
      </div>
    </div>
  );
}
