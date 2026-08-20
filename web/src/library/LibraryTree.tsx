/**
 * Pohon kepustakaan: **folder = project, isinya lagu.**
 *
 * ## Kenapa pohon, bukan dua tab
 *
 * Dua tab memaksa user mengingat lagu mana milik project mana — dan itu
 * pertanyaan yang paling sering ditanyakan justru saat membuka kepustakaan.
 * Pohon menjawabnya dengan bentuknya sendiri: buka folder, lihat isinya.
 *
 * ## Isi folder diambil SAAT DIBUKA
 *
 * `GET /projects` hanya mengembalikan nama dan versi, dan itu disengaja: satu
 * project bisa berukuran megabyte, jadi menarik semuanya sekadar untuk
 * menggambar daftar berarti membayar seluruh kepustakaan untuk melihat
 * judulnya. Folder yang dibuka mengambil isinya sekali, lalu diingat.
 *
 * ## "Tanpa project"
 *
 * Lagu yang tidak dipakai project mana pun tetap harus terlihat — ia baru
 * diunggah, atau project pemakainya sudah dihapus. Menyembunyikannya membuat
 * unggahan yang berhasil tampak hilang.
 */

import { useCallback, useRef, useState } from 'react';

import { Badge, Button, ProgressBar } from '../ui/cyber';
import { importFileToAsset } from '../studio/timeline/audio-import';
import { studioStore } from '../studio/store';
import type { LibraryApi } from './api';
import { hashesIn } from './projects';
import { formatBytes, formatDuration, type LibraryState, type LibraryTrack } from './model';
import { libraryActions, libraryStore } from './store';

export interface LibraryTreeProps {
  readonly state: LibraryState;
  readonly api: LibraryApi;
  readonly assets: Readonly<Record<number, unknown>>;
  readonly onPick: (track: LibraryTrack) => void | Promise<void>;
  readonly onRemove: (track: LibraryTrack) => void | Promise<void>;
  readonly onSave: () => void | Promise<void>;
  readonly onOpen: (id: string, name: string, version: number) => void | Promise<void>;
  readonly onDeleteProject: (id: string, name: string) => void | Promise<void>;
  readonly busy: boolean;
}

const INDENT = 22;

export function LibraryTree({
  state,
  api,
  assets,
  onPick,
  onRemove,
  onSave,
  onOpen,
  onDeleteProject,
  busy,
}: LibraryTreeProps): JSX.Element {
  const byHash = new Map(state.tracks.map((t) => [t.hash, t]));

  /** Hash yang sudah muncul di suatu folder — sisanya masuk "Tanpa project". */
  const claimed = new Set<string>();
  for (const hashes of Object.values(state.projectTracks)) {
    if (hashes === 'memuat') continue;
    for (const h of hashes) claimed.add(h);
  }
  const loose = state.tracks.filter((t) => !claimed.has(t.hash));

  const toggle = useCallback(
    async (id: string): Promise<void> => {
      const wasOpen = libraryStore.getState().expanded[id] === true;
      libraryActions.toggleFolder(id);
      // Isinya diambil sekali, saat pertama dibuka. Menutup lalu membuka lagi
      // tidak memanggil server: isinya tidak berubah sendiri.
      if (wasOpen || libraryStore.getState().projectTracks[id] !== undefined) return;

      libraryActions.setProjectTracks(id, 'memuat');
      try {
        const body = await api.project(id);
        libraryActions.setProjectTracks(id, hashesIn(body.json));
      } catch {
        // Folder yang gagal dibaca tampil kosong, bukan menggantung selamanya.
        libraryActions.setProjectTracks(id, []);
      }
    },
    [api],
  );

  return (
    <div style={{ display: 'grid', gap: '8px' }}>
      <AddAudio busy={busy} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <Button size="sm" disabled={busy} onClick={() => void onSave()}>
          {state.openProject === null ? 'SIMPAN JADI PROJECT' : 'SIMPAN PROJECT'}
        </Button>
        {state.openProject === null ? null : (
          <Badge tone="success" height={22}>
            {state.openProject.name} · v{state.openProject.version}
          </Badge>
        )}
      </div>

      <div role="tree" aria-label="kepustakaan" style={{ display: 'grid', gap: '2px' }}>
        {state.projects.map((p) => {
          const open = state.expanded[p.id] === true;
          const isi = state.projectTracks[p.id];

          return (
            <div key={p.id}>
              <Row
                depth={0}
                icon={open ? '▾' : '▸'}
                label={`${p.name}`}
                meta={`v${p.version}`}
                onClick={() => void toggle(p.id)}
                expanded={open}
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onOpen(p.id, p.name, p.version);
                      }}
                    >
                      BUKA
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`hapus project ${p.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteProject(p.id, p.name);
                      }}
                    >
                      HAPUS
                    </Button>
                  </>
                }
              />

              {!open ? null : isi === 'memuat' ? (
                <Leaf depth={1}>memuat isinya…</Leaf>
              ) : isi === undefined || isi.length === 0 ? (
                <Leaf depth={1}>project ini tidak memakai lagu dari kepustakaan</Leaf>
              ) : (
                isi.map((hash) => {
                  const track = byHash.get(hash);
                  return track === undefined ? (
                    <Leaf key={hash} depth={1}>
                      {/* Lagu yang dipakai project tapi sudah tidak ada di
                          kepustakaan — bukan hal yang boleh disembunyikan. */}
                      lagu yang sudah dihapus ({hash.slice(0, 8)}…)
                    </Leaf>
                  ) : (
                    <TrackRow
                      key={hash}
                      depth={1}
                      track={track}
                      state={state}
                      assets={assets}
                      onPick={onPick}
                      onRemove={onRemove}
                    />
                  );
                })
              )}
            </div>
          );
        })}

        <Row
          depth={0}
          icon={state.expanded.__loose === true ? '▾' : '▸'}
          label="Tanpa project"
          meta={`${loose.length}`}
          expanded={state.expanded.__loose === true}
          onClick={() => libraryActions.toggleFolder('__loose')}
        />
        {state.expanded.__loose !== true
          ? null
          : loose.length === 0
            ? (
                <Leaf depth={1}>
                  {/* Dua keadaan yang terlihat sama di layar tapi butuh kalimat
                      berbeda: kepustakaan yang memang kosong, dan kepustakaan
                      berisi yang semua lagunya sudah dipakai project. */}
                  {state.tracks.length === 0
                    ? 'Kepustakaan masih kosong — tambahkan lagu lewat tombol di atas.'
                    : 'semua lagu sudah dipakai project'}
                </Leaf>
              )
            : loose.map((t) => (
                <TrackRow
                  key={t.hash}
                  depth={1}
                  track={t}
                  state={state}
                  assets={assets}
                  onPick={onPick}
                  onRemove={onRemove}
                />
              ))}
      </div>
    </div>
  );
}

// ── Bagian ───────────────────────────────────────────────────────────────────

/**
 * Pintu masuk audio — tombol DAN area jatuh.
 *
 * Ini yang paling sering dicari dan paling mudah tidak ketemu: sebelum ini,
 * satu-satunya cara memasukkan lagu ke kepustakaan adalah menjatuhkannya ke
 * TIMELINE dan berharap tahu bahwa unggahan terjadi sebagai efek sampingnya.
 * Jalurnya tetap sama persis (`importFileToAsset` → sink → unggah); yang
 * ditambahkan hanyalah pintu yang kelihatan.
 */
function AddAudio({ busy }: { readonly busy: boolean }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCount = useRef(0);
  const [over, setOver] = useState(false);

  const terima = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return;
    const sr = studioStore.getState().sampleRate;
    for (const file of Array.from(files)) {
      // Berurutan: tiga decode paralel membekukan main thread bergantian, dan
      // unggahannya toh diantre satu per satu di sisi kepustakaan.
      const out = await importFileToAsset(file, sr);
      if (!out.ok) libraryActions.setNotice(`${file.name}: ${out.reason}`);
    }
  };

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        dragCount.current += 1;
        if (!busy) setOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCount.current = Math.max(0, dragCount.current - 1);
        if (dragCount.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCount.current = 0;
        setOver(false);
        if (!busy) void terima(e.dataTransfer.files);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        border: `1px dashed ${over ? 'var(--cy-accent)' : 'var(--cy-border-strong)'}`,
        background: over ? 'var(--cy-surface-2)' : 'transparent',
      }}
    >
      <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        + TAMBAH LAGU
      </Button>
      <span style={{ fontSize: '10px', color: 'var(--cy-text-muted)', letterSpacing: '.1em' }}>
        atau jatuhkan berkas audio di sini
      </span>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="audio/*,.mp3,.ogg,.wav,.flac"
        aria-label="tambah lagu ke kepustakaan"
        style={{ display: 'none' }}
        onChange={(e) => {
          void terima(e.target.files);
          // Direset supaya memilih berkas yang SAMA dua kali tetap memicu
          // `change` — tanpa ini percobaan kedua diam saja.
          e.target.value = '';
        }}
      />
    </div>
  );
}

function Row({
  depth,
  icon,
  label,
  meta,
  actions,
  onClick,
  expanded,
}: {
  readonly depth: number;
  readonly icon: string;
  readonly label: string;
  readonly meta?: string;
  readonly actions?: React.ReactNode;
  readonly onClick?: () => void;
  readonly expanded?: boolean;
}): JSX.Element {
  const clickable = onClick !== undefined;
  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!clickable || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onClick?.();
      }}
      className={clickable ? 'cy-hover-row cy-focusable' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0,1fr) auto auto',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 10px',
        paddingLeft: `${10 + depth * INDENT}px`,
        border: '1px solid var(--cy-border)',
        background: 'var(--cy-surface-1)',
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <span style={{ fontSize: '10px', color: 'var(--cy-accent)', width: '10px' }}>{icon}</span>
      <span
        style={{
          fontSize: '11px',
          color: 'var(--cy-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: '10px',
          color: 'var(--cy-text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {meta ?? ''}
      </span>
      <div style={{ display: 'flex', gap: '6px' }}>{actions}</div>
    </div>
  );
}

function TrackRow({
  depth,
  track,
  state,
  assets,
  onPick,
  onRemove,
}: {
  readonly depth: number;
  readonly track: LibraryTrack;
  readonly state: LibraryState;
  readonly assets: Readonly<Record<number, unknown>>;
  readonly onPick: (t: LibraryTrack) => void | Promise<void>;
  readonly onRemove: (t: LibraryTrack) => void | Promise<void>;
}): JSX.Element {
  const assetId = state.loaded[track.hash];
  // "Di sesi" berarti asetnya MASIH ada di store — bukan sekadar pernah dimuat.
  const inSession = assetId !== undefined && assets[assetId] !== undefined;
  const percent = state.loading[track.hash];

  return (
    <div>
      <Row
        depth={depth}
        icon="♪"
        label={track.name}
        meta={`${formatDuration(track.frames, track.sampleRate)} · ${formatBytes(track.bytes)}`}
        actions={
          <>
            {inSession ? (
              <Badge tone="success" height={22}>
                DI SESI
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={percent !== undefined}
                onClick={() => void onPick(track)}
              >
                {percent === undefined ? 'MUAT' : 'MEMUAT…'}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`hapus ${track.name}`}
              onClick={() => void onRemove(track)}
            >
              HAPUS
            </Button>
          </>
        }
      />
      {percent === undefined ? null : (
        <div style={{ padding: `4px 10px 6px ${10 + (depth + 1) * INDENT}px` }}>
          <ProgressBar value={percent} showValue label="MENGUNDUH" />
        </div>
      )}
    </div>
  );
}

function Leaf({
  depth,
  children,
}: {
  readonly depth: number;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        padding: `5px 10px 5px ${10 + depth * INDENT + 18}px`,
        fontSize: '10px',
        color: 'var(--cy-text-muted)',
      }}
    >
      {children}
    </div>
  );
}
