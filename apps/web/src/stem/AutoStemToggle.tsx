import { Button } from '../ui/cyber';
import { enqueueAutoStem, setAutoStemEnabled, useAutoStem } from './auto-stem';
import { studioStore } from '../studio/store';
import { getBuffer } from '../studio/preview/audio-preview';

export function AutoStemToggle(): JSX.Element {
  const state = useAutoStem();
  const active = state.activeAssetId === null ? null : state.tracks[state.activeAssetId];
  const label = !state.enabled
    ? 'AUTO STEM OFF'
    : state.modelState === 'loading'
      ? `STEM MODEL ${Math.round(state.modelProgress * 100)}%`
      : state.modelState === 'error'
        ? 'STEM ERROR'
        : active !== null && active !== undefined
          ? `STEM ${Math.round(active.progress * 100)}%`
          : state.queueLength > 0
            ? `STEM QUEUE ${state.queueLength}`
            : 'AUTO STEM READY';

  const title = !state.enabled
    ? 'Aktifkan SCNet Base. Track baru akan dipisah menjadi vocals, drums, bass, dan other di background.'
    : state.error ?? (active === null || active === undefined
      ? `${state.readyCount} track stem siap di memori sesi ini`
      : `${active.name} · ${active.phase} · ${Math.round(active.progress * 100)}%`);

  return (
    <Button
      size="sm"
      variant={state.enabled ? 'outline' : 'ghost'}
      active={state.enabled}
      aria-pressed={state.enabled}
      title={title}
      onClick={() => {
        const enabled = !state.enabled;
        setAutoStemEnabled(enabled);
        if (!enabled) return;
        // Toggle boleh dinyalakan SETELAH track masuk. Backfill seluruh PCM
        // yang sudah ada supaya status tidak berhenti di "belum masuk queue".
        for (const asset of Object.values(studioStore.getState().assets)) {
          const buffer = getBuffer(asset.id);
          if (buffer !== undefined) enqueueAutoStem(asset.id, asset.name, buffer);
        }
      }}
      style={{ minWidth: '132px' }}
    >
      {label}
    </Button>
  );
}
