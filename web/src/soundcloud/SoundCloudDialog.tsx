import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { studioActions, studioStore, useStudio } from '../studio/store';
import { ensureContext } from '../studio/preview/audio-preview';
import { importBytesToLane } from '../studio/timeline/audio-import';
import { Button } from '../ui/cyber';
import { createSoundCloudApi, type SoundCloudProfile, type SoundCloudTrack } from './api';

export interface SoundCloudDialogProps { readonly onClose: () => void }
type Mode = 'search' | 'url' | 'likes';
const inputStyle = { minWidth: 0, height: 38, padding: '0 12px', color: 'var(--cy-text)', background: 'var(--cy-surface-2)', border: '1px solid var(--cy-border)' } as const;
function duration(ms: number | null): string { if (ms === null) return ''; const sec = Math.round(ms / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

function TrackThumbnail({ track }: { readonly track: SoundCloudTrack }): JSX.Element {
  const candidates = [track.artworkUrl, track.avatarUrl].filter((url): url is string => url !== null);
  const [candidate, setCandidate] = useState(0);
  const src = candidates[candidate];
  if (src === undefined) {
    return <div aria-hidden="true" style={{ width:48, height:48, display:'grid', placeItems:'center', border:'1px solid var(--cy-border)', background:'linear-gradient(135deg, #ff550025, #0c1418)', color:'#ff7a33', fontSize:20 }}>♫</div>;
  }
  return <img src={src} alt="" width="48" height="48" loading="lazy" referrerPolicy="no-referrer" onError={() => setCandidate((value) => value + 1)} style={{ display:'block', width:48, height:48, objectFit:'cover', border:'1px solid var(--cy-border)', background:'var(--cy-surface-1)' }} />;
}

export function SoundCloudDialog({ onClose }: SoundCloudDialogProps): JSX.Element {
  const api = useMemo(() => createSoundCloudApi(), []);
  const lanes = useStudio((s) => s.lanes); const selectedLaneId = useStudio((s) => s.selectedLaneId);
  const [laneId, setLaneId] = useState(selectedLaneId ?? lanes[0]?.id ?? '');
  const [mode, setMode] = useState<Mode>('search'); const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly SoundCloudTrack[]>([]); const [heading, setHeading] = useState('DISCOVER TRACKS');
  const [searchTerm, setSearchTerm] = useState(''); const [searchOffset, setSearchOffset] = useState(0); const [searchTotal, setSearchTotal] = useState<number | null>(null); const [searchHasNext, setSearchHasNext] = useState(false);
  const [profile, setProfile] = useState<SoundCloudProfile | null>(null); const [preview, setPreview] = useState<SoundCloudTrack | null>(null);
  const [online, setOnline] = useState<boolean | null>(null); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const previewSource = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    const controller = new AbortController(); void api.health(controller.signal).then(setOnline).catch(() => setOnline(false));
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close); return () => {
      controller.abort(); window.removeEventListener('keydown', close); active.current?.abort();
      const source = previewSource.current; previewSource.current = null;
      if (source !== null) { try { source.stop(); } catch { /* sudah selesai */ } source.disconnect(); }
    };
  }, [api, onClose]);

  function stopPreview(): void {
    const source = previewSource.current;
    previewSource.current = null;
    if (source !== null) { try { source.stop(); } catch { /* sudah selesai */ } source.disconnect(); }
    setPreview(null);
  }
  function task(label: string): AbortController { active.current?.abort(); const controller = new AbortController(); active.current = controller; setBusy(label); setError(null); setProfile(null); stopPreview(); return controller; }
  function failed(cause: unknown, controller: AbortController): void { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
  function done(controller: AbortController): void { if (!controller.signal.aborted) setBusy(null); }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); const value = query.trim(); if (value === '') return; const controller = task('load');
    try {
      const soundCloudUrl = /^https?:\/\/(?:www\.)?soundcloud\.com\//i.test(value);
      if (mode === 'search' && !soundCloudUrl) {
        const page = await api.search(value, 0, controller.signal);
        setResults(page.tracks); setSearchTerm(value); setSearchOffset(0); setSearchTotal(page.total); setSearchHasNext(page.hasNext); setHeading(`SEARCH · ${value}`);
      }
      else if (mode === 'likes') { const owner = await api.profile(value, controller.signal); setProfile(owner); setResults(await api.likes(value, controller.signal)); setSearchTerm(''); setSearchTotal(null); setSearchHasNext(false); setHeading(`LIKES · ${owner.username}`); }
      else {
        const resolved = await api.resolve(value, controller.signal);
        setResults(resolved.tracks); setSearchTerm(''); setSearchTotal(null); setSearchHasNext(false);
        setHeading(`${resolved.kind.toUpperCase()} · ${resolved.title}`);
        if (resolved.kind === 'user') {
          setProfile(resolved.profile);
          if (/\/tracks\/?(?:[?#].*)?$/i.test(value)) setError(`Backend mengenali ${resolved.profile.username}${resolved.profile.trackCount === null ? '' : ` (${resolved.profile.trackCount} track)`}, tetapi belum menyediakan endpoint untuk mengambil seluruh upload profil. /v1/search tidak dipakai karena hasilnya tidak lengkap.`);
        }
      }
    } catch (cause) { failed(cause, controller); } finally { done(controller); }
  }

  async function changeSearchPage(nextOffset: number): Promise<void> {
    if (searchTerm === '') return;
    const controller = task('page');
    try {
      const page = await api.search(searchTerm, Math.max(0, nextOffset), controller.signal);
      setResults(page.tracks); setSearchOffset(page.offset); setSearchTotal(page.total); setSearchHasNext(page.hasNext); setHeading(`SEARCH · ${searchTerm}`);
    } catch (cause) { failed(cause, controller); }
    finally { done(controller); }
  }

  async function showRelated(track: SoundCloudTrack): Promise<void> { const controller = task('related'); try { setResults(await api.related(track.id, controller.signal)); setSearchTerm(''); setSearchTotal(null); setSearchHasNext(false); setHeading(`RELATED · ${track.title}`); } catch (cause) { failed(cause, controller); } finally { done(controller); } }
  async function togglePreview(track: SoundCloudTrack): Promise<void> {
    if (preview?.id === track.id) { active.current?.abort(); setBusy(null); stopPreview(); return; }
    active.current?.abort();
    stopPreview();
    setError(null);
    setPreview(track);
    const controller = new AbortController();
    active.current = controller;
    setBusy(`preview-${track.id}`);
    const state = studioStore.getState();
    const context = ensureContext(state.sampleRate);
    if (context === null) { setBusy(null); setError('Preview gagal: Web Audio tidak tersedia.'); return; }
    // Dipanggil sebelum await, selagi masih berada di user gesture.
    void context.resume();
    try {
      const [bytes, detail] = await Promise.all([
        api.audio(track.permalinkUrl, controller.signal),
        api.track(track.permalinkUrl, controller.signal).catch(() => track),
      ]);
      if (controller.signal.aborted) return;
      const buffer = await context.decodeAudioData(bytes.slice(0));
      if (controller.signal.aborted) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (previewSource.current === source) { previewSource.current = null; setPreview(null); }
        source.disconnect();
      };
      previewSource.current = source;
      setPreview(detail);
      source.start();
    } catch (cause) {
      if (!controller.signal.aborted) { setPreview(null); setError(cause instanceof Error ? `Preview gagal: ${cause.message}` : 'Preview gagal diputar'); }
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }
  async function add(track: SoundCloudTrack): Promise<void> {
    if (laneId === '') { setError('Pilih Lane tujuan terlebih dahulu.'); return; } const controller = task(`add-${track.id}`);
    try { const bytes = await api.audio(track.permalinkUrl, controller.signal); const state = studioStore.getState(); const result = await importBytesToLane(bytes, `${track.title}.mp3`, laneId, state.playhead, state.sampleRate); if (!result.ok) throw new Error(result.reason ?? 'Gagal membuat clip'); studioActions.selectLane(laneId); onClose(); }
    catch (cause) { failed(cause, controller); } finally { done(controller); }
  }

  const placeholder = mode === 'search' ? 'Cari judul, artist, genre…' : mode === 'likes' ? 'URL profil SoundCloud…' : 'URL track, playlist, atau profil…';
  return <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position:'fixed', inset:0, zIndex:1000, display:'grid', placeItems:'center', padding:20, background:'#05090de8' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="soundcloud-title" style={{ width:'min(900px, 100%)', maxHeight:'min(820px, 92vh)', overflow:'auto', border:'1px solid var(--cy-accent)', background:'var(--cy-surface-1)', boxShadow:'0 24px 80px #000', padding:20 }}>
      <header style={{ display:'flex', alignItems:'center', gap:12, marginBottom:14 }}><div><h2 id="soundcloud-title" style={{ margin:0, color:'var(--cy-text)', fontSize:18 }}>SOUNDCLOUD DISCOVERY</h2><div style={{ color:'var(--cy-text-dim)', fontSize:10, marginTop:5 }}>SEARCH · SETS · LIKES · RELATED · INSERT TO LANE</div></div><span style={{ marginLeft:'auto', color:online === true ? '#00ffc2' : online === false ? '#ff708d' : 'var(--cy-text-dim)', fontSize:10 }}>● {online === true ? 'API ONLINE' : online === false ? 'API OFFLINE' : 'CHECKING API'}</span><Button variant="ghost" onClick={onClose}>✕ CLOSE</Button></header>
      <nav aria-label="Discovery mode" style={{ display:'flex', gap:8, marginBottom:10 }}>{(['search','url','likes'] as const).map((item) => <Button key={item} variant="ghost" active={mode === item} onClick={() => { setMode(item); setQuery(''); if (item !== 'search') setSearchTerm(''); }}>{item === 'search' ? 'SEARCH' : item === 'url' ? 'OPEN URL / SET' : 'PROFILE LIKES'}</Button>)}</nav>
      <form onSubmit={(e) => void submit(e)} style={{ display:'grid', gridTemplateColumns:'1fr minmax(150px,220px) auto', gap:10 }}>
        <input autoFocus aria-label="SoundCloud query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} style={inputStyle} />
        <select aria-label="Lane tujuan" value={laneId} onChange={(e) => setLaneId(e.target.value)} style={inputStyle}>{lanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.name}</option>)}</select>
        <Button type="submit" disabled={busy !== null || query.trim() === ''}>{busy === 'load' ? 'LOADING…' : mode === 'search' ? 'SEARCH' : 'OPEN'}</Button>
      </form>
      {error !== null ? <p role="alert" style={{ color:'#ff708d', fontSize:11 }}>{error}</p> : null}
      {profile !== null ? <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:14, padding:10, border:'1px solid var(--cy-border)' }}>{profile.avatarUrl ? <img src={profile.avatarUrl} alt="" width="42" height="42" referrerPolicy="no-referrer" style={{ borderRadius:'50%' }} /> : null}<div><strong style={{ color:'var(--cy-text)' }}>{profile.username}</strong><div style={{ color:'var(--cy-text-dim)', fontSize:10 }}>{profile.followers === null ? 'PROFILE' : `${profile.followers.toLocaleString()} FOLLOWERS`}</div></div>{mode !== 'likes' ? <Button style={{ marginLeft:'auto' }} variant="ghost" onClick={() => { setMode('likes'); setQuery(profile.permalinkUrl); }}>BROWSE LIKES</Button> : null}</div> : null}
      <div style={{ display:preview === null ? 'none' : 'block', marginTop:14, padding:12, border:'1px solid var(--cy-accent)', background:'#ff55000a' }}><div style={{ display:'flex', gap:10, alignItems:'center' }}><strong style={{ color:'var(--cy-text)' }}>▶ {preview?.title ?? 'PREVIEW'}</strong><Button style={{ marginLeft:'auto' }} variant="ghost" onClick={stopPreview}>■ STOP</Button></div><p style={{ color:'var(--cy-text-dim)', fontSize:11, whiteSpace:'pre-wrap' }}>{preview?.description || (preview === null ? '' : `${preview.username} · ${duration(preview.durationMs)}`)}</p></div>
      <h3 style={{ color:'var(--cy-text-dim)', fontSize:10, letterSpacing:'.16em', margin:'18px 0 8px' }}>{heading} · {results.length} TRACKS</h3>
      <div style={{ display:'grid', gap:8 }}>
        {results.map((track) => <article key={track.id} style={{ display:'grid', gridTemplateColumns:'48px minmax(120px,1fr) auto', alignItems:'center', gap:12, padding:10, border:'1px solid var(--cy-border)', background:'var(--cy-surface-2)' }}>
          <TrackThumbnail track={track} />
          <button type="button" onClick={() => void togglePreview(track)} style={{ minWidth:0, padding:0, border:0, textAlign:'left', cursor:'pointer', background:'transparent' }}><strong style={{ display:'block', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--cy-text)', fontSize:12 }}>{track.title}</strong><span style={{ color:'var(--cy-text-dim)', fontSize:10 }}>{track.username}{track.durationMs === null ? '' : ` · ${duration(track.durationMs)}`}</span></button>
          <div style={{ display:'flex', gap:6 }}><Button variant="ghost" active={preview?.id === track.id} disabled={busy !== null && busy !== `preview-${track.id}`} onClick={() => void togglePreview(track)}>{busy === `preview-${track.id}` ? 'LOADING…' : preview?.id === track.id ? '■ STOP' : '▶ PREVIEW'}</Button><Button variant="ghost" disabled={busy !== null} onClick={() => void showRelated(track)}>RELATED</Button><a href={api.downloadUrl(track.permalinkUrl)} download style={{ textDecoration:'none' }}><Button variant="ghost" disabled={busy !== null}>DOWNLOAD</Button></a><Button variant="outline" disabled={busy !== null || laneId === ''} onClick={() => void add(track)}>{busy === `add-${track.id}` ? 'IMPORTING…' : '+ LANE'}</Button></div>
        </article>)}
        {busy === null && results.length === 0 ? <p style={{ textAlign:'center', color:'var(--cy-text-dim)', fontSize:11, padding:28 }}>Cari lagu, buka playlist, atau jelajahi likes sebuah profil.</p> : null}
      </div>
      {searchTerm !== '' ? <footer style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:12, marginTop:16, paddingTop:14, borderTop:'1px solid var(--cy-border)' }}><Button variant="ghost" disabled={busy !== null || searchOffset === 0} onClick={() => void changeSearchPage(searchOffset - 20)}>← PREV</Button><span style={{ color:'var(--cy-text-dim)', fontSize:10, letterSpacing:'.12em' }}>PAGE {Math.floor(searchOffset / 20) + 1}{searchTotal === null ? '' : ` / ${Math.max(1, Math.ceil(searchTotal / 20))}`} · {searchTotal === null ? `${results.length} RESULTS` : `${searchTotal.toLocaleString()} RESULTS`}</span><Button variant="ghost" disabled={busy !== null || !searchHasNext} onClick={() => void changeSearchPage(searchOffset + 20)}>NEXT →</Button></footer> : null}
    </section>
  </div>;
}
