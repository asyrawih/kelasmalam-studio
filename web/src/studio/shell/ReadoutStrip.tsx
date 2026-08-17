/**
 * Readout strip — 5 sel angka di bawah header. Label kecil uppercase, nilai
 * besar ber-font sans, satuan kecil di kanan nilai. Warna per design.
 */

import { formatTime, samplesToSec } from '../model';
import { selectClipCount, useStudio } from '../store';

interface Cell {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly color: string;
}

export function ReadoutStrip(): JSX.Element {
  const sampleRate = useStudio((s) => s.sampleRate);
  const duration = useStudio((s) => s.duration);
  const playhead = useStudio((s) => s.playhead);
  const laneCount = useStudio((s) => s.lanes.length);
  const clipCount = useStudio(selectClipCount);

  const totalSec = samplesToSec(duration, sampleRate);
  const cells: Cell[] = [
    { label: 'Timeline', value: formatTime(totalSec), unit: '', color: 'var(--cy-text)' },
    {
      label: 'Playhead',
      value: formatTime(samplesToSec(playhead, sampleRate)),
      unit: '',
      color: 'var(--cy-accent)',
    },
    { label: 'Lanes', value: String(laneCount), unit: 'ch', color: 'var(--cy-text)' },
    { label: 'Clips', value: String(clipCount), unit: '', color: 'var(--cy-text)' },
    {
      label: 'Compile out',
      value: formatTime(totalSec),
      unit: 'wav',
      color: 'var(--cy-accent-alt)',
    },
  ];

  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--cy-border)', background: '#000' }}>
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '9px 16px',
            borderRight: '1px solid var(--cy-border)',
          }}
        >
          <div
            style={{
              fontSize: '9px',
              letterSpacing: '.2em',
              color: 'var(--cy-text-muted)',
              textTransform: 'uppercase',
            }}
          >
            {c.label}
          </div>
          <div
            style={{
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '19px',
              fontWeight: 600,
              color: c.color,
              marginTop: '2px',
            }}
          >
            {c.value}
            <span style={{ fontSize: '10px', color: 'var(--cy-text-muted)', marginLeft: '4px' }}>
              {c.unit}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
