/**
 * Menyambungkan state transport ke preview playback (Web Audio).
 *
 * Sengaja HANYA bereaksi pada transisi yang berarti — play/pause, ganti speed,
 * dan perubahan mute/solo/gain — BUKAN pada `playhead`. Playhead di-tick tiap
 * 60 ms oleh UI; kalau hook ini ikut bereaksi, semua voice akan dijadwalkan
 * ulang 16×/detik dan yang terdengar cuma klik.
 *
 * Sementara sampai engine WASM hidup. Lihat catatan di audio-preview.ts.
 */

import { useEffect, useRef } from 'react';

import { studioStore } from '../store';
import { play, stop, updateLaneParams } from './audio-preview';

/** Sidik jari hal-hal yang mengharuskan penjadwalan ulang saat sedang play. */
function mixFingerprint(): string {
  const s = studioStore.getState();
  return [
    s.speed,
    // seekEpoch naik hanya saat user MELOMPAT (klik/scrub/skip), tidak saat
    // playhead maju sendiri — jadi ini tidak memicu penjadwalan ulang 16×/detik.
    s.seekEpoch,
    // Susunan clip ikut masuk sidik jari: pindah lane, geser posisi, hapus,
    // dan paste semuanya harus terdengar tanpa perlu stop/play manual.
    //
    // gain lane & EQ TIDAK di sini — keduanya parameter kontinu yang diubah
    // live lewat updateLaneParams(). Memasukkannya akan me-restart audio tiap
    // kali slider bergerak satu piksel.
    ...s.lanes.map(
      (l) =>
        `${l.id}:${l.mute ? 1 : 0}${l.solo ? 1 : 0}x${l.speedRatio}:` +
        l.clips.map((c) => `${c.id}@${c.start}+${c.len}#${c.assetId}:${c.gainDb}`).join(','),
    ),
  ].join('|');
}

export function usePreviewPlayback(): void {
  const wasPlaying = useRef(false);
  const wasScrubbing = useRef(false);
  const lastMix = useRef('');

  useEffect(() => {
    const sync = (): void => {
      const state = studioStore.getState();
      const mix = mixFingerprint();

      // Parameter kontinu (gain lane + EQ) diterapkan LANGSUNG ke node yang
      // sedang berbunyi. Sengaja di luar semua cabang di bawah: menggeser
      // slider EQ tidak boleh menunggu stop/play, dan juga tidak boleh
      // memicu penjadwalan ulang.
      updateLaneParams(state);

      // Selama playhead di-drag, audio dibisukan.
      //
      // Alternatifnya menjadwalkan ulang tiap pointermove — itu berarti semua
      // voice di-start/stop puluhan kali per detik dan yang terdengar hanya
      // deretan klik, bukan audio. Scrub-audio ala tape (memutar potongan
      // pendek mengikuti kursor) butuh penjadwal sendiri; itu pekerjaan engine,
      // bukan jalur preview sementara ini.
      // Selama clip di-drag, audio jalan terus dengan susunan LAMA. Menjadwalkan
      // ulang tiap pointermove akan memotong-motong suara jadi klik. Begitu
      // dilepas, `draggingClip` turun, sidik jari sudah berubah, dan blok di
      // bawah langsung menjadwalkan ulang dari posisi baru.
      if (state.draggingClip) {
        wasPlaying.current = state.playing;
        return;
      }

      if (state.scrubbing) {
        if (wasScrubbing.current === false) stop();
        wasScrubbing.current = true;
        wasPlaying.current = state.playing;
        lastMix.current = mix;
        return;
      }
      wasScrubbing.current = false;

      if (state.playing) {
        // Mulai, atau jadwalkan ulang kalau mix/posisi berubah saat berbunyi.
        if (!wasPlaying.current || mix !== lastMix.current) {
          play(state);
          lastMix.current = mix;
        }
      } else if (wasPlaying.current) {
        stop();
      }
      wasPlaying.current = state.playing;
    };

    sync();
    const unsub = studioStore.subscribe(sync);
    return () => {
      unsub();
      stop();
    };
  }, []);
}
