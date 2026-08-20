/**
 * KEPUSTAKAAN — dok yang menempel di dasar layar.
 *
 * ## Kenapa di bawah, dan kenapa menempel
 *
 * Kepustakaan bukan permukaan kerja: ia tempat mengambil bahan, dipakai
 * sebentar lalu ditinggalkan. Panel yang memakan kolom di samping timeline
 * membayar ruang permanen untuk pemakaian sesekali. Strip di dasar layar
 * membayar 34 piksel.
 *
 * `position: sticky; bottom: 0` bekerja karena `StudioLayout` sengaja tidak
 * punya scroller sendiri — DOKUMEN yang menggulir (catatan yang sama menjaga
 * toolbar `sticky` di atas). Membungkus body dengan `overflow: auto` akan
 * mematikan keduanya sekaligus, tanpa gejala selain "tidak menempel lagi".
 *
 * ## Terlipat = strip, bukan tersembunyi
 *
 * Yang terlipat tetap menyebut isinya ("12 LAGU · 340.2 MB") dan tetap satu
 * klik dari terbuka. Panel yang hilang sama sekali saat dilipat berarti user
 * harus mengingat bahwa ia ada — dan fitur yang harus diingat adalah fitur
 * yang tidak dipakai.
 *
 * ## Tanpa `VITE_LIBRARY_API`, dock tetap ada dan mengatakan kenapa kosong
 *
 * Bukan disembunyikan: build tanpa backend adalah keadaan yang sah (seluruh
 * aplikasi berjalan penuh tanpa akun — docs/16 §6), dan dock yang lenyap tanpa
 * kata membuat orang mencari bug di tempat yang salah.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useCommands } from '../app-shell';
import { Badge, Button, ProgressBar } from '../ui/cyber';
import { useStudio } from '../studio/store';
import { registerImportSink } from '../studio/timeline/import-sink';
import { createLibraryApi, type LibraryApi } from './api';
import { loadTrack } from './load-track';
import { currentProjectName, openProject, saveProject, unsavedAssets } from './projects';
import {
  formatBytes,
  formatDuration,
  summarize,
  type LibraryState,
  type LibraryTrack,
  type UploadState,
} from './model';
import { libraryActions, useLibrary } from './store';
import { createUploadQueue } from './upload';

export interface LibraryDockProps {
  /** Ditimpa di tes. Default dari `import.meta.env.VITE_LIBRARY_API`. */
  readonly apiBase?: string;
  /** Ditimpa di tes supaya tidak ada HTTP sungguhan. */
  readonly api?: LibraryApi;
  /**
   * Dipanggil sesudah satu lagu mendarat jadi asset sesi ini.
   *
   * Studio memakainya untuk menaruh lagunya ke lane; halaman lain bisa
   * melakukan hal lain. Dock tidak punya pendapat soal itu.
   */
  readonly onLoaded?: (assetId: number, track: LibraryTrack) => void;
}

const ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0,1fr) 64px 72px auto',
  alignItems: 'center',
  gap: '10px',
  padding: '6px 10px',
  border: '1px solid var(--cy-border)',
  background: 'var(--cy-surface-1)',
};

const CELL: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--cy-text-dim)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

export function LibraryDock({ apiBase, api: injected, onLoaded }: LibraryDockProps): JSX.Element {
  const base = (apiBase ?? import.meta.env.VITE_LIBRARY_API ?? '').trim();
  const api = useMemo<LibraryApi | null>(
    () => injected ?? (base === '' ? null : createLibraryApi(base)),
    [base, injected],
  );

  const state = useLibrary();
  const assets = useStudio((s) => s.assets);
  const [note, setNote] = useState<string | null>(null);

  /*
   * Boot: siapa yang login, lalu daftarnya.
   *
   * Daftar TIDAK diambil kalau `/me` menjawab belum login — permintaan yang
   * sudah pasti 401 hanya menambah satu baris merah di konsol tanpa memberi
   * tahu siapa pun apa pun.
   */
  useEffect(() => {
    if (api === null) {
      libraryActions.setStatus('tidak-dikonfigurasi');
      return undefined;
    }
    let alive = true;
    libraryActions.setStatus('memeriksa');

    void (async () => {
      try {
        const user = await api.me();
        if (!alive) return;
        if (user === null) {
          libraryActions.setStatus('anonim');
          return;
        }
        libraryActions.setStatus('masuk', user);
        libraryActions.setListing(true);
        const [tracks, projects] = await Promise.all([api.tracks(), api.projects()]);
        if (!alive) return;
        libraryActions.setTracks(tracks);
        libraryActions.setProjects(projects);
      } catch (err: unknown) {
        if (alive) libraryActions.fail(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      alive = false;
    };
  }, [api]);

  /*
   * Unggah otomatis, TAPI hanya saat sudah login.
   *
   * Sink dipasang di sini — bukan di jalur import — supaya `audio-import.ts`
   * tetap tidak tahu apa-apa soal jaringan, dan supaya halaman tanpa
   * kepustakaan tidak membayar apa pun. Saat belum login sink tidak terpasang
   * sama sekali: import berjalan persis seperti sebelum kepustakaan ada.
   *
   * Daftar disegarkan sesudah antrean selesai, bukan per lagu: lima import
   * sekaligus berarti lima `GET /tracks` yang empat di antaranya sudah basi
   * sebelum sampai.
   */
  useEffect(() => {
    if (api === null || state.status !== 'masuk') return undefined;

    const queue = createUploadQueue(api);
    const detach = registerImportSink((imported) => {
      queue.push(imported);
      void queue.idle().then(async () => {
        try {
          libraryActions.setTracks(await api.tracks());
        } catch {
          // Daftar yang gagal disegarkan bukan alasan menandai kepustakaan
          // rusak: unggahannya sendiri sudah selesai dan tercatat di server.
        }
      });
    });
    return detach;
  }, [api, state.status]);

  useCommands(
    [
      {
        id: 'library.toggle',
        title: 'Kepustakaan: buka/tutup',
        group: 'Kepustakaan',
        defaultChord: null,
        run: () => libraryActions.toggleCollapsed(),
      },
    ],
    [],
  );

  const onPick = useCallback(
    async (track: LibraryTrack): Promise<void> => {
      if (api === null) return;
      setNote(null);
      const out = await loadTrack(api, track);
      if (!out.ok) {
        setNote(`${track.name}: ${out.message}`);
        return;
      }
      onLoaded?.(out.assetId, track);
      setNote(out.cached ? `${track.name} sudah ada di sesi ini` : null);
    },
    [api, onLoaded],
  );

  /**
   * Hapus lagu dari kepustakaan (L7).
   *
   * Server menolak kalau masih dipakai project, DENGAN menyebut project mana —
   * pesan itu diteruskan apa adanya. Menggantinya dengan "gagal menghapus"
   * berarti membuang satu-satunya petunjuk yang bisa dikerjakan user.
   */
  const onRemove = useCallback(
    async (track: LibraryTrack): Promise<void> => {
      if (api === null) return;
      libraryActions.setNotice(null);
      try {
        await api.deleteTrack(track.hash);
        libraryActions.setTracks(await api.tracks());
        libraryActions.setNotice(`${track.name} dihapus dari kepustakaan`);
      } catch (err: unknown) {
        libraryActions.setNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [api],
  );

  const collapsed = state.collapsed;

  return (
    <div
      data-testid="library-dock"
      style={{
        position: 'sticky',
        bottom: 0,
        zIndex: 15,
        background: 'var(--cy-surface-1)',
        borderTop: '1px solid var(--cy-border)',
        // Bayangan ke ATAS: tanpa itu, dok yang menempel terlihat menyatu
        // dengan isi yang lewat di belakangnya saat halaman digulir.
        boxShadow: '0 -8px 20px #00000066',
      }}
    >
      <Header
        collapsed={collapsed}
        onToggle={() => libraryActions.toggleCollapsed()}
        api={api}
      />

      {collapsed ? null : (
        <div
          style={{
            // Dibatasi tinggi DAN menggulir sendiri: kepustakaan 200 lagu tidak
            // boleh mendorong timeline keluar layar.
            maxHeight: '34vh',
            overflowY: 'auto',
            padding: '8px 12px 12px',
            display: 'grid',
            gap: '6px',
          }}
        >
          {note !== null ? (
            <p role="status" style={{ margin: 0, fontSize: '10px', color: 'var(--cy-warning)' }}>
              {note}
            </p>
          ) : null}

          <Tabs tab={state.tab} onTab={libraryActions.setTab} />

          {state.notice === null ? null : (
            <p role="status" style={{ margin: 0, fontSize: '10px', color: 'var(--cy-warning)' }}>
              {state.notice}
            </p>
          )}

          {state.tab === 'lagu' ? (
            <>
              <Uploads uploads={state.uploads} />
              <Body state={state} api={api} assets={assets} onPick={onPick} onRemove={onRemove} />
            </>
          ) : (
            <Projects state={state} api={api} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Bagian ───────────────────────────────────────────────────────────────────

function Header({
  collapsed,
  onToggle,
  api,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly api: LibraryApi | null;
}): JSX.Element {
  const status = useLibrary((s) => s.status);
  const user = useLibrary((s) => s.user);
  const tracks = useLibrary((s) => s.tracks);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 12px' }}>
      {/*
       * SELURUH strip adalah tombolnya, bukan segitiga 12 piksel di pojok.
       * Sasaran sebesar strip tidak pernah meleset, dan ini kontrol yang
       * dipakai berkali-kali dalam satu sesi.
       */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'buka kepustakaan' : 'tutup kepustakaan'}
        className="cy-btn-reset cy-focusable"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          flex: 1,
          minWidth: 0,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '10px', color: 'var(--cy-accent)', width: '10px' }}>
          {collapsed ? '▲' : '▼'}
        </span>
        <span style={{ fontSize: '11px', letterSpacing: '.22em', color: 'var(--cy-accent)' }}>
          KEPUSTAKAAN
        </span>
        <span style={{ fontSize: '10px', letterSpacing: '.14em', color: 'var(--cy-text-muted)' }}>
          {status === 'masuk' ? summarize(tracks) : LABEL[status]}
        </span>
      </button>

      {status === 'masuk' && user !== null ? (
        <>
          <Badge tone="success" height={22} dot>
            {user.name}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void api?.logout().then(() => libraryActions.signedOut());
            }}
          >
            KELUAR
          </Button>
        </>
      ) : null}

      {status === 'anonim' && api !== null ? (
        <Button
          size="sm"
          onClick={() => {
            /*
             * NAVIGASI, bukan fetch: `/auth/google` membalas 302 ke layar
             * consent Google, dan mengambilnya lewat fetch tidak pernah bisa
             * berhasil. Path sekarang dititipkan supaya user kembali ke
             * tempat ia menekan tombol.
             */
            window.location.href = api.loginUrl(window.location.pathname);
          }}
        >
          MASUK DENGAN GOOGLE
        </Button>
      ) : null}

      {status === 'gagal' ? (
        <Badge tone="danger" height={22}>
          TIDAK TERSAMBUNG
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * Keterangan di strip.
 *
 * `masuk` dan `gagal` kosong dengan sengaja: keduanya sudah punya badge di
 * sisi kanan strip yang sama, dan mengulang kalimat yang sama dua kali dalam
 * satu baris membuat keduanya terbaca seperti dua hal berbeda.
 */
const LABEL: Readonly<Record<string, string>> = {
  'tidak-dikonfigurasi': 'BELUM DIPASANG',
  memeriksa: 'MEMERIKSA…',
  anonim: 'BELUM MASUK',
  gagal: '',
  masuk: '',
};

function Body({
  state,
  api,
  assets,
  onPick,
  onRemove,
}: {
  readonly state: LibraryState;
  readonly api: LibraryApi | null;
  readonly assets: Readonly<Record<number, unknown>>;
  readonly onPick: (track: LibraryTrack) => void | Promise<void>;
  readonly onRemove: (track: LibraryTrack) => void | Promise<void>;
}): JSX.Element {
  if (api === null) {
    return (
      <Empty>
        Kepustakaan belum dipasang di build ini. Isi <code>VITE_LIBRARY_API</code> dengan
        alamat Worker kepustakaan; sampai itu ada, import berkas lokal tetap berjalan penuh.
      </Empty>
    );
  }
  if (state.status === 'memeriksa') return <Empty>Memeriksa sesi…</Empty>;
  if (state.status === 'gagal') {
    return <Empty tone="danger">{state.error ?? 'server kepustakaan tidak menjawab'}</Empty>;
  }
  if (state.status === 'anonim') {
    return (
      <Empty>
        Masuk untuk menyimpan lagu dan project. Tanpa akun, semuanya tetap bisa dipakai —
        yang tidak ada hanyalah daya tahan: refresh mengosongkan sesi.
      </Empty>
    );
  }
  if (state.listing) return <Empty>Mengambil daftar…</Empty>;
  if (state.tracks.length === 0) {
    return <Empty>Kepustakaan masih kosong. Lagu yang diunggah akan muncul di sini.</Empty>;
  }

  return (
    <div role="table" aria-label="kepustakaan" style={{ display: 'grid', gap: '4px' }}>
      {state.tracks.map((track) => {
        const assetId = state.loaded[track.hash];
        // "Sudah dimuat" berarti asetnya MASIH ada di store — bukan sekadar
        // pernah dimuat. Lagu yang dihapus user dari Collection harus bisa
        // diambil lagi dari sini.
        const inSession = assetId !== undefined && assets[assetId] !== undefined;
        const percent = state.loading[track.hash];

        return (
          <div key={track.hash} role="row" style={ROW}>
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
              {percent !== undefined ? (
                <div style={{ marginTop: '4px' }}>
                  <ProgressBar value={percent} showValue label="MENGUNDUH" />
                </div>
              ) : null}
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
      })}
    </div>
  );
}

/** Dua tab: lagu dan project. Keduanya kepustakaan, umurnya beda. */
function Tabs({
  tab,
  onTab,
}: {
  readonly tab: 'lagu' | 'project';
  readonly onTab: (t: 'lagu' | 'project') => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '6px' }}>
      {(['lagu', 'project'] as const).map((t) => (
        <Button
          key={t}
          size="sm"
          variant="outline"
          active={tab === t}
          aria-pressed={tab === t}
          onClick={() => onTab(t)}
        >
          {t}
        </Button>
      ))}
    </div>
  );
}

/**
 * Tab PROJECT: simpan yang sekarang, buka yang tersimpan, hapus yang tidak
 * dipakai lagi.
 *
 * Tombol SIMPAN sengaja menolak lebih dulu kalau ada lagu yang belum ada di
 * kepustakaan — dengan menyebut NAMANYA. Server juga menolak (dan itu yang
 * mengikat), tapi ia hanya tahu hash; yang tahu bahwa hash itu bernama
 * "Kelas Malam — Set 3" cuma sisi ini.
 */
function Projects({
  state,
  api,
}: {
  readonly state: LibraryState;
  readonly api: LibraryApi | null;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  if (api === null) return <Empty>Kepustakaan belum dipasang di build ini.</Empty>;
  if (state.status !== 'masuk') return <Empty>Masuk untuk menyimpan project.</Empty>;

  const open = state.openProject;

  const doSave = async (): Promise<void> => {
    const belum = unsavedAssets();
    if (belum.length > 0) {
      libraryActions.setNotice(
        `${belum.length} lagu belum ada di kepustakaan: ${belum.join(', ')}. ` +
          'Unggah dulu — project yang menunjuk lagu yang tidak ada akan gagal dibuka nanti.',
      );
      return;
    }

    setBusy(true);
    libraryActions.setNotice(null);
    const out = await saveProject(api, {
      id: open?.id ?? null,
      name: open?.name ?? currentProjectName(),
      version: open?.version ?? 0,
    });
    setBusy(false);

    if (!out.ok) {
      libraryActions.setNotice(
        out.conflict
          ? `${out.message} — buka ulang project ini sebelum menyimpan, atau simpan sebagai project baru.`
          : out.message,
      );
      return;
    }
    libraryActions.setOpenProject({
      id: out.id,
      name: open?.name ?? currentProjectName(),
      version: out.version,
    });
    libraryActions.setNotice(`tersimpan (versi ${out.version})`);
    try {
      libraryActions.setProjects(await api.projects());
    } catch {
      // Daftar yang gagal disegarkan bukan alasan meragukan simpan yang sudah
      // dijawab server dengan versi baru.
    }
  };

  const doOpen = async (id: string, name: string, version: number): Promise<void> => {
    setBusy(true);
    libraryActions.setNotice('mengunduh audionya…');
    const out = await openProject(api, id, (done, total) => {
      libraryActions.setNotice(total === 0 ? 'memuat…' : `mengunduh ${done}/${total} lagu…`);
    });
    setBusy(false);

    if (!out.ok) {
      libraryActions.setNotice(out.message);
      return;
    }
    libraryActions.setOpenProject({ id, name, version });
    libraryActions.setNotice(
      out.missingAssets === 0
        ? `${name} dibuka`
        : `${name} dibuka — ${out.missingAssets} lagu tidak bisa dimuat, clip-nya bisu`,
    );
  };

  const doDelete = async (id: string, name: string): Promise<void> => {
    setBusy(true);
    try {
      await api.deleteProject(id);
      libraryActions.setProjects(await api.projects());
      if (state.openProject?.id === id) libraryActions.setOpenProject(null);
      libraryActions.setNotice(`${name} dihapus`);
    } catch (err: unknown) {
      libraryActions.setNotice(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'grid', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <Button size="sm" disabled={busy} onClick={() => void doSave()}>
          {open === null ? 'SIMPAN BARU' : 'SIMPAN'}
        </Button>
        {open === null ? (
          <span style={{ fontSize: '10px', color: 'var(--cy-text-muted)' }}>
            belum tersimpan di sesi ini
          </span>
        ) : (
          <Badge tone="success" height={22}>
            {open.name} · v{open.version}
          </Badge>
        )}
      </div>

      {state.projects.length === 0 ? (
        <Empty>Belum ada project tersimpan.</Empty>
      ) : (
        <div role="table" aria-label="project" style={{ display: 'grid', gap: '4px' }}>
          {state.projects.map((p) => (
            <div key={p.id} role="row" style={ROW}>
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--cy-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.name}
              </span>
              <span style={CELL}>v{p.version}</span>
              <span style={CELL} />
              <div style={{ display: 'flex', gap: '6px' }}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void doOpen(p.id, p.name, p.version)}
                >
                  BUKA
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`hapus project ${p.name}`}
                  onClick={() => void doDelete(p.id, p.name)}
                >
                  HAPUS
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Unggahan yang sedang berjalan.
 *
 * Yang SELESAI tidak muncul di sini sama sekali — lagunya pindah ke daftar
 * kepustakaan di bawahnya, dan itu bukti yang lebih baik daripada baris
 * "selesai" yang menumpuk. Yang GAGAL bertahan sampai dibuang user, karena
 * kegagalan yang menghilang sendiri sama saja tidak pernah dilaporkan.
 */
function Uploads({
  uploads,
}: {
  readonly uploads: Readonly<Record<string, UploadState>>;
}): JSX.Element | null {
  const rows = Object.entries(uploads);
  if (rows.length === 0) return null;

  return (
    <div style={{ display: 'grid', gap: '4px' }}>
      {rows.map(([hash, up]) => (
        <div
          key={hash}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) auto',
            alignItems: 'center',
            gap: '10px',
            padding: '6px 10px',
            border: `1px solid ${up.phase === 'gagal' ? '#ff4d4d59' : 'var(--cy-border)'}`,
            background: up.phase === 'gagal' ? '#ff4d4d0f' : 'var(--cy-surface-2)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: '10px',
                color: up.phase === 'gagal' ? '#ff4d4d' : 'var(--cy-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {up.name}
              {up.error === null ? '' : ` — ${up.error}`}
            </div>
            {up.phase === 'mengunggah' ? (
              <div style={{ marginTop: '4px' }}>
                <ProgressBar value={up.percent} showValue label="MENGUNGGAH" />
              </div>
            ) : null}
          </div>

          {up.phase === 'gagal' ? (
            <Button size="sm" variant="ghost" onClick={() => libraryActions.dismissUpload(hash)}>
              TUTUP
            </Button>
          ) : (
            <Badge tone="accent" height={22} dot pulse>
              {up.phase.toUpperCase()}
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}

function Empty({
  children,
  tone,
}: {
  readonly children: React.ReactNode;
  readonly tone?: 'danger';
}): JSX.Element {
  return (
    <p
      style={{
        margin: 0,
        padding: '10px 2px',
        fontSize: '10px',
        lineHeight: 1.7,
        color: tone === 'danger' ? '#ff4d4d' : 'var(--cy-text-muted)',
      }}
    >
      {children}
    </p>
  );
}
