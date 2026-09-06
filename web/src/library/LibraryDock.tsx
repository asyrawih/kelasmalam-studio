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
 *
 * ## Dari mana kepustakaannya: tanya host, bukan env
 *
 * `getPlatformHost().libraryApi()` — web memberi klien Worker dari env (atau
 * `null`), desktop memberi kepustakaan LOKAL di atas SQLite + folder (docs/21).
 * Dock tidak tahu bedanya dan memang tidak boleh tahu: kedua implementasi
 * memenuhi `LibraryApi` yang sama, dan yang membedakan hanyalah dua hal yang
 * memang soal sesi — tombol MASUK/KELUAR (ada kalau host punya `login`) dan
 * kalimat di strip.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useCommands } from '../app-shell';
import { Badge, Button, ProgressBar } from '../ui/cyber';
import { studioStore, useStudio } from '../studio/store';
import { djStore } from '../dj/store';
import { registerImportSink } from '../studio/timeline/import-sink';
import { registerLibraryDropHandler } from '../studio/timeline/library-drop';
import { placeAssetOnLane } from '../studio/timeline/audio-import';
import { getPlatformHost } from '../platform';
import { createLibraryApi, type LibraryApi } from './api';
import { loadTrack } from './load-track';
import {
  openProject,
  renameProject,
  saveProject,
  unsavedAssets,
} from './projects';
import { formatBytes, summarize, type LibraryTrack, type UploadState } from './model';
import { libraryActions, libraryStore, useLibrary } from './store';
import { createMarksSync } from './marks';
import { createUploadQueue } from './upload';
import { LibraryBrowser } from './LibraryBrowser';

export interface LibraryDockProps {
  /** Ditimpa di tes. Default: `getPlatformHost().libraryApi()`. `''` = tanpa kepustakaan. */
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



export function LibraryDock({ apiBase, api: injected, onLoaded }: LibraryDockProps): JSX.Element {
  const host = getPlatformHost();
  const api = useMemo<LibraryApi | null>(() => {
    if (injected !== undefined) return injected;
    if (apiBase !== undefined) return apiBase.trim() === '' ? null : createLibraryApi(apiBase);
    return host.libraryApi();
  }, [apiBase, injected, host]);
  /*
   * Ada tidaknya sesi = ada tidaknya `login` di host. Kepustakaan lokal tidak
   * punya sesi sama sekali: tidak ada yang bisa dimasuki maupun ditinggalkan,
   * jadi kedua tombolnya tidak dirender — bukan dinonaktifkan.
   */
  const hasSession = host.login !== undefined;

  const state = useLibrary();
  const assets = useStudio((s) => s.assets);
  const [busy, setBusy] = useState(false);
  /*
   * Nama untuk project BARU, hidup selama dok terbuka.
   *
   * Di komponen, bukan di store: ia cuma berarti sampai tombol simpan ditekan,
   * dan menyimpan ketikan setengah jadi ke store berarti setiap huruf
   * membangunkan seluruh pelanggan kepustakaan.
   */
  const [saveName, setSaveName] = useState('');

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
          /*
           * "Belum masuk" hanya berguna kalau ada cara untuk masuk. Tanpa
           * `login` di host (desktop yang diberi klien Worker), ajakan MASUK
           * adalah tombol yang tidak bisa berbuat apa-apa — keadaan yang jujur
           * adalah "belum tersedia". Kepustakaan lokal tidak pernah lewat sini:
           * `me()`-nya tidak pernah `null`.
           */
          libraryActions.setStatus(hasSession ? 'anonim' : 'tidak-tersedia');
          return;
        }
        libraryActions.setStatus('masuk', user);
        libraryActions.setListing(true);
        const [tracks, projects] = await Promise.all([api.tracks(), api.projects()]);
        if (!alive) return;
        libraryActions.setTracks(tracks);
        libraryActions.setProjects(projects);
        if (api.storeInfo !== undefined) {
          // Hanya kepustakaan lokal yang punya folder. Gagal di sini tidak
          // meruntuhkan dok: daftarnya sudah tampil, yang hilang cuma angka.
          const info = await api.storeInfo().catch(() => null);
          if (alive && info !== null) libraryActions.setStoreInfo({ dir: info.dir, bytes: info.bytes });
        }
      } catch (err: unknown) {
        if (alive) libraryActions.fail(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      alive = false;
    };
  }, [api, hasSession]);

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

    /*
     * Berkas yang datang dari Finder/dialog native punya path, dan host masih
     * mengingatnya: kepustakaan lokal menyalin dari path itu di Rust alih-alih
     * menerima byte-nya lewat IPC untuk kedua kalinya (docs/21 §1c).
     */
    const queue = createUploadQueue(api, {
      pathOf: (imported) => host.droppedPathFor?.(imported.name, imported.bytes.byteLength) ?? null,
    });
    const detach = registerImportSink((imported) => {
      // Pilihan ditangkap saat file dijatuhkan. User boleh pindah folder saat
      // unggahan masih berjalan tanpa membuat lagunya mendarat di folder lain.
      const targetProject = libraryStore.getState().selectedProject;
      queue.push(imported);
      void queue.idle().then(async () => {
        try {
          if (targetProject !== null) {
            await api.addProjectTrack(targetProject, imported.contentHash);
            const cached = libraryStore.getState().projectTracks[targetProject];
            if (cached !== undefined && cached !== 'memuat' && !cached.includes(imported.contentHash)) {
              libraryActions.setProjectTracks(targetProject, [...cached, imported.contentHash]);
            }
          }
          libraryActions.setTracks(await api.tracks());
        } catch (err: unknown) {
          libraryActions.setNotice(err instanceof Error ? err.message : String(err));
        }
      });
    });
    return detach;
  }, [api, host, state.status]);

  /*
   * Cue DJ + koreksi grid ikut tersimpan (L5).
   *
   * Dipasang sebagai PENGAMAT store, bukan panggilan di tiap aksi cue: aksi
   * yang menyentuh cue ada belasan (hot cue, memory cue, CUE, grid, kunci,
   * anchor), dan menempelkan satu baris ke masing-masing berarti dua belas
   * tempat yang harus diingat — dan satu di antaranya suatu saat terlupa.
   *
   * Yang diamati cukup dua irisan: peta cue milik DJ dan registry asset milik
   * Studio. Perubahan lain (posisi fader, playhead) tidak menyentuh keduanya.
   */
  useEffect(() => {
    if (api === null || state.status !== 'masuk') return undefined;

    const sync = createMarksSync(api);
    const known = (): ReadonlyMap<number, string> => {
      const out = new Map<number, string>();
      for (const [hash, assetId] of Object.entries(libraryStore.getState().loaded)) {
        out.set(assetId, hash);
      }
      return out;
    };

    let prevCues = djStore.getState().cues;
    let prevAssets = studioStore.getState().assets;

    const onChange = (): void => {
      const map = known();
      const cues = djStore.getState().cues;
      const assets = studioStore.getState().assets;

      if (cues !== prevCues) {
        for (const [id, hash] of map) {
          if (cues[id] !== prevCues[id]) sync.touch(id, hash);
        }
        prevCues = cues;
      }
      if (assets !== prevAssets) {
        for (const [id, hash] of map) {
          if (assets[id] !== prevAssets[id]) sync.touch(id, hash);
        }
        prevAssets = assets;
      }
    };

    const offDj = djStore.subscribe(onChange);
    const offStudio = studioStore.subscribe(onChange);
    return () => {
      offDj();
      offStudio();
      // Yang tertunda dikirim saat halaman ditinggalkan — cue yang dipasang
      // dua detik sebelum pindah halaman tidak boleh hilang karena timernya
      // belum sempat berbunyi.
      void sync.flush();
    };
  }, [api, state.status]);

  /*
   * Lagu yang diseret ke lane.
   *
   * Timeline hanya mengumumkan hash + lane + posisinya; yang tahu cara
   * mengambil lagunya adalah sisi ini. Kalau asetnya sudah ada di sesi, tidak
   * ada satu byte pun yang diunduh — `loadTrack` menjawab dari peta `loaded`.
   */
  useEffect(() => {
    if (api === null) return undefined;

    return registerLibraryDropHandler(({ contentHash, laneId, startSamples }) => {
      const track = libraryStore.getState().tracks.find((t) => t.hash === contentHash);
      if (track === undefined) {
        libraryActions.setNotice('lagu itu sudah tidak ada di kepustakaan');
        return;
      }

      void (async () => {
        const out = await loadTrack(api, track);
        if (!out.ok) {
          libraryActions.setNotice(`${track.name}: ${out.message}`);
          return;
        }
        const asset = studioStore.getState().assets[out.assetId];
        placeAssetOnLane(
          out.assetId,
          track.name,
          asset?.frames ?? track.frames,
          laneId,
          startSamples,
        );
        libraryActions.setNotice(null);
      })();
    });
  }, [api]);

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
      libraryActions.setNotice(null);
      const out = await loadTrack(api, track);
      if (!out.ok) {
        libraryActions.setNotice(`${track.name}: ${out.message}`);
        return;
      }
      onLoaded?.(out.assetId, track);
      libraryActions.setNotice(out.cached ? `${track.name} sudah ada di sesi ini` : null);
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
    async (track: LibraryTrack, projectId: string | null): Promise<void> => {
      if (api === null) return;
      libraryActions.setNotice(null);
      try {
        if (projectId !== null) {
          const deleted = await api.removeProjectTrack(projectId, track.hash);
          const cached = libraryStore.getState().projectTracks[projectId];
          if (cached !== undefined && cached !== 'memuat') {
            libraryActions.setProjectTracks(projectId, cached.filter((hash) => hash !== track.hash));
          }
          if (deleted) libraryActions.setTracks(await api.tracks());
          libraryActions.setNotice(
            deleted
              ? `${track.name} dihapus karena tidak ada di project lain`
              : `${track.name} dikeluarkan dari project`,
          );
        } else {
          await api.deleteTrack(track.hash);
          libraryActions.setTracks(await api.tracks());
          libraryActions.setNotice(`${track.name} dihapus dari kepustakaan`);
        }
      } catch (err: unknown) {
        libraryActions.setNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [api],
  );

  /*
   * Simpan, buka, hapus project — sebelumnya tinggal di dalam tab PROJECT.
   *
   * Sekarang di sini, karena pohon tidak punya "tab" untuk menampungnya, dan
   * karena ketiganya menyentuh state yang sama dengan muat/hapus lagu: satu
   * `busy` untuk semuanya berarti tidak ada dua perbuatan berat yang bisa
   * berjalan bersamaan tanpa terlihat.
   */
  const onCreateProject = useCallback(async (): Promise<void> => {
    if (api === null) return;
    const nama = saveName.trim();
    if (nama === '') return;

    setBusy(true);
    libraryActions.setNotice(null);
    const out = await saveProject(api, { id: null, name: nama, version: 0 });
    setBusy(false);
    if (!out.ok) {
      libraryActions.setNotice(out.message);
      return;
    }

    setSaveName('');
    libraryActions.selectProject(out.id);
    libraryActions.setProjectTracks(out.id, []);
    libraryActions.setNotice(`${nama} dibuat`);
    try {
      libraryActions.setProjects(await api.projects());
    } catch {
      // Folder sudah dibuat; kegagalan refresh daftar tidak membatalkannya.
    }
  }, [api, saveName]);

  const onSave = useCallback(async (): Promise<void> => {
    if (api === null) return;
    const belum = unsavedAssets();
    if (belum.length > 0) {
      libraryActions.setNotice(
        `${belum.length} lagu belum ada di kepustakaan: ${belum.join(', ')}. ` +
          'Unggah dulu — project yang menunjuk lagu yang tidak ada akan gagal dibuka nanti.',
      );
      return;
    }

    const open = libraryStore.getState().openProject;
    if (open === null) return;
    const nama = open.name;

    setBusy(true);
    libraryActions.setNotice(null);
    const out = await saveProject(api, {
      id: open.id,
      name: nama,
      version: open.version,
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
    libraryActions.setOpenProject({ id: out.id, name: nama, version: out.version });
    // Isi foldernya berubah; yang di-cache sudah tidak berlaku.
    libraryActions.forgetProjectTracks(out.id);
    libraryActions.setNotice(`tersimpan (versi ${out.version})`);
    try {
      libraryActions.setProjects(await api.projects());
    } catch {
      // Daftar yang gagal disegarkan bukan alasan meragukan simpan yang sudah
      // dijawab server dengan versi baru.
    }
  }, [api]);

  const onOpen = useCallback(
    async (id: string, name: string, version: number): Promise<void> => {
      if (api === null) return;
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
    },
    [api],
  );

  const onRename = useCallback(
    async (id: string, name: string): Promise<void> => {
      if (api === null) return;
      setBusy(true);
      libraryActions.setNotice(null);
      const out = await renameProject(api, id, name);
      setBusy(false);

      if (!out.ok) {
        libraryActions.setNotice(
          out.conflict
            ? `${out.message} — muat ulang daftar sebelum mengganti namanya.`
            : out.message,
        );
        return;
      }
      // Versinya ikut naik: PUT yang mengganti nama tetap PUT, dan tab ini
      // harus memegang versi terbaru kalau tidak simpan berikutnya kalah.
      const open = libraryStore.getState().openProject;
      if (open?.id === id) libraryActions.setOpenProject({ id, name, version: out.version });
      try {
        libraryActions.setProjects(await api.projects());
      } catch {
        // Daftar yang gagal disegarkan bukan alasan meragukan penggantian nama
        // yang sudah dijawab server dengan versi baru.
      }
      libraryActions.setNotice(`nama diganti jadi ${name}`);
    },
    [api],
  );

  const onDeleteProject = useCallback(
    async (id: string, name: string): Promise<void> => {
      if (api === null) return;
      setBusy(true);
      try {
        await api.deleteProject(id);
        const [projects, tracks] = await Promise.all([api.projects(), api.tracks()]);
        libraryActions.setProjects(projects);
        libraryActions.setTracks(tracks);
        libraryActions.forgetProjectTracks(id);
        if (libraryStore.getState().selectedProject === id) libraryActions.selectProject(null);
        if (libraryStore.getState().openProject?.id === id) libraryActions.setOpenProject(null);
        libraryActions.setNotice(`${name} dihapus`);
      } catch (err: unknown) {
        libraryActions.setNotice(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
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
        hasSession={hasSession}
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

          {state.notice === null ? null : (
            <p role="status" style={{ margin: 0, fontSize: '10px', color: 'var(--cy-warning)' }}>
              {state.notice}
            </p>
          )}

          {state.store === null ? null : (
            /*
             * Folder dan ukurannya DI DISK — termasuk basis datanya, dan
             * termasuk salinan lagu yang mungkin juga masih disimpan user di
             * tempat lain. Itu harga yang jujur (docs/21 §1b), dan backup-nya
             * adalah menyalin folder ini.
             */
            <p
              data-testid="library-store"
              title={state.store.dir}
              style={{
                margin: 0,
                fontSize: '10px',
                letterSpacing: '.08em',
                color: 'var(--cy-text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              KEPUSTAKAAN LOKAL · {formatBytes(state.store.bytes)} di disk · {state.store.dir}
            </p>
          )}

          <Uploads uploads={state.uploads} />

          {api === null ? (
            <Empty>
              Kepustakaan belum dipasang di build ini. Isi <code>VITE_LIBRARY_API</code> dengan
              alamat Worker kepustakaan; sampai itu ada, import berkas lokal tetap berjalan penuh.
            </Empty>
          ) : state.status === 'tidak-tersedia' ? (
            <Empty>
              Kepustakaan ini butuh akun, dan versi ini tidak punya cara masuk. Import berkas
              lokal dan export tetap berjalan penuh.
            </Empty>
          ) : state.status === 'memeriksa' ? (
            <Empty>Memeriksa sesi…</Empty>
          ) : state.status === 'gagal' ? (
            <Empty tone="danger">{state.error ?? 'server kepustakaan tidak menjawab'}</Empty>
          ) : state.status === 'anonim' ? (
            <Empty>
              Masuk untuk menyimpan lagu dan project. Tanpa akun, semuanya tetap bisa dipakai —
              yang tidak ada hanyalah daya tahan: refresh mengosongkan sesi.
            </Empty>
          ) : state.listing ? (
            <Empty>Mengambil daftar…</Empty>
          ) : (
            <LibraryBrowser
              state={state}
              api={api}
              assets={assets}
              onPick={onPick}
              onRemove={onRemove}
              onCreateProject={onCreateProject}
              onSave={onSave}
              onOpen={onOpen}
              onDeleteProject={onDeleteProject}
              onRename={onRename}
              onSaveName={setSaveName}
              saveName={saveName}
              busy={busy}
            />
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
  hasSession,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly api: LibraryApi | null;
  /** Host punya `login` → ada MASUK saat anonim dan KELUAR saat masuk. */
  readonly hasSession: boolean;
}): JSX.Element {
  const host = getPlatformHost();
  const status = useLibrary((s) => s.status);
  const user = useLibrary((s) => s.user);
  const tracks = useLibrary((s) => s.tracks);
  const store = useLibrary((s) => s.store);

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
          {/* Lokal: nama user-nya "KEPUSTAKAAN LOKAL", dan folder-nya di tooltip. */}
          <span title={store?.dir}>
            <Badge tone="success" height={22} dot>
              {user.name}
            </Badge>
          </span>
          {hasSession ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void api?.logout().then(() => libraryActions.signedOut());
              }}
            >
              KELUAR
            </Button>
          ) : null}
        </>
      ) : null}

      {status === 'anonim' && api !== null && hasSession ? (
        <Button
          size="sm"
          onClick={() => {
            /*
             * NAVIGASI, bukan fetch: `/auth/google` membalas 302 ke layar
             * consent Google, dan mengambilnya lewat fetch tidak pernah bisa
             * berhasil. Path sekarang dititipkan supaya user kembali ke
             * tempat ia menekan tombol. Promise-nya tidak pernah selesai —
             * halaman ini dibongkar.
             */
            void host.login?.({ apiBase: api.base, nextPath: window.location.pathname });
          }}
        >
          MASUK DENGAN GOOGLE
        </Button>
      ) : null}

      {status === 'tidak-tersedia' ? (
        <Badge tone="warning" height={22}>
          TIDAK ADA CARA MASUK
        </Badge>
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
  // Kosong: badge di kanan strip sudah mengatakannya.
  'tidak-tersedia': '',
  memeriksa: 'MEMERIKSA…',
  anonim: 'BELUM MASUK',
  gagal: '',
  masuk: '',
};

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
