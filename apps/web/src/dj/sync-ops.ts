/**
 * OPERASI BEAT SYNC — satu pintu untuk tombol SYNC, keyboard, dan tes.
 *
 * `sync.ts` menghitung; berkas ini yang MEMUTUSKAN: siapa leader-nya, membaca
 * grid dari `studioStore`, menerapkan rencananya, dan menolak dengan kalimat
 * kalau tidak bisa. Pola dan alasan yang sama persis dengan `grid/grid-ops.ts`.
 *
 * Ini juga yang memperbaiki cacat lama: dulu `Deck.tsx` dan `commands.ts`
 * masing-masing memanggil `djActions.toggleSync(id, baseBpm, otherBaseBpm)`,
 * dan keduanya mengirim BPM **BASE** master alih-alih BPM efektifnya. Kalau
 * tempo fader master tidak di nol, follower disamakan ke tempo yang TIDAK
 * SEDANG TERDENGAR — sync-nya "berhasil" lalu langsung lari. Sekarang tidak ada
 * pemanggil yang boleh mengirim angka BPM sama sekali; mereka hanya menyebut
 * deck-nya.
 */

import { resolveBeatGrid } from '../studio/analysis/beat-grid';
import { studioStore } from '../studio/store';
import { DECK_IDS, type DeckId } from './model';
import { djActions, djStore, type SyncResult } from './store';
import { phaseErrorBeats, planSync, type SyncDeck } from './sync';

/** Deck sebagaimana dilihat perhitungan sync, atau `null` kalau kosong. */
export function syncDeckOf(id: DeckId): SyncDeck | null {
  const deck = djStore.getState().decks[id];
  if (deck.assetId === null) return null;
  const asset = studioStore.getState().assets[deck.assetId];
  return {
    grid: asset === undefined ? null : resolveBeatGrid(asset),
    playhead: deck.playhead,
    sampleRate: deck.sampleRate > 0 ? deck.sampleRate : 48_000,
    tempo: deck.tempo,
  };
}

/**
 * Siapa yang jadi acuan untuk `id`, atau `null`.
 *
 * Kalau belum ada MASTER, deck lain dipilih otomatis dan **diangkat jadi
 * master** — bukan diam-diam dipakai sebagai acuan. Menolak dengan "belum ada
 * deck MASTER" seperti dulu adalah birokrasi: satu-satunya jawaban yang mungkin
 * di halaman dua deck memang deck yang satunya lagi.
 *
 * Mengangkatnya secara EKSPLISIT, bukan menyimpannya sebagai acuan diam-diam,
 * karena crown MASTER di layar harus menunjuk deck yang benar-benar jadi acuan.
 * Ini `LeaderSoft` milik Mixxx, disederhanakan untuk dua deck.
 */
export function pickLeader(id: DeckId): DeckId | null {
  const s = djStore.getState();
  if (s.masterDeck !== null && s.masterDeck !== id) return s.masterDeck;

  const other = DECK_IDS.find((x) => x !== id);
  if (other === undefined) return null;
  const deck = s.decks[other];
  if (deck.assetId === null) return null;
  if (s.masterDeck === null) djActions.setMasterDeck(other);
  return other;
}

/**
 * Selaraskan `id` ke leader-nya: tempo, rentang, dan FASE.
 *
 * Fase digeser sekali di sini, bukan dikoreksi terus-menerus — alasannya
 * panjang dan ada di kepala `sync.ts`. Follower yang sedang berbunyi karena itu
 * akan terdengar "tersendat" sesaat, dan itu memang yang dilakukan CDJ
 * sungguhan saat SYNC ditekan di tengah lagu.
 */
export function applySyncTo(id: DeckId): SyncResult {
  const leaderId = pickLeader(id);
  if (leaderId === null) return { ok: false, reason: 'tidak ada deck lain untuk diikuti' };

  const follower = syncDeckOf(id);
  const leader = syncDeckOf(leaderId);
  if (follower === null) return { ok: false, reason: `deck ${id} kosong` };
  if (leader === null) return { ok: false, reason: `deck ${leaderId} kosong` };

  const out = planSync(leader, follower);
  if (!out.ok) return { ok: false, reason: out.reason };

  djActions.applySyncPlan(id, out.plan);

  const notes: string[] = [];
  if (out.plan.octave !== 0) {
    // `octave < 0` berarti follower berjalan lebih LAMBAT dari leader — lihat
    // konvensi tandanya di `SyncPlan.octave`.
    const n = out.plan.octave;
    notes.push(n < 0 ? `tempo ÷${2 ** -n}` : `tempo ×${2 ** n}`);
  }
  if (out.plan.rangeWidened) notes.push(`rentang deck ${id} dinaikkan ke ±${out.plan.rangePct}%`);
  djActions.setNotice(notes.length === 0 ? null : `SYNC ${id} → ${leaderId}: ${notes.join(' · ')}`);
  return { ok: true };
}

/** SYNC nyala ↔ mati. */
export function toggleSyncFor(id: DeckId): SyncResult {
  if (djStore.getState().decks[id].sync === 'follower') {
    djActions.clearSync(id);
    return { ok: true };
  }
  return applySyncTo(id);
}

/**
 * Sejajarkan ulang FASE saja, tanpa menyentuh tempo.
 *
 * Dibutuhkan karena satu-satunya hal yang bisa merusak fase setelah SYNC adalah
 * LOMPATAN posisi. Yang berasal dari quantize tidak merusaknya — setelah kedua
 * grid sejajar, menempel ke grid sendiri berarti mendarat di ketukan leader
 * juga — jadi yang tersisa hanya lompatan tak-terkuantisasi dan seek leader.
 *
 * **Deck yang SEDANG BERBUNYI tidak pernah digeser.** Ini aturan yang tidak
 * bisa ditawar dan bukan sekadar kehati-hatian: follower yang berbunyi adalah
 * apa yang SEDANG DIDENGAR ORANG. Memindahkan posisinya karena user menyentuh
 * deck LAIN berarti lagu yang sedang mengudara melompat tanpa ada yang
 * menyentuhnya.
 *
 * Mixxx boleh melakukannya karena ia mengoreksi fase dengan menggeser RATE
 * beberapa persen — perubahan yang tidak terdengar sebagai lompatan. Kita
 * menggeser POSISI (lihat kepala `sync.ts` kenapa), dan lompatan posisi selalu
 * terdengar. Konsekuensinya: fase follower yang berbunyi jadi tanggung jawab
 * user lewat tombol SYNC, dan `PhaseMeter` yang memberi tahu kapan perlu.
 */
export function resyncPhase(id: DeckId): void {
  const deck = djStore.getState().decks[id];
  if (deck.sync !== 'follower' || deck.playing) return;
  applySyncTo(id);
}

/**
 * Sisa selisih fase follower terhadap leader, dalam ketukan `[−0.5, 0.5)`.
 * `null` kalau tidak ada yang bisa dibandingkan. Untuk phase meter.
 */
export function phaseErrorOf(id: DeckId): number | null {
  const s = djStore.getState();
  const leaderId = s.masterDeck;
  if (leaderId === null || leaderId === id) return null;
  const leader = syncDeckOf(leaderId);
  const follower = syncDeckOf(id);
  if (leader === null || follower === null) return null;
  return phaseErrorBeats(leader, follower);
}

/**
 * Fase ulang follower tiap kali LEADER melompat.
 *
 * Dipasang sebagai langganan store, BUKAN dipanggil dari dalam `seek()`, dan
 * itu bukan pilihan gaya: `sync-ops` meng-import store, jadi store yang
 * meng-import `sync-ops` akan jadi siklus. Satu langganan di tepi juga berarti
 * setiap jalan menuju lompatan — tombol, keyboard, hot cue, klik overview —
 * tertangkap tanpa satu pun dari mereka perlu tahu SYNC itu ada.
 *
 * Hanya `seekEpoch` LEADER yang diperhatikan. `syncFromClock` sengaja tidak
 * menaikkannya (lihat store), jadi posisi yang mengalir dari jam audio 16×/detik
 * tidak memicu apa pun — kalau iya, follower akan difase ulang terus-menerus
 * dan itu persis loop koreksi yang kepala `sync.ts` jelaskan kenapa dihindari.
 *
 * Lompatan FOLLOWER sendiri sengaja TIDAK memicu apa-apa: kalau user melompat
 * di deck yang sedang mengikuti, ia memang sedang mengambil keputusan sendiri.
 * Quantize yang menjaganya tetap di grid, dan setelah kedua grid sejajar,
 * menempel ke grid sendiri berarti mendarat di ketukan leader juga.
 */
export function startSyncFollow(): () => void {
  // Keadaan awal dibaca SEKARANG, bukan pada callback pertama. Callback pertama
  // dipicu oleh perubahan yang justru harus ditanggapi; merekam epoch di sana
  // berarti lompatan pertama setelah SYNC selalu terlewat — dan itu lompatan
  // yang paling mungkin terjadi.
  const s0 = djStore.getState();
  let lastLeader: DeckId | null = s0.masterDeck;
  let lastEpoch: number | null = lastLeader === null ? null : s0.decks[lastLeader].seekEpoch;

  return djStore.subscribe(() => {
    const s = djStore.getState();
    const leaderId = s.masterDeck;
    if (leaderId === null) {
      lastEpoch = null;
      lastLeader = null;
      return;
    }

    // Selama waveform leader DITARIK, tidak ada yang dikerjakan — dan `lastEpoch`
    // sengaja TIDAK diperbarui. Satu tarikan menghasilkan puluhan `seek`; kalau
    // tiap satu ditanggapi, deck sebelahnya ikut terseret dan lapisan audio
    // menjadwalkan ulang puluhan kali dalam satu gerakan tangan. Dengan
    // `lastEpoch` dibiarkan basi, tarikannya jadi SATU perubahan yang
    // ditanggapi sekali saat jari diangkat.
    if (s.decks[leaderId].scrubbing) return;

    const epoch = s.decks[leaderId].seekEpoch;
    const changed = leaderId === lastLeader && lastEpoch !== null && epoch !== lastEpoch;
    lastLeader = leaderId;
    lastEpoch = epoch;
    if (!changed) return;

    for (const id of DECK_IDS) {
      if (id !== leaderId && s.decks[id].sync === 'follower') resyncPhase(id);
    }
  });
}
