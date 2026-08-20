/**
 * Halaman `/dj` — Performance Mixer 2 deck.
 *
 * Tanggung jawabnya sengaja sempit: memasang jam UI, mendaftarkan akar retensi
 * asset, dan menyusun lima baris. Semua logika ada di `store.ts` (mutasi) dan
 * `model.ts` (matematika).
 *
 * ## Dua hal yang dipasang di sini dan alasannya
 *
 * 1. **Tick playhead.** Berjalan dari `setInterval`, bukan dari jam audio —
 *    karena belum ada jam audio. Begitu fase audio hidup, sumber posisinya
 *    diganti dan interval ini dicabut. Persis pola `App.tsx` sebelum engine ada.
 * 2. **Akar retensi asset.** `registerAssetRoot(djAssetIds)` — jawaban atas
 *    "lagu mana yang masih dipakai" ketika lagunya duduk di deck tanpa satu pun
 *    clip. Didaftarkan di lingkup modul (lihat `asset-roots.ts`), jadi ia
 *    bertahan walau user meninggalkan halaman ini.
 *
 * ## Yang SENGAJA tidak ada: pemulihan saat boot
 *
 * Halaman ini dulu memulihkan sesi DJ (cue, deck, mixer) dan memuat seluruh
 * kepustakaan dari IndexedDB saat mount. Penyimpanan lokal itu sudah dibuang
 * seluruhnya — lihat `studio/persist/persistence.ts` — jadi halaman ini mulai
 * dari keadaan kosong dan lagunya diimpor oleh user di sesi ini. Penggantinya
 * kepustakaan eksplisit lewat backend, dan cue ikut ke sana.
 */

import { useEffect, useMemo, useRef } from 'react';

import { useCommands } from '../app-shell';
import { registerAssetRoot } from '../studio/persist/asset-roots';
import { useStudio } from '../studio/store';
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
import { djAssetIds, useDj } from './store';
import { WaveRow } from './wave/WaveRow';

/**
 * Didaftarkan SEKALI di lingkup modul, bukan di dalam `useEffect`.
 *
 * Kalau akar hidup mengikuti komponen, ia mati begitu user meninggalkan `/dj` —
 * dan itu persis momen Studio menanyakan asset mana yang masih dipakai.
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
