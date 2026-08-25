import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '../ui/cyber';
import { studioActions, studioStore, useStudio } from '../studio/store';
import { importBytesToLane } from '../studio/timeline/audio-import';
import { createSoundCloudApi, type SoundCloudTrack } from './api';

export interface SoundCloudDialogProps { readonly onClose: () => void }

function duration(ms: number | null): string {
  if (ms === null) return '';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SoundCloudDialog({ onClose }: SoundCloudDialogProps): JSX.Element {
  const api = useMemo(() => createSoundCloudApi(), []);
  const lanes = useStudio((s) => s.lanes);
  const selectedLaneId = useStudio((s) => s.selectedLaneId);
  const [laneId, setLaneId] = useState(selectedLaneId ?? lanes[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly SoundCloudTrack[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('keydown', close); active.current?.abort(); };
  }, [onClose]);

  async function search(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (query.trim() === '') return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy('search'); setError(null);
    try { setResults(await api.search(query.trim(), controller.signal)); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }

  async function add(track: SoundCloudTrack): Promise<void> {
    if (laneId === '') { setError('Pilih Lane tujuan terlebih dahulu.'); return; }
    const controller = new AbortController();
    active.current = controller;
    setBusy(String(track.id)); setError(null);
    try {
      const bytes = await api.audio(track.permalinkUrl, controller.signal);
      const state = studioStore.getState();
      const result = await importBytesToLane(bytes, `${track.title}.mp3`, laneId, state.playhead, state.sampleRate);
      if (!result.ok) throw new Error(result.reason ?? 'Gagal membuat clip');
      studioActions.selectLane(laneId);
      onClose();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }

  return <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position:'fixed', inset:0, zIndex:1000, display:'grid', placeItems:'center', padding:20, background:'#05090dcc' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="soundcloud-title" style={{ width:'min(760px, 100%)', maxHeight:'min(760px, 90vh)', overflow:'auto', border:'1px solid var(--cy-accent)', background:'var(--cy-surface-1)', boxShadow:'0 24px 80px #000', padding:20 }}>
      <header style={{ display:'flex', alignItems:'center', gap:12, marginBottom:18 }}><div><h2 id="soundcloud-title" style={{ margin:0, color:'var(--cy-text)', fontSize:18 }}>SOUNDCLOUD</h2><div style={{ color:'var(--cy-text-dim)', fontSize:10, marginTop:5 }}>SEARCH · PREVIEW · INSERT TO LANE</div></div><Button style={{ marginLeft:'auto' }} variant="ghost" onClick={onClose}>✕ CLOSE</Button></header>
      <form onSubmit={(e) => void search(e)} style={{ display:'grid', gridTemplateColumns:'1fr minmax(150px, 220px) auto', gap:10 }}>
        <input autoFocus aria-label="Cari SoundCloud" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari judul, artist, genre…" style={{ minWidth:0, height:38, padding:'0 12px', color:'var(--cy-text)', background:'var(--cy-surface-2)', border:'1px solid var(--cy-border)' }} />
        <select aria-label="Lane tujuan" value={laneId} onChange={(e) => setLaneId(e.target.value)} style={{ color:'var(--cy-text)', background:'var(--cy-surface-2)', border:'1px solid var(--cy-border)', padding:'0 10px' }}>{lanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.name}</option>)}</select>
        <Button type="submit" disabled={busy !== null || query.trim() === ''}>{busy === 'search' ? 'SEARCHING…' : 'SEARCH'}</Button>
      </form>
      {error !== null ? <p role="alert" style={{ color:'#ff708d', fontSize:11 }}>{error}</p> : null}
      <div style={{ display:'grid', gap:8, marginTop:16 }}>
        {results.map((track) => <article key={track.id} style={{ display:'grid', gridTemplateColumns:'48px 1fr auto', alignItems:'center', gap:12, padding:10, border:'1px solid var(--cy-border)', background:'var(--cy-surface-2)' }}>
          {track.artworkUrl ? <img src={track.artworkUrl} alt="" width="48" height="48" style={{ objectFit:'cover' }} /> : <div style={{ width:48, height:48, display:'grid', placeItems:'center', background:'#ff550022', color:'#ff5500' }}>♪</div>}
          <div style={{ minWidth:0 }}><strong style={{ display:'block', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--cy-text)', fontSize:12 }}>{track.title}</strong><span style={{ color:'var(--cy-text-dim)', fontSize:10 }}>{track.username}{track.durationMs === null ? '' : ` · ${duration(track.durationMs)}`}</span></div>
          <Button variant="outline" disabled={busy !== null || laneId === ''} onClick={() => void add(track)}>{busy === String(track.id) ? 'IMPORTING…' : '+ ADD TO LANE'}</Button>
        </article>)}
        {busy === null && results.length === 0 ? <p style={{ textAlign:'center', color:'var(--cy-text-dim)', fontSize:11, padding:28 }}>Cari lagu, lalu pilih ADD TO LANE.</p> : null}
      </div>
    </section>
  </div>;
}
