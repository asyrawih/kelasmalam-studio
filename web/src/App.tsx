/**
 * Audio Studio — halaman aplikasi.
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

import { useEffect } from 'react';
import { StudioRail } from './studio/rail';
import { ReadoutStrip, StudioHeader, StudioLayout } from './studio/shell';
import { ReorderableStack } from './studio/shell/ReorderableStack';
import { studioActions, studioStore, useStudio } from './studio/store';
import { registerExportHost } from './studio/rail/export-bridge';
import { bufferLookup } from './studio/preview/audio-preview';
import { BeatBar, BeatProvider, ClipDetailPanel, TimelinePanel } from './studio/timeline';
import { usePersistence } from './studio/persist/usePersistence';
import { usePreviewPlayback } from './studio/preview/usePreviewPlayback';
import { useTransportShortcuts } from './studio/shortcuts/useTransportShortcuts';

export interface AppProps {
  /**
   * Dipanggil sekali untuk mencoba membangun lapisan audio. Mengembalikan
   * objek apa pun kalau berhasil, atau null/melempar kalau lingkungan ini
   * belum bisa (mis. WASM belum di-build). UI tidak peduli bentuknya — ia
   * hanya butuh tahu berhasil atau tidak.
   */
  readonly createEngine?: () => Promise<unknown>;
  readonly onClose?: () => void;
  readonly railWidth?: number;
}

/** Periode tick playhead. 60 ms = angka yang sama dengan interval di design. */
const TICK_MS = 60;

export function App({ createEngine, onClose, railWidth }: AppProps): JSX.Element {
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
  // Pulihkan project tersimpan + nyalakan autosave.
  usePersistence(useStudio((s) => s.sampleRate));
  // Shortcut transport: Space, Backspace/Enter/Home, End, ←/→.
  useTransportShortcuts();
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

  // Playhead berjalan dari timer UI, BUKAN dari clock audio. Selama engine
  // belum ada ini satu-satunya cara timeline bisa dicoba; begitu engine ada,
  // sumber posisi harus diganti ke snapshot transport engine.
  useEffect(() => {
    const id = setInterval(() => studioActions.tick(TICK_MS), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <BeatProvider>
      <StudioLayout
        railWidth={railWidth}
        header={<StudioHeader onClose={onClose} />}
        readouts={<ReadoutStrip />}
        beatBar={<BeatBar />}
        main={
          <ReorderableStack
            overlayAside={<StudioRail />}
            items={[
              { id: 'timeline', node: <TimelinePanel /> },
              // Clip Detail SELALU ada, juga saat tidak ada yang terpilih.
              //
              // Dulu ia hanya dipasang saat ada seleksi, dengan alasan menghemat
              // ruang vertikal. Itu keliru begitu seleksi jadi sesuatu yang
              // sering berubah: panel yang muncul-hilang mendorong timeline naik
              // turun di bawah kursor, jadi klik berikutnya mendarat di tempat
              // yang berbeda dari yang dilihat mata. Tata letak yang bergerak
              // sendiri jauh lebih mahal daripada satu kartu berisi judul.
              //
              // Tanpa seleksi, panel ini menyusut jadi satu baris judul
              // ("PILIH CLIP DI TIMELINE") — tingginya tetap, dan itulah intinya.
              { id: 'clip-detail', node: <ClipDetailPanel /> },
            ]}
          />
        }
        rail={<StudioRail />}
      />
    </BeatProvider>
  );
}
