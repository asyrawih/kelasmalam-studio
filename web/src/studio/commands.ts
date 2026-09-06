/**
 * Command halaman Studio — daftar tunggal semua yang bisa dilakukan di `/studio`
 * lewat keyboard, palette `⌘K`, dan menu native desktop.
 *
 * ## Kenapa daftar ini ada, padahal tombolnya sudah ada di layar
 *
 * Alasannya sama dengan `dj/commands.ts` (docs/15): satu aksi punya lebih dari
 * satu pintu masuk, dan tiap pintu yang memetakan sendiri ke `studioActions.*`
 * adalah satu salinan daftar yang harus dijaga tetap sama. Di sini tiap aksi
 * punya SATU id stabil; menu Rust di `desktop/src-tauri/src/menu.rs` hanya
 * menyebut id itu, dan `app-shell/menu-ids.ts` menjaga id-nya benar terdaftar.
 *
 * ## Yang dipindahkan dari `shortcuts/useTransportShortcuts.ts`
 *
 * Seluruh pemetaan tombol yang dulu hidup di listener `window` milik Studio
 * sekarang ada di sini sebagai `defaultChord`, supaya keyboard hanya punya SATU
 * penerjemah (`app-shell/useKeyDispatch.ts`). Yang membuat pemindahan itu
 * dulu ditunda adalah Spasi: ditahan = alat tangan untuk pan, diketuk = play,
 * dan play menyala di KEYUP. Registry sekarang punya fase tahan
 * (`Command.hold`), dan `space-pan.ts` yang mengisi ketiga kaitnya — modul itu
 * tidak berubah, hanya pemanggilnya yang pindah.
 *
 * Dua perbedaan kecil yang disengaja, keduanya mengikuti aturan shell:
 *   - Tombol yang DITAHAN tidak lagi mengulang perintah (panah ←/→ dulu ikut
 *     auto-repeat). 5 detik × 30 kali/detik bukan cara menggeser playhead.
 *   - Spasi/Enter saat fokus ada di tombol MENEKAN tombol itu, bukan play.
 *     Sesudah mengklik PLAY dengan tetikus, Spasi tetap men-toggle sekali —
 *     lewat tombolnya.
 *
 * Semua binding disimpan sebagai POSISI tombol (`KeyX`, bukan `x`) — lihat
 * `app-shell/keys.ts` — dan semuanya bawaan: user bisa mengubahnya lewat
 * editor pintasan (`?`).
 */

import type { Command } from '../app-shell/command';
import { libraryActions } from '../library/store';
import { pressSpace, releaseSpace, resetSpace } from './shortcuts/space-pan';
import { studioActions, studioStore } from './store';
import { getTimelineCursor } from './timeline/timeline-cursor';

const s = () => studioStore.getState();

/** Pre-roll saat mulai play dari area timeline, dalam detik. */
const PRE_ROLL_SEC = 3;

/**
 * Play/pause seperti ketukan Spasi: saat MULAI play dan pointer sedang berada
 * di timeline, mulai tiga detik sebelum cursor supaya yang didengar adalah
 * bagian yang sedang dilihat. Pause tidak pernah memindahkan playhead.
 *
 * Cursor timeline dibersihkan begitu pointer meninggalkan area clip, jadi dari
 * palette, menu native, atau tombol PLAY perilakunya sama dengan tanpa cursor.
 */
function playPause(): void {
  const state = s();
  const cursor = getTimelineCursor();
  if (!state.playing && cursor !== null) {
    studioActions.setPlayhead(Math.max(0, cursor - state.sampleRate * PRE_ROLL_SEC));
  }
  studioActions.togglePlay();
}

/** Ada clip terpilih — primer maupun himpunan marquee. */
function hasSelection(): boolean {
  const state = s();
  return state.selectedClipId !== null || state.selectedClipIds.length > 0;
}

/** Semua clip di timeline, urut lane lalu posisi — urutan yang sama dengan marquee. */
function allClipIds(): string[] {
  return s().lanes.flatMap((l) => l.clips.map((c) => c.id));
}

/**
 * `studio.project.save` — buka dok kepustakaan dan fokuskan tombol simpan.
 *
 * Simpan yang sebenarnya (`saveProject` + versi `If-Match` + pembaruan daftar)
 * adalah callback di dalam `LibraryDock`, bukan aksi store — dan menyalin
 * urutannya ke sini berarti dua tempat yang bisa berbeda tentang apa artinya
 * "simpan". Jadi command ini mengantar user ke tombolnya: dok terbuka, tombol
 * SIMPAN PROJECT fokus, Enter menekan. Kalau belum ada project yang dibuka,
 * yang difokuskan kotak nama project baru — langkah pertama sebelum bisa
 * menyimpan. Di desktop dok menampilkan "belum tersedia" (docs/20 §1d), dan
 * itu jawaban yang jujur untuk ⌘S di sana.
 */
function openSave(): void {
  libraryActions.setCollapsed(false);
  // Isi dok baru ada di DOM pada render sesudah `collapsed` berubah.
  setTimeout(() => {
    const dock = document.querySelector('[data-testid="library-dock"]');
    if (dock === null) return;
    const save = [...dock.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'SIMPAN PROJECT',
    );
    const target = save ?? dock.querySelector<HTMLElement>('input[aria-label="nama project baru"]');
    target?.focus();
  }, 0);
}

/** Buka (bukan toggle) satu menu toolbar. Dari command, "buka" harus idempoten. */
function openMenu(id: 'export'): void {
  if (s().openMenu !== id) studioActions.toggleMenu(id);
}

export function studioCommands(): Command[] {
  const transport = 'Transport';
  const edit = 'Edit';
  const clip = 'Clip';
  const project = 'Project';

  return [
    // ── Transport ──
    {
      id: 'studio.transport.playPause',
      title: 'Putar / jeda',
      group: transport,
      defaultChord: 'Space',
      hold: { press: pressSpace, release: releaseSpace, cancel: resetSpace },
      run: playPause,
    },
    {
      id: 'studio.transport.stop',
      title: 'Berhenti',
      group: transport,
      // Berbeda dari putar/jeda karena IDEMPOTEN: dari menu, MIDI, atau macro
      // "berhenti" harus berarti berhenti, bukan "balikkan keadaan". Playhead
      // tetap di tempatnya — "ke awal" adalah perintah lain.
      defaultChord: null,
      enabled: () => s().playing,
      run: () => studioActions.setPlaying(false),
    },
    {
      id: 'studio.transport.toStart',
      title: 'Ke awal',
      group: transport,
      // Backspace yang ditampilkan — itu yang disebut tombol ⏮ di toolbar.
      // Home dan Enter tetap bekerja sebagai alias; Enter saat fokus ada di
      // tombol dibiarkan menekan tombolnya (aturan shell).
      defaultChord: 'Backspace',
      defaultAliases: ['Home', 'Enter', 'NumpadEnter'],
      run: () => studioActions.setPlayhead(0),
    },
    {
      id: 'studio.transport.toEnd',
      title: 'Ke akhir',
      group: transport,
      defaultChord: 'End',
      run: () => studioActions.setPlayhead(s().duration),
    },
    {
      id: 'studio.transport.nudgeBack',
      title: 'Mundur 5 detik',
      group: transport,
      defaultChord: 'ArrowLeft',
      run: () => studioActions.nudgePlayhead(-5),
    },
    {
      id: 'studio.transport.nudgeForward',
      title: 'Maju 5 detik',
      group: transport,
      defaultChord: 'ArrowRight',
      run: () => studioActions.nudgePlayhead(5),
    },
    {
      id: 'studio.transport.nudgeBackFine',
      title: 'Mundur 1 detik',
      group: transport,
      defaultChord: 'shift+ArrowLeft',
      run: () => studioActions.nudgePlayhead(-1),
    },
    {
      id: 'studio.transport.nudgeForwardFine',
      title: 'Maju 1 detik',
      group: transport,
      defaultChord: 'shift+ArrowRight',
      run: () => studioActions.nudgePlayhead(1),
    },
    {
      id: 'studio.loop.toggle',
      title: 'Ulangi dari awal saat habis',
      group: transport,
      defaultChord: null,
      run: () => studioActions.toggleLoop(),
    },

    // ── Edit ──
    {
      id: 'studio.undo',
      title: 'Undo',
      group: edit,
      defaultChord: 'mod+KeyZ',
      enabled: () => studioActions.canUndo(),
      run: () => {
        studioActions.undo();
      },
    },
    {
      id: 'studio.redo',
      title: 'Redo',
      group: edit,
      defaultChord: 'mod+shift+KeyZ',
      // ⌘Y adalah redo di Windows dan di sebagian editor; keduanya diraih orang.
      defaultAliases: ['mod+KeyY'],
      enabled: () => studioActions.canRedo(),
      run: () => {
        studioActions.redo();
      },
    },
    {
      id: 'studio.select.all',
      title: 'Pilih semua clip',
      group: edit,
      defaultChord: 'mod+KeyA',
      enabled: () => allClipIds().length > 0,
      run: () => {
        const ids = allClipIds();
        studioActions.setSelectedClips(ids, ids[0] ?? null);
      },
    },

    // ── Clip ──
    {
      id: 'studio.clip.delete',
      title: 'Hapus clip terpilih',
      group: clip,
      defaultChord: 'KeyX',
      defaultAliases: ['Delete'],
      enabled: hasSelection,
      run: () => studioActions.deleteSelectedClip(),
    },
    {
      id: 'studio.clip.split',
      title: 'Split di playhead',
      group: clip,
      defaultChord: 'KeyB',
      enabled: () => s().selectedClipId !== null,
      run: () => {
        // `splitClipAtPlayhead` sendiri yang menolak playhead di luar clip —
        // aturan "potongan nol-panjang tidak boleh dibuat" hidup di satu tempat.
        const { selectedClipId } = s();
        if (selectedClipId !== null) studioActions.splitClipAtPlayhead(selectedClipId);
      },
    },
    {
      id: 'studio.clip.copy',
      title: 'Copy clip',
      group: clip,
      defaultChord: 'KeyC',
      enabled: hasSelection,
      run: () => studioActions.copySelectedClip(),
    },
    {
      id: 'studio.clip.paste',
      title: 'Paste clip di playhead',
      group: clip,
      // Paste jatuh di PLAYHEAD, pada lane terpilih — bukan di posisi asal.
      // Itu yang membuat copy/paste berguna: pindahkan playhead, tekan V.
      defaultChord: 'KeyV',
      run: () => studioActions.pasteClipboard(),
    },

    // ── Project ──
    {
      id: 'studio.project.save',
      title: 'Simpan project ke kepustakaan',
      group: project,
      defaultChord: 'mod+KeyS',
      run: openSave,
    },
    {
      id: 'studio.export.open',
      title: 'Buka panel EXPORT',
      group: project,
      defaultChord: 'mod+shift+KeyE',
      run: () => openMenu('export'),
    },
  ];
}
