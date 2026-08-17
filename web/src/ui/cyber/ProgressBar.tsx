/**
 * Port lokal dari `CyberUI.ProgressBar`.
 *
 * Track-nya memakai class `.cy-progress__track` yang memang didefinisikan di
 * helmet design (`background:#000;border:1px solid var(--cy-border)`) — itu
 * satu-satunya bagian internal design system yang bocor ke design file, jadi
 * kita memakainya persis. Fill-nya mengikuti gradien meter di design.
 */

export interface ProgressBarProps {
  readonly label?: string;
  /** 0..100, sama seperti design (`value={{ 64 }}`). */
  readonly value: number;
  readonly showValue?: boolean;
  readonly indeterminate?: boolean;
}

export function ProgressBar({
  label,
  value,
  showValue = false,
  indeterminate = false,
}: ProgressBarProps): JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div style={{ display: 'grid', gap: '6px', fontFamily: 'var(--cy-font-mono)' }}>
      {label !== undefined || showValue ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: '10px', letterSpacing: '.16em', color: 'var(--cy-text-dim)' }}>
            {label}
          </span>
          {showValue ? (
            <span
              style={{
                fontSize: '10px',
                color: 'var(--cy-accent)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {indeterminate ? '—' : `${Math.round(pct)}%`}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className="cy-progress__track"
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        style={{ height: '10px', position: 'relative', overflow: 'hidden' }}
      >
        <div
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${indeterminate ? 100 : pct}%`,
            background: 'linear-gradient(90deg,#ffd400,#ffb020 78%,#ff4d4d)',
            opacity: indeterminate ? 0.35 : 1,
          }}
        />
      </div>
    </div>
  );
}
