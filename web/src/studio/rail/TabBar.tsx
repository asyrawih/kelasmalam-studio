/** Tab bar rail: MIX | EQ | FX | COMPILE. State tab-nya hidup di store. */

import type { RailTab } from '../model';
import { studioActions, useTab } from './store-adapter';

const TABS: readonly { id: RailTab; label: string }[] = [
  { id: 'mix', label: 'MIX' },
  { id: 'eq', label: 'EQ' },
  { id: 'fx', label: 'FX' },
  { id: 'compile', label: 'COMPILE' },
];

export function TabBar(): JSX.Element {
  const tab = useTab();

  return (
    <div
      role="tablist"
      aria-label="Panel rail"
      style={{ display: 'grid', gridTemplateColumns: `repeat(${TABS.length},minmax(0,1fr))`, gap: '4px' }}
    >
      {TABS.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            className="cy-btn-reset"
            onClick={() => studioActions.setTab(t.id)}
            style={{
              height: '32px',
              border: `1px solid ${active ? 'var(--cy-accent)' : 'var(--cy-border)'}`,
              background: active ? 'var(--cy-accent)' : 'transparent',
              color: active ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
              fontFamily: 'var(--cy-font-mono)',
              fontSize: '10px',
              letterSpacing: '.12em',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
