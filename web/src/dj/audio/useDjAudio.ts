/**
 * Menyambungkan store DJ ke lapisan audio, dua arah.
 *
 * ```
 *   store ──(apply)──► graf        dipicu perubahan store
 *   graf  ──(clock)──► playhead    dipicu rAF
 * ```
 *
 * Kedua arah tidak bisa berputar: yang mengalir balik HANYA posisi, dan posisi
 * ditulis lewat `syncFromClock` yang tidak menaikkan `seekEpoch`. Lapisan audio
 * menjadwalkan ulang source hanya saat `seekEpoch` berubah — jadi umpan jam
 * tidak pernah bisa memicu penjadwalan ulang.
 *
 * ## Kenapa audio dibangun dari gestur, dan kenapa listener-nya di akar
 *
 * `AudioContext` yang dibuat di luar handler gestur user lahir `suspended` di
 * Safari dan Chrome, tanpa gejala apa pun selain "tidak ada suara". Daripada
 * menyebar `ensureDjAudio()` ke tiap tombol — dan pasti melupakan salah satunya
 * — satu listener `pointerdown` di akar halaman menangkap interaksi PERTAMA apa
 * pun. Ia melepas dirinya sendiri setelah berhasil.
 */

import { useEffect, type RefObject } from 'react';

import { DECK_IDS } from '../model';
import { djActions, djStore } from '../store';
import { djAudio, djAudioError, ensureDjAudio } from './engine';

/** Sekitar 16 kiriman posisi per detik — sama dengan tick UI lama. */
const POSITION_INTERVAL_MS = 60;

export function useDjAudio(rootRef: RefObject<HTMLElement>): void {
  // — bangun dari gestur pertama —
  useEffect(() => {
    const root = rootRef.current ?? document.body;
    const onFirstGesture = (): void => {
      const audio = ensureDjAudio();
      djActions.setAudioStatus(audio !== null, djAudioError());
      if (audio !== null) {
        root.removeEventListener('pointerdown', onFirstGesture, true);
        // Terapkan sekali langsung, supaya lagu yang sudah dimuat sebelum
        // gestur ikut terpasang tanpa menunggu perubahan state berikutnya.
        audio.apply(djStore.getState(), audio.cue.isMonitoring);
      }
    };
    root.addEventListener('pointerdown', onFirstGesture, true);
    return () => root.removeEventListener('pointerdown', onFirstGesture, true);
  }, [rootRef]);

  // — store → graf —
  useEffect(() => {
    const apply = (): void => {
      const audio = djAudio();
      if (audio === null) return;
      audio.apply(djStore.getState(), audio.cue.isMonitoring);
    };
    apply();
    return djStore.subscribe(apply);
  }, []);

  // — jam → store —
  useEffect(() => {
    let raf = 0;
    let lastPush = 0;

    const frame = (t: number): void => {
      raf = requestAnimationFrame(frame);
      const audio = djAudio();
      if (audio === null) return;

      // Deteksi ujung materi berjalan tiap frame — menundanya sampai kiriman
      // posisi berikutnya berarti deck "berbunyi" sampai 60 ms setelah lagunya
      // habis, dan tombol PLAY tetap menyala di layar.
      for (const id of DECK_IDS) {
        if (djStore.getState().decks[id].playing && audio.reachedEnd(id)) {
          djActions.pause(id);
        }
      }

      if (t - lastPush < POSITION_INTERVAL_MS) return;
      lastPush = t;
      for (const id of DECK_IDS) {
        const pos = audio.positionSamples(id);
        if (pos !== null && djStore.getState().decks[id].playing) {
          djActions.syncFromClock(id, pos);
        }
      }
    };

    if (typeof requestAnimationFrame !== 'function') return undefined;
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
}
