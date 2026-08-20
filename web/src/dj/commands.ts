/**
 * Command halaman DJ — daftar tunggal semua yang bisa dilakukan di `/dj`.
 *
 * ## Kenapa daftar ini ada, padahal tombolnya sudah ada di layar
 *
 * Sebuah aksi punya lebih dari satu pintu masuk: tombol, keyboard, command
 * palette, dan nanti MIDI. Kalau tiap pintu memetakan sendiri ke `djActions.*`,
 * jumlah pemetaan tumbuh perkalian. Di sini tiap aksi punya SATU id stabil, dan
 * pintu mana pun cukup mengirim id itu.
 *
 * ## Tata letak tombolnya, dan kenapa begitu
 *
 * Tidak ada "standar" papan ketik DJ — Serato, Traktor, dan Mixxx semuanya
 * berbeda. Yang dipakai di sini adalah pembagian **tangan kiri = deck A, tangan
 * kanan = deck B**, dengan posisi yang bercermin:
 *
 * ```
 *   1 2 3 4                                   7 8 9 0     hot cue
 *   Q W E                                       I O P     play · loop · exit
 *   A S D F                                 J K L ;        cue · sync · bend
 *   Z X                                         , .        loop ÷2 ×2
 * ```
 *
 * Bercermin karena tangan menghafal LETAK, bukan huruf — dan karena dua deck
 * yang dikendalikan dengan pola yang sama hanya perlu dihafal sekali.
 *
 * Semuanya disimpan sebagai POSISI tombol (`KeyQ`, bukan `q`), jadi binding-nya
 * tidak bergeser saat layout keyboard diganti. Lihat `app-shell/keys.ts`.
 *
 * Semua binding di sini adalah BAWAAN. User bisa mengubahnya lewat editor
 * pintasan (`?`), dan pilihannya bertahan.
 */

import type { Command } from '../app-shell';
import { resolveBeatGrid } from '../studio/analysis/beat-grid';
import { studioStore } from '../studio/store';
import { removeAssetFromLibrary } from './browser/dj-remove';
import { BEAT_LOOP_PRESETS, DECK_IDS, HOT_CUE_SLOTS, type DeckId } from './model';
import { djActions, djStore } from './store';
import { toggleSyncFor } from './sync-ops';
import {
  autoGrid,
  fitGridHere,
  gridBlockedReason,
  gridHistoryState,
  nudgeGrid,
  octaveGrid,
  redoGridEdit,
  setDownbeatHere,
  tapGrid,
  toggleGridEditFor,
  toggleGridLock,
  undoGridEdit,
  widenGrid,
} from './grid/grid-ops';

const s = () => djStore.getState();

/** Grid lagu yang sedang dipegang deck, atau `null`. */
function gridOf(id: DeckId) {
  const assetId = s().decks[id].assetId;
  if (assetId === null) return null;
  const asset = studioStore.getState().assets[assetId];
  return asset === undefined ? null : resolveBeatGrid(asset);
}


const loaded = (id: DeckId) => (): boolean => s().decks[id].assetId !== null;

/** Tombol per deck, bercermin kiri/kanan. */
const KEYS: Readonly<Record<DeckId, Readonly<Record<string, string>>>> = {
  A: {
    play: 'KeyQ',
    cue: 'KeyA',
    sync: 'KeyS',
    loop: 'KeyW',
    exit: 'KeyE',
    bendDown: 'KeyD',
    bendUp: 'KeyF',
    halve: 'KeyZ',
    double: 'KeyX',
    hotcue: 'Digit',
  },
  B: {
    play: 'KeyP',
    cue: 'Semicolon',
    sync: 'KeyL',
    loop: 'KeyO',
    exit: 'KeyI',
    bendDown: 'KeyJ',
    bendUp: 'KeyK',
    halve: 'Comma',
    double: 'Period',
    hotcue: 'Digit',
  },
};

/** Digit untuk hot cue 1–4 tiap deck. */
const HOT_CUE_DIGITS: Readonly<Record<DeckId, readonly string[]>> = {
  A: ['Digit1', 'Digit2', 'Digit3', 'Digit4'],
  B: ['Digit7', 'Digit8', 'Digit9', 'Digit0'],
};

/** Besar pitch bend lewat keyboard — sama dengan tombol di layar. */
const BEND = 0.04;
/** Langkah crossfader per ketukan panah. */
const XFADE_STEP = 0.05;

function deckCommands(id: DeckId): Command[] {
  const k = KEYS[id];
  const group = `Deck ${id}`;
  const grid = () => gridOf(id);

  const out: Command[] = [
    {
      id: `dj.deck${id}.playPause`,
      title: 'Putar / jeda',
      group,
      defaultChord: k.play ?? null,
      enabled: loaded(id),
      run: () => djActions.togglePlay(id),
    },
    {
      id: `dj.deck${id}.cue`,
      title: 'CUE — lompat ke titik cue',
      group,
      defaultChord: k.cue ?? null,
      enabled: loaded(id),
      // Keyboard tidak punya "tahan lalu lepas" di registry ini, jadi yang
      // dijalankan adalah tekan-lalu-lepas: lompat ke cue dan berhenti. Cue
      // preview (tahan untuk mendengar) tetap ada di tombol layar, yang memang
      // tahu kapan jari diangkat.
      run: () => {
        djActions.cuePress(id);
        djActions.cueRelease(id);
      },
    },
    {
      id: `dj.deck${id}.sync`,
      title: 'SYNC nyala / mati',
      group,
      defaultChord: k.sync ?? null,
      enabled: loaded(id),
      run: () => {
        const r = toggleSyncFor(id);
        if (!r.ok) djActions.setNotice(r.reason ?? 'SYNC gagal');
      },
    },
    {
      id: `dj.deck${id}.loop4`,
      title: 'Beat loop 4 ketukan',
      group,
      defaultChord: k.loop ?? null,
      enabled: loaded(id),
      run: () => djActions.setBeatLoop(id, 4, grid()),
    },
    {
      id: `dj.deck${id}.loopExit`,
      title: 'Keluar loop / RELOOP',
      group,
      defaultChord: k.exit ?? null,
      enabled: loaded(id),
      run: () =>
        s().decks[id].loop.active ? djActions.exitLoop(id) : djActions.reloop(id),
    },
    {
      id: `dj.deck${id}.loopHalve`,
      title: 'Loop ÷2',
      group,
      defaultChord: k.halve ?? null,
      enabled: loaded(id),
      run: () => djActions.halveLoop(id),
    },
    {
      id: `dj.deck${id}.loopDouble`,
      title: 'Loop ×2',
      group,
      defaultChord: k.double ?? null,
      enabled: loaded(id),
      run: () => djActions.doubleLoop(id),
    },
    {
      id: `dj.deck${id}.bendDown`,
      title: 'Pitch bend mundur',
      group,
      defaultChord: k.bendDown ?? null,
      enabled: loaded(id),
      // Sekali ketuk = satu dorongan singkat. Tanpa "tahan" di keyboard, yang
      // masuk akal adalah dorongan berdurasi tetap, bukan bend yang menyala
      // selamanya sampai ditekan lagi.
      run: () => nudgeBend(id, 1 - BEND),
    },
    {
      id: `dj.deck${id}.bendUp`,
      title: 'Pitch bend maju',
      group,
      defaultChord: k.bendUp ?? null,
      enabled: loaded(id),
      run: () => nudgeBend(id, 1 + BEND),
    },
    {
      id: `dj.deck${id}.slip`,
      title: 'SLIP nyala / mati',
      group,
      defaultChord: null,
      enabled: loaded(id),
      run: () => djActions.toggleSlip(id),
    },
    {
      id: `dj.deck${id}.quantize`,
      title: 'Quantize nyala / mati',
      group,
      defaultChord: null,
      run: () => djActions.toggleQuantize(id),
    },
    {
      id: `dj.deck${id}.master`,
      title: 'Jadikan deck acuan tempo',
      group,
      defaultChord: null,
      enabled: loaded(id),
      run: () => djActions.setMasterDeck(s().masterDeck === id ? null : id),
    },
    {
      id: `dj.deck${id}.eject`,
      title: 'Keluarkan lagu dari deck',
      group,
      defaultChord: null,
      enabled: loaded(id),
      run: () => djActions.ejectDeck(id),
    },
  ];

  // Hot cue: empat pertama dapat tombol, sisanya lewat palette. Keyboard punya
  // lebih sedikit tombol daripada halaman ini punya aksi, dan memaksakan
  // delapan digit per deck akan memakan seluruh baris angka.
  HOT_CUE_SLOTS.forEach((slot, i) => {
    out.push({
      id: `dj.deck${id}.hotcue.${slot}`,
      title: `Hot cue ${slot}`,
      group,
      defaultChord: HOT_CUE_DIGITS[id][i] ?? null,
      enabled: loaded(id),
      // Keyboard memakai jalur ON/OFF; pad di layar tetap "lompat ke sana".
      run: () => djActions.toggleHotCue(id, slot, grid()),
    });
  });

  BEAT_LOOP_PRESETS.forEach((beats) => {
    out.push({
      id: `dj.deck${id}.beatloop.${beats}`,
      title: `Beat loop ${beats < 1 ? `1/${Math.round(1 / beats)}` : beats} ketukan`,
      group,
      defaultChord: null,
      enabled: loaded(id),
      run: () => djActions.setBeatLoop(id, beats, grid()),
    });
  });

  return out;
}

/**
 * Dorongan bend berdurasi tetap.
 *
 * Timer, bukan keyup: dispatcher hanya melihat `keydown`, dan menambahkan
 * `keyup` ke registry berarti tiap command harus memutuskan apakah ia punya
 * fase lepas — kerumitan yang hanya dibutuhkan dua command dari lima puluh.
 */
const bendTimers = new Map<DeckId, ReturnType<typeof setTimeout>>();
const BEND_MS = 220;

function nudgeBend(id: DeckId, ratio: number): void {
  djActions.setBend(id, ratio);
  const existing = bendTimers.get(id);
  if (existing !== undefined) clearTimeout(existing);
  bendTimers.set(
    id,
    setTimeout(() => {
      djActions.setBend(id, 1);
      bendTimers.delete(id);
    }, BEND_MS),
  );
}

function globalCommands(): Command[] {
  return [
    {
      id: 'dj.focus.toggle',
      title: 'Pindah fokus deck',
      group: 'Global',
      /*
       * BUKAN `Tab`.
       *
       * Tab adalah cara keyboard berpindah antar kontrol. Merampasnya membuat
       * seluruh halaman berhenti bisa dipakai tanpa tetikus — dan itu tidak
       * terlihat sama sekali oleh siapa pun yang memakai tetikus, jadi ia bisa
       * hidup lama sekali sebelum ada yang melaporkannya.
       *
       * Backquote duduk tepat di kiri angka 1, jadi tangan kiri menemukannya
       * tanpa melihat.
       */
      defaultChord: 'Backquote',
      run: () => djActions.toggleFocusedDeck(),
    },
    {
      id: 'dj.focused.playPause',
      title: 'Putar / jeda deck yang fokus',
      group: 'Global',
      defaultChord: 'Space',
      enabled: () => s().decks[s().focusedDeck].assetId !== null,
      run: () => djActions.togglePlay(s().focusedDeck),
    },
    {
      id: 'dj.crossfader.left',
      title: 'Crossfader ke kiri',
      group: 'Mixer',
      defaultChord: 'ArrowLeft',
      run: () => djActions.setCrossfader(s().mixer.crossfader - XFADE_STEP),
    },
    {
      id: 'dj.crossfader.right',
      title: 'Crossfader ke kanan',
      group: 'Mixer',
      defaultChord: 'ArrowRight',
      run: () => djActions.setCrossfader(s().mixer.crossfader + XFADE_STEP),
    },
    {
      id: 'dj.crossfader.center',
      title: 'Crossfader ke tengah',
      group: 'Mixer',
      defaultChord: null,
      run: () => djActions.setCrossfader(0.5),
    },
    {
      id: 'dj.fx.toggle',
      title: 'Beat FX nyala / mati',
      group: 'Mixer',
      defaultChord: 'KeyG',
      enabled: () => s().fx.kind !== '',
      run: () => djActions.toggleFx(),
    },
    ...(['hi', 'mid', 'low'] as const).flatMap((band) =>
      DECK_IDS.map((id) => ({
        id: `dj.ch${id}.kill.${band}`,
        title: `KILL ${band.toUpperCase()} channel ${id}`,
        group: 'Mixer',
        defaultChord: null,
        run: () => djActions.toggleEqKill(id, band),
      })),
    ),
  ];
}

function browserCommands(): Command[] {
  /** Urutan baris yang TERLIHAT, supaya ↑/↓ mengikuti apa yang dilihat user. */
  const rows = (): readonly number[] => {
    const assets = studioStore.getState().assets;
    return Object.values(assets).map((a) => a.id);
  };

  const step = (delta: 1 | -1): void => {
    const ids = rows();
    if (ids.length === 0) return;
    const current = s().browse.selectedAssetId;
    const i = current === null ? -1 : ids.indexOf(current);
    const next = i < 0 ? (delta === 1 ? 0 : ids.length - 1) : (i + delta + ids.length) % ids.length;
    djActions.selectBrowseAsset(ids[next] ?? null);
  };

  return [
    {
      id: 'dj.browse.next',
      title: 'Lagu berikutnya di Collection',
      group: 'Collection',
      defaultChord: 'ArrowDown',
      run: () => step(1),
    },
    {
      id: 'dj.browse.prev',
      title: 'Lagu sebelumnya di Collection',
      group: 'Collection',
      defaultChord: 'ArrowUp',
      run: () => step(-1),
    },
    {
      id: 'dj.browse.load',
      title: 'Muat lagu terpilih ke deck yang fokus',
      group: 'Collection',
      defaultChord: 'Enter',
      enabled: () => s().browse.selectedAssetId !== null,
      run: () => {
        const assetId = s().browse.selectedAssetId;
        if (assetId === null) return;
        const asset = studioStore.getState().assets[assetId];
        if (asset === undefined) return;
        djActions.loadDeck(s().focusedDeck, {
          assetId,
          frames: asset.frames,
          name: asset.name,
          sampleRate: asset.sampleRate,
        });
      },
    },
    {
      id: 'dj.browse.remove',
      title: 'Hapus lagu terpilih dari kepustakaan',
      group: 'Collection',
      /*
       * TANPA binding bawaan, dan itu disengaja.
       *
       * Penghapusan tidak bisa dibatalkan: lagunya lenyap dari sesi ini dan
       * harus diimpor ulang dari berkasnya. Memberinya satu tombol berarti satu
       * ketukan salah — Delete
       * yang meleset saat tangan mengira sedang di tempat lain — membuang lagu
       * untuk selamanya, tanpa langkah kedua. Lewat command palette, namanya
       * harus diketik dan dipilih; itu langkah kedua yang cukup.
       */
      defaultChord: null,
      enabled: () => s().browse.selectedAssetId !== null,
      run: () => {
        const assetId = s().browse.selectedAssetId;
        if (assetId === null) return;
        void removeAssetFromLibrary(assetId).then((r) => {
          djActions.setNotice(r.ok ? null : (r.reason ?? 'gagal menghapus'));
        });
      },
    },
    ...DECK_IDS.map((id) => ({
      id: `dj.browse.loadTo${id}`,
      title: `Muat lagu terpilih ke deck ${id}`,
      group: 'Collection',
      defaultChord: id === 'A' ? 'shift+ArrowLeft' : 'shift+ArrowRight',
      enabled: () => s().browse.selectedAssetId !== null,
      run: () => {
        const assetId = s().browse.selectedAssetId;
        if (assetId === null) return;
        const asset = studioStore.getState().assets[assetId];
        if (asset === undefined) return;
        djActions.loadDeck(id, {
          assetId,
          frames: asset.frames,
          name: asset.name,
          sampleRate: asset.sampleRate,
        });
      },
    })),
  ];
}

/**
 * Command GRID EDIT.
 *
 * Hampir semuanya TANPA binding bawaan, dan itu bukan kemalasan: papan ketik di
 * halaman ini sudah penuh oleh transport dua deck, dan registry ini tidak punya
 * konsep MODE — sebuah chord berlaku sama saja apakah panel grid sedang terbuka
 * atau tidak. Mengikat `KeyS` ke "geser grid" berarti merampasnya dari SYNC
 * selamanya, demi pekerjaan yang dilakukan sekali per lagu.
 *
 * Yang mendapat tombol hanyalah empat yang benar-benar berulang saat menyetel
 * satu lagu, dan semuanya memakai `shift` supaya tidak bertabrakan dengan
 * transport: SET DI SINI, PAS DI SINI, TAP, serta membuka panelnya sendiri.
 * Sisanya lewat command palette, tempat namanya bisa dibaca.
 */
function gridCommands(): Command[] {
  const group = 'Grid edit';
  /** Deck yang sedang disunting, atau deck yang sedang fokus kalau panel tutup. */
  const target = (): DeckId => s().gridEdit.deck ?? s().focusedDeck;
  const editable = (): boolean => gridBlockedReason(target()) === null;

  return [
    {
      id: 'dj.grid.toggle',
      title: 'GRID EDIT — buka / tutup',
      group,
      defaultChord: 'KeyG',
      enabled: () => s().decks[s().focusedDeck].assetId !== null,
      run: () => toggleGridEditFor(target()),
    },
    {
      id: 'dj.grid.setDownbeat',
      title: 'Jadikan posisi sekarang awal bar',
      group,
      defaultChord: 'shift+KeyG',
      enabled: editable,
      run: () => void setDownbeatHere(target()),
    },
    {
      id: 'dj.grid.fitHere',
      title: 'PAS DI SINI — kunci BPM dari dua titik',
      group,
      defaultChord: 'shift+KeyF',
      enabled: editable,
      run: () => void fitGridHere(target()),
    },
    {
      id: 'dj.grid.tap',
      title: 'TAP tempo',
      group,
      defaultChord: 'shift+KeyT',
      enabled: editable,
      run: () => void tapGrid(performance.now(), target()),
    },
    {
      id: 'dj.grid.nudgeLeft',
      title: 'Geser grid ke kiri',
      group,
      defaultChord: null,
      enabled: editable,
      run: () => void nudgeGrid(-1, target()),
    },
    {
      id: 'dj.grid.nudgeRight',
      title: 'Geser grid ke kanan',
      group,
      defaultChord: null,
      enabled: editable,
      run: () => void nudgeGrid(1, target()),
    },
    {
      id: 'dj.grid.narrow',
      title: 'Rapatkan jarak ketukan',
      group,
      defaultChord: null,
      enabled: editable,
      run: () => void widenGrid(-1, target()),
    },
    {
      id: 'dj.grid.widen',
      title: 'Renggangkan jarak ketukan',
      group,
      defaultChord: null,
      enabled: editable,
      run: () => void widenGrid(1, target()),
    },
    {
      id: 'dj.grid.double',
      title: 'Grid ×2 BPM',
      group,
      defaultChord: null,
      enabled: editable,
      run: () => void octaveGrid(1, target()),
    },
    {
      id: 'dj.grid.halve',
      title: 'Grid ÷2 BPM',
      group,
      defaultChord: null,
      enabled: editable,
      run: () => void octaveGrid(-1, target()),
    },
    {
      id: 'dj.grid.undo',
      title: 'Batalkan suntingan grid',
      group,
      defaultChord: null,
      enabled: () => gridHistoryState(s().decks[target()].assetId).canUndo,
      run: () => void undoGridEdit(target()),
    },
    {
      id: 'dj.grid.redo',
      title: 'Ulangi suntingan grid',
      group,
      defaultChord: null,
      enabled: () => gridHistoryState(s().decks[target()].assetId).canRedo,
      run: () => void redoGridEdit(target()),
    },
    {
      id: 'dj.grid.auto',
      title: 'AUTO — buang semua koreksi grid manual',
      group,
      /*
       * Tanpa binding, dengan alasan yang sama seperti `dj.browse.remove`:
       * AUTO membuang penyetelan yang bisa memakan sepuluh menit, dan
       * mengembalikannya butuh mengulang seluruh pekerjaan. Lewat palette,
       * namanya harus diketik dan dipilih.
       */
      defaultChord: null,
      enabled: editable,
      run: () => void autoGrid(target()),
    },
    {
      id: 'dj.grid.lock',
      title: 'Kunci / buka kunci analisis lagu ini',
      group,
      defaultChord: null,
      enabled: () => s().decks[target()].assetId !== null,
      run: () => void toggleGridLock(target()),
    },
  ];
}

/** Seluruh command halaman DJ. Dibangun sekali; `run` membaca store saat dipanggil. */
export function djCommands(): Command[] {
  return [
    ...deckCommands('A'),
    ...deckCommands('B'),
    ...globalCommands(),
    ...gridCommands(),
    ...browserCommands(),
  ];
}
