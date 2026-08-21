import type { ScnetStem } from '../../proof-stem/scnet-separate';
import {
  getAutoStemMask,
  hasPlayableAutoStem,
  setAutoStemPart,
  useAutoStem,
} from '../../stem/auto-stem';
import { DECK_ACCENT, type DeckId } from '../model';

const STEMS: readonly ScnetStem[] = ['vocals', 'drums', 'bass', 'other'];

export interface DeckStemsProps {
  readonly id: DeckId;
  readonly assetId: number | null;
  readonly overlay?: boolean;
}

export function DeckStems({ id, assetId, overlay = false }: DeckStemsProps): JSX.Element {
  const state = useAutoStem();
  const status = assetId === null ? undefined : state.tracks[assetId];
  const playable = assetId !== null && hasPlayableAutoStem(assetId);
  const consumer = `dj:${id}`;
  const mask = state.masks[consumer] ?? getAutoStemMask(consumer);
  const accent = DECK_ACCENT[id];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        minHeight: '24px',
        padding: overlay ? '3px 5px' : undefined,
        border: overlay ? '1px solid var(--cy-border)' : undefined,
        background: overlay ? 'color-mix(in srgb, var(--cy-bg) 92%, transparent)' : undefined,
        boxShadow: overlay ? '0 2px 10px #000a' : undefined,
      }}
    >
      <span
        style={{
          fontSize: '8px',
          letterSpacing: '.12em',
          color: accent,
          marginRight: '2px',
          whiteSpace: 'nowrap',
        }}
      >
        STEMS {id}
      </span>
      {STEMS.map((stem) => (
        <button
          key={stem}
          type="button"
          disabled={!playable}
          aria-pressed={mask[stem]}
          title={playable ? `${mask[stem] ? 'mute' : 'aktifkan'} ${stem}` : 'menunggu chunk pertama SCNet Base'}
          onClick={() => setAutoStemPart(consumer, stem, !mask[stem])}
          style={{
            height: '22px', padding: overlay ? '0 7px' : '0 5px', cursor: playable ? 'pointer' : 'not-allowed',
            border: `1px solid ${mask[stem] && playable ? accent : 'var(--cy-border)'}`,
            background: mask[stem] && playable ? `color-mix(in srgb, ${accent} 14%, transparent)` : 'transparent',
            color: mask[stem] && playable ? accent : 'var(--cy-text-muted)',
            fontFamily: 'var(--cy-font-mono)', fontSize: '8px', letterSpacing: '.08em', textTransform: 'uppercase',
            opacity: playable ? 1 : 0.55,
          }}
        >
          {overlay ? stem : stem === 'vocals' ? 'VOC' : stem === 'drums' ? 'DRM' : stem === 'bass' ? 'BAS' : 'OTH'}
        </button>
      ))}
      <span style={{ marginLeft: 'auto', fontSize: '8px', color: playable ? 'var(--cy-success)' : 'var(--cy-text-muted)' }}>
        {assetId === null
          ? 'NO TRACK'
          : status?.state === 'ready'
            ? 'BASE READY'
            : playable
              ? `PLAYABLE ${Math.round((status?.progress ?? 0) * 100)}%`
              : status === undefined
                ? (state.enabled ? 'WAITING' : 'AUTO OFF')
                : status.state === 'error'
                  ? 'ERROR'
                  : `${Math.round(status.progress * 100)}%`}
      </span>
    </div>
  );
}
