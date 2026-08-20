/**
 * Kepustakaan dua panel: **kiri project, kanan lagu.**
 *
 * ## Kenapa dua panel, bukan pohon bertingkat
 *
 * Pohon memaksa daftar lagu ikut menyempit setiap kali sebuah folder dibuka,
 * dan lagu adalah baris yang paling sering dibaca di sini — nama, durasi,
 * ukuran, statusnya. Dua panel memberi masing-masing lebarnya sendiri: sidebar
 * cukup untuk nama project, sisanya milik lagu.
 *
 * Pilihan di sidebar adalah pilihan TAMPILAN, bukan "buka project". Melihat isi
 * sebuah project tidak sama dengan mengerjakannya; yang memuat project ke
 * timeline tetap tombol BUKA, dan itu perbuatan yang jauh lebih besar
 * (mengunduh audionya, mengganti seluruh state).
 *
 * ## Isi project diambil saat DIPILIH
 *
 * `GET /projects` hanya mengembalikan nama dan versi — satu project bisa
 * berukuran megabyte, dan menariknya semua sekadar untuk menggambar sidebar
 * berarti membayar seluruh kepustakaan untuk melihat judulnya. Yang dipilih
 * mengambil isinya sekali, lalu diingat.
 */

import { useCallback, useRef, useState } from 'react';

import { Badge, Button, ProgressBar } from '../ui/cyber';
import { importFileToAsset } from '../studio/timeline/audio-import';
import { studioStore } from '../studio/store';
import { LIBRARY_TRACK_MIME } from '../studio/timeline/library-drop';
import type { LibraryApi } from './api';
import { hashesIn } from './projects';
import { formatBytes, formatDuration, type LibraryState, type LibraryTrack } from './model';
import { libraryActions, libraryStore } from './store';
import './library.css';

export interface LibraryBrowserProps {
  readonly state: LibraryState;
  readonly api: LibraryApi;
  readonly assets: Readonly<Record<number, unknown>>;
  readonly onPick: (track: LibraryTrack) => void | Promise<void>;
  readonly onRemove: (track: LibraryTrack, projectId: string | null) => void | Promise<void>;
  readonly onCreateProject: () => void | Promise<void>;
  readonly onSave: () => void | Promise<void>;
  readonly onOpen: (id: string, name: string, version: number) => void | Promise<void>;
  readonly onDeleteProject: (id: string, name: string) => void | Promise<void>;
  readonly onRename: (id: string, name: string) => void | Promise<void>;
  /** Nama yang dipakai saat menyimpan project BARU. */
  readonly onSaveName: (name: string) => void;
  readonly saveName: string;
  readonly busy: boolean;
}

/** Not balok — ikon tiap lagu. SVG, bukan karakter: `♪` digambar berbeda di
 *  tiap sistem, dan di sebagian Windows ia jatuh ke kotak kosong. */
function NoteIcon(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <path
        d="M6 12.5a2 2 0 1 1-2-2c.35 0 .68.09.97.24V3.2l7-1.6v7.9a2 2 0 1 1-2-2c.35 0 .68.09.97.24V4.3l-4.94 1.13V12.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function LibraryBrowser({
  state,
  api,
  assets,
  onPick,
  onRemove,
  onCreateProject,
  onSave,
  onOpen,
  onDeleteProject,
  onRename,
  onSaveName,
  saveName,
  busy,
}: LibraryBrowserProps): JSX.Element {
  const pilih = useCallback(
    async (id: string | null): Promise<void> => {
      libraryActions.selectProject(id);
      if (id === null || libraryStore.getState().projectTracks[id] !== undefined) return;

      libraryActions.setProjectTracks(id, 'memuat');
      try {
        const body = await api.project(id);
        libraryActions.setProjectTracks(id, body.tracks ?? hashesIn(body.json));
      } catch {
        // Project yang gagal dibaca tampil kosong, bukan menggantung selamanya.
        libraryActions.setProjectTracks(id, []);
      }
    },
    [api],
  );

  const selected = state.selectedProject;
  const isi = selected === null ? undefined : state.projectTracks[selected];

  const byHash = new Map(state.tracks.map((t) => [t.hash, t]));
  /** Baris yang dipajang panel kanan: hash + lagunya (kalau masih ada). */
  const rows: readonly { hash: string; track: LibraryTrack | undefined }[] =
    selected === null
      ? state.tracks.map((t) => ({ hash: t.hash, track: t }))
      : isi === undefined || isi === 'memuat'
        ? []
        : isi.map((hash) => ({ hash, track: byHash.get(hash) }));

  return (
    <div
      className="lib-browser"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(150px, 210px) minmax(0, 1fr)',
        gap: '10px',
        alignItems: 'start',
      }}
    >
      {/* ── Sidebar: project ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gap: '6px', minWidth: 0 }}>
        <div style={LABEL}>PROJECT</div>

        <div role="listbox" aria-label="project" style={{ display: 'grid', gap: '2px' }}>
          <SideItem
            label="SEMUA LAGU"
            meta={`${state.tracks.length}`}
            selected={selected === null}
            onSelect={() => void pilih(null)}
          />
          {state.projects.map((p) => (
            <SideItem
              key={p.id}
              label={p.name}
              meta={`v${p.version}`}
              selected={selected === p.id}
              onSelect={() => void pilih(p.id)}
            />
          ))}
        </div>

        {state.projects.length === 0 ? (
          <p style={{ margin: 0, fontSize: '9px', lineHeight: 1.7, color: 'var(--cy-text-muted)' }}>
            Belum ada project. Simpan yang sedang dikerjakan lewat tombol di bawah.
          </p>
        ) : null}

        <div style={{ display: 'grid', gap: '6px', marginTop: '2px' }}>
          <input
            className="cy-focusable"
            value={saveName}
            placeholder="nama project baru"
            aria-label="nama project baru"
            disabled={busy}
            onChange={(e) => onSaveName(e.target.value)}
            style={FIELD}
          />
          <Button
            size="sm"
            disabled={busy || saveName.trim() === ''}
            onClick={() => void onCreateProject()}
          >
            + TAMBAH PROJECT
          </Button>
          {state.openProject === null ? null : (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void onSave()}>
                SIMPAN PROJECT
              </Button>
              <Badge tone="success" height={22}>
                {state.openProject.name} · v{state.openProject.version}
              </Badge>
            </>
          )}
        </div>
      </div>

      {/* ── Panel kanan: lagu ────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gap: '6px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {selected === null ? (
            <div style={LABEL}>LAGU</div>
          ) : (
            <RenameField
              key={selected}
              id={selected}
              name={state.projects.find((p) => p.id === selected)?.name ?? ''}
              busy={busy}
              onRename={onRename}
            />
          )}
          {selected === null ? null : (
            <ProjectActions
              id={selected}
              name={state.projects.find((p) => p.id === selected)?.name ?? ''}
              version={state.projects.find((p) => p.id === selected)?.version ?? 0}
              busy={busy}
              onOpen={onOpen}
              onDeleteProject={onDeleteProject}
            />
          )}
        </div>

        {selected === null ? (
          <p style={{ margin: 0, fontSize: '10px', color: 'var(--cy-text-muted)' }}>
            Pilih project untuk menambahkan lagu. SEMUA LAGU adalah gabungan isi seluruh project.
          </p>
        ) : (
          <AddAudio busy={busy} />
        )}

        {isi === 'memuat' ? (
          <Kosong>memuat isinya…</Kosong>
        ) : rows.length === 0 ? (
          <Kosong>
            {selected !== null
              ? 'Project ini tidak memakai lagu dari kepustakaan.'
              : 'Kepustakaan masih kosong — tambahkan lagu lewat tombol di atas.'}
          </Kosong>
        ) : (
          <div role="table" aria-label="lagu" style={{ display: 'grid', gap: '3px' }}>
            {rows.map(({ hash, track }) =>
              track === undefined ? (
                <Kosong key={hash}>
                  {/* Dipakai project tapi sudah tidak ada di kepustakaan —
                      menyembunyikannya membuat project terlihat utuh padahal
                      ada yang hilang. */}
                  lagu yang sudah dihapus ({hash.slice(0, 8)}…)
                </Kosong>
              ) : (
                <TrackRow
                  key={hash}
                  track={track}
                  state={state}
                  assets={assets}
                  onPick={onPick}
                  onRemove={(track) => onRemove(track, selected)}
                />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bagian ───────────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontSize: '9px',
  letterSpacing: '.18em',
  color: 'var(--cy-text-muted)',
};

const FIELD: React.CSSProperties = {
  width: '100%',
  background: 'var(--cy-surface-2)',
  color: 'var(--cy-text)',
  border: '1px solid var(--cy-border)',
  fontFamily: 'var(--cy-font-mono)',
  fontSize: '10px',
  padding: '5px 7px',
};

const CELL: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--cy-text-dim)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

function SideItem({
  label,
  meta,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly meta: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className="cy-btn-reset cy-focusable cy-hover-row"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 8px',
        textAlign: 'left',
        cursor: 'pointer',
        border: `1px solid ${selected ? 'var(--cy-accent)' : 'var(--cy-border)'}`,
        background: selected ? 'var(--cy-surface-2)' : 'var(--cy-surface-1)',
        color: selected ? 'var(--cy-accent)' : 'var(--cy-text)',
      }}
    >
      <span
        style={{
          fontSize: '10px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: '9px', color: 'var(--cy-text-muted)' }}>{meta}</span>
    </button>
  );
}

/**
 * Nama project yang bisa disunting di tempat.
 *
 * Tombol GANTI NAMA baru muncul kalau namanya BENAR-BENAR berubah — tombol yang
 * selalu ada mengundang penekanan yang tidak melakukan apa-apa, dan tiap
 * penekanan itu tetap dua permintaan ke server.
 *
 * `key={selected}` di pemanggil membuat komponen ini lahir ulang saat project
 * lain dipilih; tanpa itu, nama yang sedang diketik terbawa ke project
 * berikutnya dan yang tersimpan bisa jadi nama project yang salah.
 */
function RenameField({
  id,
  name,
  busy,
  onRename,
}: {
  readonly id: string;
  readonly name: string;
  readonly busy: boolean;
  readonly onRename: (id: string, name: string) => void | Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(name);
  const berubah = draft.trim() !== '' && draft.trim() !== name;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
      <input
        className="cy-focusable"
        value={draft}
        aria-label="nama project"
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && berubah) void onRename(id, draft.trim());
          // Escape mengembalikan yang tersimpan — jalan keluar dari ketikan
          // yang sudah telanjur, tanpa harus menghapusnya huruf per huruf.
          if (e.key === 'Escape') setDraft(name);
        }}
        style={{ ...FIELD, width: '200px', fontSize: '11px' }}
      />
      {berubah ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onRename(id, draft.trim())}>
          GANTI NAMA
        </Button>
      ) : null}
    </div>
  );
}

function ProjectActions({
  id,
  name,
  version,
  busy,
  onOpen,
  onDeleteProject,
}: {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly busy: boolean;
  readonly onOpen: (id: string, name: string, version: number) => void | Promise<void>;
  readonly onDeleteProject: (id: string, name: string) => void | Promise<void>;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void onOpen(id, name, version)}
      >
        BUKA DI TIMELINE
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        aria-label={`hapus project ${name}`}
        onClick={() => void onDeleteProject(id, name)}
      >
        HAPUS
      </Button>
    </div>
  );
}

function TrackRow({
  track,
  state,
  assets,
  onPick,
  onRemove,
}: {
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
    <div
      role="row"
      /*
       * Diseret ke lane mana pun di timeline. Yang dibawa cuma HASH-nya —
       * bukan byte-nya: lagunya bisa 25 MB, dan yang menerima drop toh sudah
       * tahu cara mengambilnya (atau sudah punya di sesi ini).
       */
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(LIBRARY_TRACK_MIME, track.hash);
        // `copy`, bukan `move`: lagunya tidak pindah dari kepustakaan.
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title="seret ke lane untuk menaruhnya di timeline"
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0,1fr) auto auto auto',
        alignItems: 'center',
        gap: '10px',
        padding: '6px 10px',
        border: '1px solid var(--cy-border)',
        background: 'var(--cy-surface-1)',
        cursor: 'grab',
      }}
    >
      <span style={{ color: inSession ? 'var(--cy-accent)' : 'var(--cy-text-muted)' }}>
        <NoteIcon />
      </span>

      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--cy-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {track.name}
        </div>
        {percent === undefined ? null : (
          <div style={{ marginTop: '4px' }}>
            <ProgressBar value={percent} showValue label="MENGUNDUH" />
          </div>
        )}
      </div>

      <span style={CELL}>{formatDuration(track.frames, track.sampleRate)}</span>
      <span style={CELL}>{formatBytes(track.bytes)}</span>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
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
      </div>
    </div>
  );
}

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
        padding: '7px 10px',
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

function Kosong({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <p style={{ margin: 0, padding: '8px 2px', fontSize: '10px', color: 'var(--cy-text-muted)' }}>
      {children}
    </p>
  );
}
