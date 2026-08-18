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

import { isStemBypass } from '../model';
import { studioStore } from '../store';
import { play, startAudition, stop, stopAudition, updateLaneParams } from './audio-preview';

/** Sidik jari hal-hal yang mengharuskan penjadwalan ulang saat sedang play. */
function mixFingerprint(): string {
  const s = studioStore.getState();
  return [
    s.speed,
    // Clip yang diaudisi dilewati di mix utama, jadi menyalakan/mematikan
    // audisi memang mengubah susunan graf. Hanya ID-nya yang masuk: memindahkan
    // REGION tidak mengubah apa pun di mix utama.
    s.clipLoop?.clipId ?? '',
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
        l.clips
          // Satu BIT stem, bukan nilainya: yang mengharuskan penjadwalan ulang
          // adalah ada/tidaknya rantai stem, sedangkan gain & frekuensinya
          // diubah live lewat updateLaneParams. Memasukkan nilainya ke sini
          // akan me-restart audio tiap slider bergerak satu piksel.
          .map(
            (c) =>
              `${c.id}@${c.start}+${c.len}#${c.assetId}:${c.gainDb}${isStemBypass(c.stem) ? '' : 'S'}`,
          )
          .join(','),
    ),
  ].join('|');
}

/**
 * Sidik jari PEMUTAR AUDISI — terpisah dari `mixFingerprint`.
 *
 * Dua pemutar dengan dua siklus hidup: memindahkan region loop tidak boleh
 * menjadwalkan ulang seluruh project, dan menekan PLAY tidak boleh memotong
 * loop yang sedang berbunyi. Satu sidik jari untuk keduanya menghapus justru
 * pemisahan yang membuat ini bekerja.
 *
 * `speed` ikut karena kecepatan transport mengalikan kecepatan audisi
 * (`effectiveSpeed`), dan itu dipasang saat voice dibuat.
 */
function auditionFingerprint(): string {
  const s = studioStore.getState();
  const cl = s.clipLoop;
  if (cl === null) return '';
  const hit = s.lanes
    .map((l) => ({ lane: l, clip: l.clips.find((c) => c.id === cl.clipId) }))
    .find((x) => x.clip !== undefined);
  if (hit?.clip === undefined) return '';
  return [
    cl.clipId,
    cl.sourceStart,
    cl.sourceLen,
    hit.clip.assetId,
    hit.lane.speedRatio,
    s.speed,
  ].join(':');
}

export function usePreviewPlayback(): void {
  const wasPlaying = useRef(false);
  const wasScrubbing = useRef(false);
  const lastMix = useRef('');
  const lastAudition = useRef('');

  useEffect(() => {
    const sync = (): void => {
      const state = studioStore.getState();
      const mix = mixFingerprint();

      // Parameter kontinu (gain lane + EQ) diterapkan LANGSUNG ke node yang
      // sedang berbunyi. Sengaja di luar semua cabang di bawah: menggeser
      // slider EQ tidak boleh menunggu stop/play, dan juga tidak boleh
      // memicu penjadwalan ulang.
      updateLaneParams(state);

      // ── Pemutar audisi, siklus hidupnya SENDIRI ──
      //
      // Sengaja di atas semua cabang scrub/play di bawah: loop harus tetap
      // berbunyi saat transport berhenti, dan tidak boleh ikut mati hanya
      // karena user menekan STOP di timeline.
      const auditionFp = auditionFingerprint();
      if (auditionFp === '') {
        if (lastAudition.current !== '') {
          stopAudition();
          lastAudition.current = '';
        }
      } else if (auditionFp !== lastAudition.current) {
        startAudition(state);
        lastAudition.current = auditionFp;
      }

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
      stopAudition();
    };
  }, []);
}
