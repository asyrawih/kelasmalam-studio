import type { ScnetStem } from '../../proof-stem/scnet-separate';
import {
  getAutoStemMask,
  setAutoStemPart,
  useAutoStem,
} from '../../stem/auto-stem';
import type { DeckId } from '../model';

const STEMS: readonly ScnetStem[] = ['vocals', 'drums', 'bass', 'other'];

export function DeckStems({ id, assetId }: { readonly id: DeckId; readonly assetId: number | null }): JSX.Element {
  const state = useAutoStem();
  const status = assetId === null ? undefined : state.tracks[assetId];
  const ready = status?.state === 'ready';
  const consumer = `dj:${id}`;
  const mask = state.masks[consumer] ?? getAutoStemMask(consumer);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '3px', minHeight: '24px' }}>
      <span style={{ fontSize: '8px', letterSpacing: '.12em', color: 'var(--cy-text-muted)', marginRight: '2px' }}>
        STEM
      </span>
      {STEMS.map((stem) => (
        <button
          key={stem}
          type="button"
          disabled={!ready}
          aria-pressed={mask[stem]}
          title={ready ? `${mask[stem] ? 'mute' : 'aktifkan'} ${stem}` : 'menunggu SCNet Base selesai'}
          onClick={() => setAutoStemPart(consumer, stem, !mask[stem])}
          style={{
            height: '22px', padding: '0 5px', cursor: ready ? 'pointer' : 'not-allowed',
            border: `1px solid ${mask[stem] && ready ? 'var(--dj-deck-accent)' : 'var(--cy-border)'}`,
            background: mask[stem] && ready ? 'color-mix(in srgb, var(--dj-deck-accent) 14%, transparent)' : 'transparent',
            color: mask[stem] && ready ? 'var(--dj-deck-accent)' : 'var(--cy-text-muted)',
            fontFamily: 'var(--cy-font-mono)', fontSize: '8px', letterSpacing: '.08em', textTransform: 'uppercase',
            opacity: ready ? 1 : 0.55,
          }}
        >
          {stem === 'vocals' ? 'VOC' : stem === 'drums' ? 'DRM' : stem === 'bass' ? 'BAS' : 'OTH'}
        </button>
      ))}
      <span style={{ marginLeft: 'auto', fontSize: '8px', color: ready ? 'var(--cy-success)' : 'var(--cy-text-muted)' }}>
        {assetId === null
          ? 'NO TRACK'
          : ready
            ? 'BASE READY'
            : status === undefined
              ? (state.enabled ? 'WAITING' : 'AUTO OFF')
              : status.state === 'error'
                ? 'ERROR'
                : `${Math.round(status.progress * 100)}%`}
      </span>
    </div>
  );
}
