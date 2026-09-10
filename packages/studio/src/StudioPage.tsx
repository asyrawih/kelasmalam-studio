/**
 * Audio Studio — halaman aplikasi (`StudioPage`; sebelum docs/25 P3 bernama
 * `App` di `apps/web/src/App.tsx`).
 *
 * Halaman ini TIDAK tahu kepustakaan maupun dialog impor mana yang ada:
 * `dock` (dok kepustakaan) dan `extras` (tombol + dialog SoundCloud, YouTube)
 * disuntik app yang merendernya. Alasannya graf paket: `library → studio`
 * dan `soundcloud → studio` sudah ada, dan panah balik berarti siklus.
 *
 * Susunannya mengikuti `design/Audio Studio.dc.html` baris per baris:
 *   header bar → readout strip → body 2 kolom
 *   kolom kiri : Card Timeline + Card Clip Detail
 *   kolom kanan: rail (Transport / MIX / EQ / COMPILE) — milik agent lain
 *
 * Engine di-import DINAMIS dan boleh gagal: build WASM belum ada di repo, dan
 * seluruh UI harus tetap render serta interaktif tanpanya. Kalau engine tidak
 * ada, tidak ada audio yang berbunyi — badge di header berkata "UI ONLY" alih-
 * alih "READY" — tapi playhead tetap berjalan supaya timeline bisa diuji.
 */

import { useEffect, type ReactNode } from 'react';
import { ReadoutStrip, StudioHeader, StudioLayout } from './studio/shell';
import type { ImportAction } from './studio/shell/StudioHeader';
import { MenuBar } from './studio/shell/MenuBar';
import { STUDIO_MENUS } from './studio/shell/StudioMenus';
import { TransportButtons } from './studio/shell/TransportButtons';
import { ReorderableStack } from './studio/shell/ReorderableStack';
import { studioActions, studioStore } from './studio/store';
import { registerExportHost } from './studio/rail/export-bridge';
import { bufferLookup, previewPositionSec } from './studio/preview/audio-preview';
import { BeatProvider, TimelinePanel } from './studio/timeline';
import { usePreviewPlayback } from './studio/preview/usePreviewPlayback';
import { studioCommands } from './studio/commands';
import { useCommands } from '@kelasmalam/shell/useCommands';
import { SnapToggle } from './studio/shell/SnapToggle';

export interface StudioPageProps {
  /**
   * Dipanggil sekali untuk mencoba membangun lapisan audio. Mengembalikan
   * objek apa pun kalau berhasil, atau null/melempar kalau lingkungan ini
   * belum bisa (mis. WASM belum di-build). UI tidak peduli bentuknya — ia
   * hanya butuh tahu berhasil atau tidak.
   */
  readonly createEngine?: () => Promise<unknown>;
  readonly onClose?: () => void;
  /** Buka halaman `/dj`. Diteruskan apa adanya ke header. */
  readonly onOpenDj?: () => void;
  /** Buka halaman `/roblox`. Diteruskan apa adanya ke header. */
  readonly onOpenRoblox?: () => void;
  /** Tidak dipakai lagi — rail kanan sudah tidak ada. Dipertahankan supaya
   *  pemanggil lama tidak perlu ikut diubah. */
  readonly railWidth?: number;
  /**
   * Yang disuntik APP ke halaman ini (docs/25 §1c): tombol impor tambahan di
   * header dan dialog yang menyertainya. Web memberi SOUNDCLOUD; desktop
   * memberi SOUNDCLOUD + YOUTUBE (docs/23). Halaman tidak bertanya di mana ia
   * berjalan — yang tahu fitur mana yang ada adalah yang memasangnya.
   */
  readonly extras?: StudioExtras;
  /**
   * Dok kepustakaan, disuntik app (`<LibraryDock/>` dari `@kelasmalam/library`).
   * Alasannya bukan pilihan: library mengimpor studio, jadi studio tidak boleh
   * mengimpor library. Tanpa dok, halaman tetap utuh — hanya tanpa strip di
   * dasar layar.
   */
  readonly dock?: ReactNode;
}

export interface StudioExtras {
  readonly importActions?: readonly ImportAction[];
  /** Dirender di dalam `BeatProvider`, di atas tata letak. */
  readonly dialogs?: ReactNode;
  /**
   * Dirender di toolbar kanan, tepat di kiri tombol SNAP. Desktop memasang
   * tombol SPLIT (pemisahan vokal, docs/26 §3a) di sini; pakai `ToolbarButton`
   * supaya ukurannya sama dengan SNAP.
   */
  readonly toolbarActions?: ReactNode;
}

/** Periode tick playhead. 60 ms = angka yang sama dengan interval di design. */
const TICK_MS = 60;

export function StudioPage({ createEngine, onClose, onOpenDj, onOpenRoblox, extras, dock }: StudioPageProps): JSX.Element {
  // Preview playback lewat Web Audio, sementara engine WASM belum di-build.
  usePreviewPlayback();
  // Sambungkan rail ke project + cache PCM. Cache-nya SAMA dengan yang dipakai
  // preview: kalau export punya cache sendiri, apa yang didengar dan apa yang
  // ditulis ke file bisa berasal dari audio yang berbeda.
  useEffect(() => {
    registerExportHost({
      state: () => studioStore.getState(),
      getBuffer: bufferLookup(),
    });
    return () => registerExportHost(null);
  }, []);
  // Studio TIDAK memulihkan project sendiri saat boot, dan tidak menyimpannya
  // otomatis — penyimpanan lokalnya sudah dibuang seluruhnya. Alasannya di
  // kepala `persist/persistence.ts`. Simpan dan muat akan datang lewat
  // kepustakaan yang eksplisit.
  // Command Studio (transport, undo/redo, clip, simpan, export) didaftarkan ke
  // registry shell selama halaman hidup. Keyboard, palette ⌘K, dan menu native
  // desktop semuanya masuk lewat id yang sama — tidak ada listener keyboard
  // milik Studio sendiri lagi (docs/15).
  useCommands(studioCommands());
  // Coba bangun engine sekali. Kegagalannya adalah informasi, bukan crash.
  useEffect(() => {
    if (createEngine === undefined) {
      studioActions.setEngineStatus(false, 'engine tidak disediakan (mode UI-only)');
      return;
    }
    let alive = true;
    void createEngine()
      .then((engine) => {
        if (!alive) return;
        studioActions.setEngineStatus(engine !== null, engine === null ? 'engine tidak tersedia' : null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        studioActions.setEngineStatus(false, err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [createEngine]);

  // Timer UI hanya menentukan SEBERAPA SERING playhead diperbarui; POSISINYA
  // datang dari jam audio.
  //
  // Bedanya bukan kosmetik. `setInterval(…, 60)` tidak pernah tepat 60 ms —
  // periodenya dihitung ulang setelah callback selesai, jadi tiap tick memakan
  // 60 ms + waktu render, dan tab yang tidak aktif dicekik sampai 1×/detik.
  // Menambahkan 60 ms per tick karena itu SELALU lebih lambat dari yang
  // benar-benar terdengar, galatnya searah dan menumpuk: lagu tiga menit habis
  // sementara garis playhead masih di tengah. `previewPositionSec()` adalah jam
  // yang SAMA dengan yang memutar sample-nya (dan yang sudah dipakai waveform
  // geser di `LaneHeaders`), jadi tick yang terlambat hanya membuat gambarnya
  // lebih jarang diperbarui — tidak melencengkan posisinya.
  //
  // Cadangan `tick(TICK_MS)` dipakai kalau tidak ada yang berbunyi (mode
  // UI-only, atau AudioContext belum bisa dibuat): di situ playhead satu-satunya
  // jam yang ada, jadi tidak ada apa pun yang bisa ia tinggalkan. Begitu engine
  // WASM hidup, yang menggantikan `previewPositionSec()` adalah snapshot
  // transport engine — bentuk pemanggilannya sudah sama.
  useEffect(() => {
    const id = setInterval(() => {
      const heard = previewPositionSec();
      if (heard === null) studioActions.tick(TICK_MS);
      else studioActions.tickTo(heard);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <BeatProvider>
      {extras?.dialogs}
      <StudioLayout
        header={
          <StudioHeader
            onClose={onClose}
            onOpenDj={onOpenDj}
            onOpenRoblox={onOpenRoblox}
            importActions={extras?.importActions}
          />
        }
        readouts={<ReadoutStrip />}
        menuBar={
          <MenuBar
            menus={STUDIO_MENUS}
            leading={<TransportButtons />}
            trailing={
              // Satu baris flex, bukan fragment: `MenuBar` menaruh `trailing`
              // di baris yang `flexWrap`, dan tombol yang berdiri sendiri-
              // sendiri bisa terpisah ke baris berbeda saat jendela sempit.
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {extras?.toolbarActions}
                <SnapToggle />
              </div>
            }
          />
        }
        /*
         * Kepustakaan duduk di DASAR layar, menempel, dan terlipat sampai
         * diminta. Alasannya di kepala `LibraryDock`: ia tempat mengambil
         * bahan, bukan permukaan kerja, dan panel yang memakan kolom permanen
         * di samping timeline membayar ruang tetap untuk pemakaian sesekali.
         * Komponennya milik app (lihat `dock` di props).
         */
        dock={dock}
        main={
          /*
           * Yang tersisa di kolom kerja HANYA timeline.
           *
           * Semua kontrol lain pindah ke toolbar menu di atas: kartu Clip Detail
           * dan seluruh rail kanan. Alasannya sama untuk keduanya — studio ini
           * tumbuh sampai punya kontrol untuk grid, loop, potong, stem, fade,
           * mixer, EQ, master, dan export, dan kalau semuanya harus terlihat
           * sekaligus, permukaan kerja yang sebenarnya tinggal sepertiga layar.
           * `ReorderableStack` tetap dipakai supaya timeline masih bisa
           * dibentangkan penuh layar (⛶).
           */
          <ReorderableStack items={[{ id: 'timeline', node: <TimelinePanel /> }]} />
        }
      />
    </BeatProvider>
  );
}
