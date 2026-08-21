import { Button } from '../ui/cyber';
import { setAutoStemEnabled, useAutoStem } from './auto-stem';

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
      onClick={() => setAutoStemEnabled(!state.enabled)}
      style={{ minWidth: '132px' }}
    >
      {label}
    </Button>
  );
}
