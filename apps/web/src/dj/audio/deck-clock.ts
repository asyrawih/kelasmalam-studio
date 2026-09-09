/**
 * Jam per deck untuk `ScrollingWave`.
 *
 * Dipanggil DI DALAM loop rAF penggambar waveform, bukan lewat props — itu yang
 * membuat jendela bergeser 60 kali per detik tanpa satu render React pun. Lihat
 * catatan #1 di kepala `studio/timeline/ScrollingWave.tsx`: yang penting bukan
 * dari mana angkanya, melainkan bahwa ia berasal dari jam yang SAMA dengan yang
 * memutar sample-nya.
 *
 * Mengembalikan `null` saat tidak ada audio atau deck kosong; `ScrollingWave`
 * membacanya sebagai "tidak ada yang berbunyi" dan jatuh ke `playhead` store.
 */

import type { DeckId } from '../model';
import { djAudio } from './engine';

export function deckClockSec(id: DeckId): () => number | null {
  return () => {
    const audio = djAudio();
    if (audio === null) return null;
    const samples = audio.positionSamples(id);
    if (samples === null) return null;
    const sr = audio.graph.channels[id].player.sampleRate;
    return sr > 0 ? samples / sr : null;
  };
}
