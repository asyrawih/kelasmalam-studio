/**
 * Halaman `/dj` — Performance Mixer 2 deck.
 *
 * Tanggung jawabnya sengaja sempit: memasang jam UI, memuat kepustakaan,
 * mendaftarkan akar retensi asset, dan menyusun lima baris. Semua logika ada di
 * `store.ts` (mutasi) dan `model.ts` (matematika).
 *
 * ## Tiga hal yang dipasang di sini dan alasannya
 *
 * 1. **Tick playhead.** Berjalan dari `setInterval`, bukan dari jam audio —
 *    karena belum ada jam audio. Begitu fase audio hidup, sumber posisinya
 *    diganti dan interval ini dicabut. Persis pola `App.tsx` sebelum engine ada.
 * 2. **Muat kepustakaan.** Lewat `loadLibraryIntoStore`, BUKAN `restoreProject`:
 *    halaman ini tidak menampilkan timeline, dan memanggil restore dari sini
 *    akan menimpa lane user dengan apa pun yang kebetulan tersimpan.
 * 3. **Akar retensi asset.** `registerAssetRoot(djAssetIds)` — tanpa ini,
 *    autosave Studio berikutnya menghapus byte lagu yang sedang duduk di deck.
 *    Didaftarkan di lingkup modul (lihat `asset-roots.ts`), jadi ia bertahan
 *    walau user meninggalkan halaman ini.
 */

import { useEffect, useMemo, useRef } from 'react';

import { useCommands } from '../app-shell';
import { registerAssetRoot } from '../studio/persist/asset-roots';
import { loadLibraryIntoStore } from '../studio/persist/decode-asset';
import { studioStore, useStudio } from '../studio/store';
import { pendingDeckLoads, restoreDjSession, startDjAutosave } from './persist/dj-session';
import { useDjAudio } from './audio/useDjAudio';
import { CollectionBrowser } from './browser/CollectionBrowser';
import { Deck } from './deck/Deck';
import { deckView } from './deck-view';
import { BeatFxBar } from './fx/BeatFxBar';
import { DjHeader } from './header/DjHeader';
import { DjLayout } from './layout/DjLayout';
import { useViewport } from './layout/useViewportBand';
import { MixerSection } from './mixer/MixerSection';
import { SIDE_OF } from './model';
import { djCommands } from './commands';
import { startSyncFollow } from './sync-ops';
import { djActions, djAssetIds, useDj } from './store';
import { WaveRow } from './wave/WaveRow';

/**
 * Didaftarkan SEKALI di lingkup modul, bukan di dalam `useEffect`.
 *
 * Kalau akar hidup mengikuti komponen, ia mati begitu user meninggalkan `/dj` —
 * dan itu persis momen autosave Studio berjalan dan memangkas asset.
 */
registerAssetRoot(djAssetIds);

export interface DjPageProps {
  readonly onClose?: () => void;
}

export function DjPage({ onClose }: DjPageProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewport = useViewport();
  const compact = viewport.band === 'compact';

  const deckA = useDj((s) => s.decks.A);
  const deckB = useDj((s) => s.decks.B);
  const assets = useStudio((s) => s.assets);

  const views = useMemo(
    () => ({ A: deckView(deckA, assets[deckA.assetId ?? -1]), B: deckView(deckB, assets[deckB.assetId ?? -1]) }),
    [deckA, deckB, assets],
  );

  /**
   * Boot: pulihkan sesi → muat kepustakaan → pasang lagi lagu ke deck.
   *
   * URUTANNYA MENGIKAT. Sesi dipulihkan lebih dulu supaya cue dan posisi mixer
   * sudah ada saat lagunya mendarat; kepustakaan menyusul karena decode butuh
   * waktu; dan deck baru diisi PALING AKHIR, karena `loadDeck` menyalin
   * `frames` dan `sampleRate` dari asset — memanggilnya sebelum asetnya ada
   * akan menyimpan nol, dan waveform-nya jadi kosong sampai lagu dimuat ulang
   * dengan tangan.
   *
   * Autosave dinyalakan setelah semuanya selesai. Kalau lebih dulu, state awal
   * yang masih kosong akan menimpa sesi tersimpan sebelum sempat dibaca —
   * jebakan yang sama sudah dicatat di `persistence.ts`.
   */
  useEffect(() => {
    let alive = true;
    let stopAutosave: (() => void) | undefined;

    void (async () => {
      const assets = () => studioStore.getState().assets;
      await restoreDjSession((id) => assets()[id] !== undefined);
      const wanted = await pendingDeckLoads();
      await loadLibraryIntoStore(studioStore.getState().sampleRate);
      if (!alive) return;

      for (const id of ['A', 'B'] as const) {
        const assetId = wanted[id];
        if (assetId === null) continue;
        const asset = assets()[assetId];
        if (asset === undefined) continue;
        djActions.loadDeck(id, {
          assetId,
          frames: asset.frames,
          name: asset.name,
          sampleRate: asset.sampleRate,
        });
      }
      stopAutosave = startDjAutosave();
    })();

    return () => {
      alive = false;
      stopAutosave?.();
    };
  }, []);

  // Posisi playhead datang dari JAM AUDIO, bukan dari `setInterval`. Selama
  // audio belum dibangun (sebelum gestur pertama), tidak ada yang bergerak —
  // dan itu benar: tidak ada yang berbunyi.
  useDjAudio(rootRef);

  // Follower difase ulang tiap kali LEADER melompat. Satu langganan di tepi,
  // bukan panggilan dari dalam `seek()` — lihat `startSyncFollow`.
  useEffect(() => startSyncFollow(), []);

  /*
   * Command halaman ini didaftarkan ke shell selama halaman hidup — bukan ke
   * listener `window` sendiri. Itu yang membuat command palette, editor
   * pintasan, dan (nanti) MIDI melihat daftar yang SAMA, dan yang membuat
   * "tombol ini milik siapa" punya satu jawaban.
   *
   * Daftarnya dibangun ulang tiap render, tapi pendaftarannya sekali: `run`
   * membaca store saat dipanggil, jadi tidak ada closure yang bisa basi.
   */
  useCommands(djCommands());

  return (
    <DjLayout
      rootRef={rootRef}
      band={viewport.band}
      header={
        <DjHeader onClose={onClose} tooNarrow={viewport.tooNarrow} tooShort={viewport.tooShort} />
      }
      waves={<WaveRow views={views} />}
      main={
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(300px,1fr) minmax(300px,360px) minmax(300px,1fr)',
            height: '100%',
            minHeight: 0,
          }}
        >
          <Deck id="A" side={SIDE_OF.A} compact={compact} />
          <MixerSection compact={compact} />
          <Deck id="B" side={SIDE_OF.B} compact={compact} />
        </div>
      }
      fx={<BeatFxBar />}
      browser={<CollectionBrowser />}
    />
  );
}
