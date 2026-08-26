import { studioActions, useStudio } from '../store';

export function SnapToggle(): JSX.Element {
  const enabled = useStudio((state) => state.snapEnabled);
  return (
    <button
      type="button"
      aria-label="SNAP"
      aria-pressed={enabled}
      title="Magnetic snap antar-edge clip; mencegah overlap"
      onClick={() => studioActions.toggleSnap()}
      className="cy-btn-reset cy-focusable cy-hover-accent-border"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1px',
        minWidth: '52px',
        height: '40px',
        padding: '0 8px',
        border: `1px solid ${enabled ? 'var(--cy-accent)' : 'transparent'}`,
        background: enabled ? 'var(--cy-surface-2)' : 'transparent',
        color: enabled ? 'var(--cy-accent)' : 'var(--cy-text-dim)',
        fontFamily: 'var(--cy-font-mono)',
        cursor: 'pointer',
      }}
    >
      <span aria-hidden style={{ fontSize: '16px', lineHeight: 1 }}>⌁</span>
      <span style={{ fontSize: '8px', letterSpacing: '.12em' }}>SNAP</span>
    </button>
  );
}
