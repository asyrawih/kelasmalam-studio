/**
 * Menyambungkan state transport ke preview playback (Web Audio).
 *
 * Sengaja HANYA bereaksi pada transisi yang berarti — play/pause, ganti speed,
 * dan perubahan mute/solo/gain — BUKAN pada `playhead`. Playhead di-tick tiap
 * 60 ms oleh UI; kalau hook ini ikut bereaksi, semua voice akan dijadwalkan
 * ulang 16×/detik dan yang terdengar cuma klik.
 *
 * DUA CARA menjadwalkan ulang, dan memilih yang salah terdengar jelas:
 *   - `play()`   dari `state.playhead`. Untuk PLAY dan untuk LOMPATAN — di
 *                situ posisi baru memang yang diminta user.
 *   - `reschedule()` dari posisi yang benar-benar terdengar. Untuk susunan yang
 *                berubah saat berbunyi (tambah lane, geser clip, paste). Memakai
 *                `play()` di sini membuat lagu melompat mundur sampai 60 ms tiap
 *                kali — itulah "kok jadi stop dulu baru play" yang dilaporkan.
 *
 * Sementara sampai engine WASM hidup. Lihat catatan di audio-preview.ts.
 */

import { useEffect, useRef } from 'react';

import { chainShape, fxPreviewStatus } from './fx-node';
import { isStemBypass } from '../model';
import { activeLoopLen } from '../timeline/clip-loop';
import { studioStore } from '../store';
import {
  play,
  reschedule,
  scrubTo,
  startAudition,
  stop,
  stopAudition,
  stopScrub,
  updateLaneParams,
} from './audio-preview';

/** Sidik jari hal-hal yang mengharuskan penjadwalan ulang saat sedang play.
 *  Diekspor untuk tes — lihat `mix-fingerprint.test.ts`. */
export function mixFingerprint(): string {
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
    // Lane yang tidak menyumbang bunyi DIBUANG sebelum dipetakan — bukan
    // dipetakan jadi string kosong, karena entri kosong pun mengubah hasil
    // `join` dan itu sudah cukup untuk memicu penjadwalan ulang. Lane baru
    // selalu lahir tanpa clip, jadi tanpa saringan ini "TAMBAH LANE" memotong
    // lagu yang sedang berbunyi demi susunan yang sama persis.
    //
    // SOLO tetap ikut walau lane-nya kosong: lane kosong yang di-solo
    // membungkam semua lane lain, dan itu jelas terdengar.
    // BENTUK chain ikut, NILAI parameter tidak — aturan yang sama persis
    // dengan stem di bawah. Menambah atau mem-bypass efek mengubah susunan node
    // dan memang harus menjadwalkan ulang; menggeser knob tidak, dan
    // memasukkannya ke sini akan me-restart audio tiap satu piksel gerakan.
    chainShape(s.masterChain),
    // Runtime FX dimuat asinkron. Sampai siap, `createFxNode` mengembalikan
    // null dan chain tidak terdengar; menyertakan kesiapannya di sini membuat
    // penjadwalan ulang terjadi sekali begitu ia hidup, alih-alih menunggu
    // user kebetulan mengubah sesuatu.
    fxPreviewStatus().ready ? 'fx1' : 'fx0',
    ...s.lanes
      .filter((l) => l.clips.length > 0 || l.solo)
      .map(
        (l) =>
          `${l.id}:${l.mute ? 1 : 0}${l.solo ? 1 : 0}x${l.speedRatio}:` +
          `${chainShape(l.chain)}:` +
          l.clips
            // Satu BIT stem, bukan nilainya: yang mengharuskan penjadwalan ulang
            // adalah ada/tidaknya rantai stem, sedangkan gain & frekuensinya
            // diubah live lewat updateLaneParams. Memasukkan nilainya ke sini
            // akan me-restart audio tiap slider bergerak satu piksel.
            .map(
              (c) =>
                `${c.id}@${c.start}+${c.len}#${c.assetId}:${c.gainDb}` +
                `${isStemBypass(c.stem) ? '' : 'S'}` +
                // Loop clip mengubah SUSUNAN voice (source jadi melingkar,
                // titik masuknya modulo), jadi ia harus menjadwalkan ulang —
                // beda dengan gain/EQ yang bisa diubah live.
                `${activeLoopLen(c) === null ? '' : `L${c.loopLen ?? 0}@${c.sourceStart}`}`,
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
  const lastSeek = useRef(studioStore.getState().seekEpoch);
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

      // Selama clip di-drag, audio jalan terus dengan susunan LAMA. Menjadwalkan
      // ulang tiap pointermove akan memotong-motong suara jadi klik. Begitu
      // dilepas, `draggingClip` turun, sidik jari sudah berubah, dan blok di
      // bawah langsung menjadwalkan ulang dari posisi baru.
      if (state.draggingClip) {
        wasPlaying.current = state.playing;
        return;
      }

      // ── SCRUB ──
      //
      // Transport TIDAK dihentikan (lihat `TimelinePanel.onScrubDown`), tapi
      // mix-nya memang harus berhenti: mix dijadwalkan di muka dan berjalan
      // maju sendiri, sedangkan tangan bisa diam atau mundur. Yang mengambil
      // alih adalah pemutar butir di `scrubTo` — itu yang berbunyi seperti
      // forward/rewind. Begitu dilepas, `endScrub` menaikkan `seekEpoch`, dan
      // cabang di bawah menyalakan mix lagi dari posisi baru.
      if (state.scrubbing) {
        if (wasScrubbing.current === false) stop();
        wasScrubbing.current = true;
        // Senyap saat transport berhenti: menggeser playhead untuk menaruh
        // posisi bukan permintaan untuk mendengar apa pun.
        if (state.playing) scrubTo(state);
        wasPlaying.current = state.playing;
        lastMix.current = mix;
        lastSeek.current = state.seekEpoch;
        return;
      }
      if (wasScrubbing.current) {
        stopScrub();
        wasScrubbing.current = false;
      }

      if (state.playing) {
        const seeked = state.seekEpoch !== lastSeek.current;
        if (!wasPlaying.current || seeked) {
          // PLAY, atau user melompat: posisi yang diminta ada di `playhead`.
          play(state);
        } else if (mix !== lastMix.current) {
          // Susunannya yang berubah, bukan posisinya — lanjutkan di titik yang
          // sedang terdengar, jangan mundur ke playhead yang tertinggal tick.
          reschedule(state);
        }
        lastMix.current = mix;
      } else if (wasPlaying.current) {
        stop();
      }
      lastSeek.current = state.seekEpoch;
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
