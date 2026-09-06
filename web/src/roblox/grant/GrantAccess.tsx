import { useEffect, useMemo, useState } from 'react';

import type { PlatformKind } from '../../platform';
import { Button, Card } from '../../ui/cyber';
import type { QueueItem, RobloxTarget } from '../model';
import { robloxActions } from '../store';
import type { GrantApi, RobloxCatalogAsset, RobloxExperience } from './api';

const fieldStyle = {
  width: '100%', boxSizing: 'border-box' as const, background: 'var(--cy-surface-2)',
  border: '1px solid var(--cy-border)', color: 'var(--cy-text)', padding: '9px 10px',
  fontFamily: 'var(--cy-font-mono)', fontSize: '11px',
};

export interface GrantAccessProps {
  readonly api: GrantApi | null;
  readonly uploadTarget: RobloxTarget;
  readonly uploadItems: readonly QueueItem[];
  readonly platform?: PlatformKind;
}

export function GrantAccess({ api, uploadTarget, uploadItems, platform = 'web' }: GrantAccessProps): JSX.Element {
  const desktop = platform === 'desktop';
  const [assets, setAssets] = useState<readonly RobloxCatalogAsset[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [ownerType, setOwnerType] = useState<'user' | 'group'>(uploadTarget.creatorKind);
  const [ownerId, setOwnerId] = useState(uploadTarget.creatorId);
  const [experiences, setExperiences] = useState<readonly RobloxExperience[]>([]);
  const [experienceQuery, setExperienceQuery] = useState('');
  const [targetType, setTargetType] = useState<'Universe' | 'Group' | 'User'>('Universe');
  const [targetId, setTargetId] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [apiKey, setApiKey] = useState(uploadTarget.apiKey);
  /*
   * Desktop: kunci tinggal di keychain OS dan TIDAK pernah kembali ke halaman
   * (docs/21 §1f), jadi kolomnya kosong dan yang tahu "sudah ada" hanya flag
   * ini. Web: kolom terisi dari Worker dan flag ini sekadar `apiKey !== ''`.
   */
  const [hasApiKey, setHasApiKey] = useState(false);
  const [robloxCookie, setRobloxCookie] = useState('');
  const [hasRobloxCookie, setHasRobloxCookie] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    if (api === null) return;
    setAssets(await api.assets(query));
  };
  const applySaved = (saved: NonNullable<Awaited<ReturnType<GrantApi['settings']>>>): void => {
    setOwnerType(saved.creatorKind);
    setOwnerId(saved.creatorId);
    setApiKey(saved.apiKey);
    setHasApiKey(saved.hasApiKey);
    setHasRobloxCookie(saved.hasRobloxCookie);
    setRobloxCookie(saved.robloxCookie);
    robloxActions.setCreatorKind(saved.creatorKind);
    robloxActions.setCreatorId(saved.creatorId);
    robloxActions.setApiKey(saved.apiKey);
    // Kunci ada tapi nilainya tidak ikut: itu keychain (desktop). Badge dan
    // `targetProblems` membaca flag ini, bukan kolom yang memang kosong.
    if (saved.hasApiKey && saved.apiKey === '') robloxActions.setApiKeyStored(true);
  };
  const saveCredentials = async (): Promise<void> => {
    if (api === null) return;
    await api.saveSettings({ creatorKind: ownerType, creatorId: ownerId, apiKey, ...(robloxCookie === '' ? {} : { robloxCookie }) });
    robloxActions.setCreatorKind(ownerType);
    robloxActions.setCreatorId(ownerId);
    robloxActions.setApiKey(apiKey);
    // Baca ulang, bukan mengasumsikan: di desktop kolom kunci/cookie kembali
    // kosong karena salinannya di WebView tidak punya alasan hidup lebih lama
    // daripada perjalanan ke keychain.
    const saved = await api.settings().catch(() => null);
    if (saved !== null) applySaved(saved);
    setMessage(desktop
      ? 'User tersimpan; API key dan cookie di keychain OS'
      : 'User dan API key tersimpan terenkripsi di D1');
  };
  useEffect(() => {
    setOwnerType(uploadTarget.creatorKind);
    setOwnerId(uploadTarget.creatorId);
    setApiKey(uploadTarget.apiKey);
  }, [uploadTarget]);

  useEffect(() => {
    if (api === null) return;
    void api.settings().then((saved) => {
      if (saved !== null) applySaved(saved);
    }).catch((e: unknown) => setMessage(String(e)));
  }, [api]);

  useEffect(() => {
    if (api === null) return;
    const completed = uploadItems.filter(
      (item): item is QueueItem & { assetId: string } => item.status === 'done' && item.assetId !== null,
    );
    void Promise.all(completed.map((item) => api.recordAsset({
      assetId: item.assetId,
      creatorKind: uploadTarget.creatorKind,
      creatorId: uploadTarget.creatorId,
      name: item.name,
      moderationState: 'approved',
    }))).then(load).catch((e: unknown) => setMessage(String(e)));
  }, [api, uploadItems, uploadTarget]);

  const shownExperiences = useMemo(() => {
    const q = experienceQuery.toLowerCase();
    return experiences.filter((x) => x.name.toLowerCase().includes(q));
  }, [experiences, experienceQuery]);
  const allShownSelected = assets.length > 0 && assets.every((asset) => selected.has(asset.assetId));

  const toggleAllShown = (): void => {
    setSelected((old) => {
      const next = new Set(old);
      if (allShownSelected) {
        for (const asset of assets) next.delete(asset.assetId);
      } else {
        for (const asset of assets) next.add(asset.assetId);
      }
      return next;
    });
  };

  const importCsv = async (file: File): Promise<void> => {
    if (api === null || !/^\d+$/.test(ownerId)) return;
    const lines = (await file.text()).split(/\r?\n/).slice(1);
    const rows = lines.map((line) => {
      const comma = line.indexOf(',');
      return comma < 0 ? null : {
        assetId: line.slice(0, comma).trim(),
        name: line.slice(comma + 1).split(',')[0]?.replace(/^"|"$/g, '') ?? '',
        creatorKind: ownerType,
        creatorId: ownerId,
      };
    }).filter((row): row is NonNullable<typeof row> => row !== null && /^\d+$/.test(row.assetId));
    const count = await api.importAssets(rows);
    setMessage(`${count} audio diimpor ke katalog`);
    await load();
  };

  // Desktop (docs/21 §3f, R5): `api` adalah `createLocalGrantApi()` — Rust
  // yang bicara ke Roblox, cookie dan kunci di keychain. Formulirnya sama;
  // hanya kalimat tentang TEMPAT penyimpanan yang berbeda.
  const storeName = desktop ? 'katalog lokal' : 'D1';
  if (api === null) return <Card title="Grant Access" subtitle="Library API belum tersambung">Isi VITE_LIBRARY_API untuk memakai katalog dan grant.</Card>;

  return (
    <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(320px,420px)', gap: '16px' }} className="rbx-grant-grid">
      <Card title="Upload History / Audio Catalog" subtitle={`${assets.length} asset`} notched actions={
        <label style={{ fontSize: '10px', cursor: 'pointer', color: 'var(--cy-accent)' }}>
          IMPORT CSV<input hidden type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f).catch((x: unknown) => setMessage(String(x))); }} />
        </label>
      }>
        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr auto', gap: '8px', marginBottom: '10px' }}>
          <select value={ownerType} onChange={(e) => setOwnerType(e.target.value as 'user' | 'group')} style={fieldStyle}><option value="user">AKUN</option><option value="group">GRUP</option></select>
          <input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="Creator ID untuk import" style={fieldStyle} />
          <Button variant="outline" onClick={async () => {
            setBusy(true);
            try { const n = await api.syncAssets(); await load(); setMessage(`${n} audio disinkronkan dari Roblox ke ${storeName}`); }
            catch (x) { setMessage(String(x)); } finally { setBusy(false); }
          }}>SYNC ROBLOX</Button>
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void load(); }} placeholder="Cari nama atau asset ID" style={{ ...fieldStyle, marginBottom: '10px' }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '8px', padding: '7px 9px', border: '1px solid var(--cy-border)', color: 'var(--cy-accent)', fontSize: '10px', letterSpacing: '.12em', cursor: assets.length === 0 ? 'not-allowed' : 'pointer' }}>
          <input type="checkbox" aria-label="centang semua audio yang tampil" checked={allShownSelected} disabled={assets.length === 0} onChange={toggleAllShown} />
          CENTANG SEMUA YANG TAMPIL ({assets.length})
          <span style={{ marginLeft: 'auto', color: 'var(--cy-text-muted)' }}>{selected.size} DIPILIH</span>
        </label>
        <div style={{ display: 'grid', gap: '6px', maxHeight: '52vh', overflow: 'auto' }}>
          {assets.map((asset) => <label key={asset.assetId} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '10px', padding: '9px', border: '1px solid var(--cy-border)' }}>
            <input type="checkbox" checked={selected.has(asset.assetId)} onChange={() => setSelected((old) => { const n = new Set(old); n.has(asset.assetId) ? n.delete(asset.assetId) : n.add(asset.assetId); return n; })} />
            <span>{asset.name}<small style={{ display: 'block', color: 'var(--cy-text-muted)' }}>{asset.assetId}</small></span>
            <small>{asset.creatorKind.toUpperCase()}</small>
          </label>)}
          {assets.length === 0 ? <p style={{ color: 'var(--cy-text-muted)', fontSize: '10px' }}>Belum ada history di {storeName}. Upload approved berikutnya masuk otomatis; data lama bisa dimasukkan lewat IMPORT CSV.</p> : null}
        </div>
      </Card>

      <div style={{ display: 'grid', gap: '16px', alignContent: 'start' }}>
        <Card title="Experience" subtitle="cari milik akun / grup" notched>
          <div style={{ display: 'grid', gap: '8px' }}>
            <Button variant="outline" onClick={async () => { setBusy(true); try { setExperiences(await api.experiences(ownerType, ownerId)); } catch (e) { setMessage(String(e)); } finally { setBusy(false); } }}>AMBIL EXPERIENCE</Button>
            <input value={experienceQuery} onChange={(e) => setExperienceQuery(e.target.value)} placeholder="Cari nama experience" style={fieldStyle} />
            <div style={{ maxHeight: '180px', overflow: 'auto', display: 'grid', gap: '5px' }}>{shownExperiences.map((x) => <button key={x.universeId} type="button" onClick={() => { setTargetType('Universe'); setTargetId(x.universeId); setPlaceId(x.placeId); }} style={{ ...fieldStyle, textAlign: 'left', cursor: 'pointer' }}>{x.name}<small style={{ display: 'block' }}>Universe {x.universeId} · Place {x.placeId || '—'}</small></button>)}</div>
            <div style={{ display: 'flex', gap: '8px' }}><input value={placeId} onChange={(e) => setPlaceId(e.target.value)} placeholder="Atau masukkan Place ID" style={fieldStyle} /><Button variant="ghost" onClick={async () => { try { setTargetType('Universe'); setTargetId(await api.resolvePlace(placeId)); } catch (e) { setMessage(String(e)); } }}>RESOLVE</Button></div>
          </div>
        </Card>
        <Card title="Grant Use" subtitle={`${selected.size} audio dipilih`} notched>
          <div style={{ display: 'grid', gap: '8px' }}>
            <select value={targetType} onChange={(e) => setTargetType(e.target.value as typeof targetType)} style={fieldStyle}><option>Universe</option><option>Group</option><option>User</option></select>
            <input value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder={`${targetType} ID`} style={fieldStyle} />
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" autoComplete="off" aria-label="API key Roblox untuk grant" placeholder={hasApiKey && apiKey === '' ? 'API key sudah tersimpan di keychain — isi untuk mengganti' : 'API key dengan asset-permissions:write'} style={fieldStyle} />
            <input value={robloxCookie} onChange={(e) => setRobloxCookie(e.target.value)} type="password" autoComplete="off" aria-label="cookie .ROBLOSECURITY" placeholder={hasRobloxCookie ? '.ROBLOSECURITY sudah tersimpan — isi untuk mengganti' : '.ROBLOSECURITY untuk sync audio lama'} style={fieldStyle} />
            <small style={{ color: 'var(--cy-text-muted)' }}>{desktop
              ? 'Cookie hanya dipakai Rust untuk legacy asset-list API dan disimpan di keychain OS — tidak pernah di SQLite.'
              : 'Cookie hanya dipakai oleh Worker untuk legacy asset-list API dan disimpan terenkripsi di D1.'}</small>
            {/* Desktop: kunci yang sudah di keychain boleh dibiarkan kosong — SIMPAN cukup untuk user/cookie. */}
            <Button variant="outline" disabled={!/^\d+$/.test(ownerId) || (apiKey.trim() === '' ? !(desktop && hasApiKey) : apiKey.trim().length < 10)} onClick={() => void saveCredentials().catch((e: unknown) => setMessage(String(e)))}>SIMPAN USER + API KEY</Button>
            <Button disabled={busy || selected.size === 0 || !/^\d+$/.test(targetId) || (apiKey.trim() === '' && !hasApiKey)} onClick={async () => { setBusy(true); try { const n = await api.grant([...selected], targetType, targetId, apiKey); setMessage(`${n} audio berhasil diberi izin Use ke ${targetType} ${targetId}`); } catch (e) { setMessage(String(e)); } finally { setBusy(false); } }}>GRANT {selected.size}</Button>
            {message ? <p role="status" style={{ margin: 0, color: 'var(--cy-warning)', fontSize: '10px', lineHeight: 1.6 }}>{message}</p> : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
