/**
 * SATU-SATUNYA titik dispatch mutasi.
 *
 * Aturan yang ditegakkan file ini (docs/08 §Ringkasan arus state):
 *   "React components = presentational; semua mutasi lewat command ke
 *    engine/model, tidak ada logika edit di komponen."
 *
 * Kalau komponen memanggil engine langsung, dua hal rusak sekaligus: mutasi itu
 * tidak masuk undo stack, dan tidak ada lagi satu tempat untuk membaca "apa
 * saja yang bisa mengubah project".
 *
 * ── Jalur ganda (docs/08 §8a) ────────────────────────────────────────────────
 * Command ring hanya 1024 slot. Drag fader pada 120 Hz mengisi ring itu dalam
 * ~8 detik dan sisanya dibuang diam-diam. Karena itu:
 *
 *   *Live(...)   → `engine.setParam(slot, v)`. Dipanggil sebanyak pointermove
 *                  mau; publikasi ke audio thread terjadi sekali per rAF di
 *                  `useMeterFrame`. TIDAK undoable.
 *   *Commit(...) → satu command ke ring, dipanggil sekali di pointerup.
 *                  MASUK undo.
 *
 * ── Dua kelas mutasi ─────────────────────────────────────────────────────────
 * `engine-client.ts` menetapkan: command ring HANYA untuk transport, gain,
 * pan, mute, send, trigger. Edit STRUKTURAL (pindah/trim/fade/hapus clip,
 * tempo) tidak punya opcode — model project hidup di Rust dan perubahannya
 * dikirim sebagai snapshot lewat `loadProject()`.
 *
 * Konsekuensinya di sini, dan ini penting untuk dibaca sebelum menambah
 * command baru: fungsi clip di bawah memutasi MIRROR dan berhenti di situ.
 * Mereka tidak memanggil engine karena tidak ada yang bisa dipanggil. Yang
 * kurang adalah serializer snapshot (mirror JS → postcard bytes) yang hidup di
 * sisi Rust/WASM; begitu ada, satu pemanggilan `engine.loadProject(bytes)`
 * di akhir setiap edit struktural menutup lingkarannya. Mengarang opcode clip
 * di sini akan menghasilkan command yang diam-diam dibuang engine.
 */

import { useMemo } from 'react';
import { useEngineOrNull } from './engine-context';
import { MASTER_BUS, type UiEngine } from './engine-types';
import { dbToLin, faderToDb, linToDb } from './gain';
import type { ClipId, Clip, FxId, Track, TrackId } from './model';
import { timelineSample } from './model';
import { uiActions, uiStore } from './store';

/** Baca state terkini saat command dijalankan — bukan nilai yang tertangkap
 *  saat objek command dibuat (kalau tidak, command memakai data basi). */
const uiActionsProject = () => uiStore.getState().project;
const uiTransport = () => uiStore.getState().transport;

/** 8 slot param per track di BLOCK 2 SAB. Disepakati bersama Rust; kalau
 *  berubah di sana, ubah di sini juga (tidak ada cara mengeceknya otomatis). */
const PARAMS_PER_TRACK = 8;
const TRACK_PARAM_GAIN = 0;
const TRACK_PARAM_PAN = 1;
/** Slot param master dipesan di ujung atas blok. */
const MASTER_PARAM_GAIN = 1016;

const trackParam = (track: TrackId, offset: number): number => track * PARAMS_PER_TRACK + offset;

export interface EngineCommands {
  // ── Transport ─────────────────────────────────────────────
  play(): void;
  pause(): void;
  stop(): void;
  seek(sample: number): void;
  toggleRecordArm(): void;
  setLoopEnabled(on: boolean): void;
  setLoopRange(startSample: number, endSample: number): void;
  setTempo(bpm: number): void;
  setMetronome(on: boolean): void;

  // ── Track / mixer ─────────────────────────────────────────
  /** `travel` 0..1 dari posisi fader; taper dipakai di sini lalu dikirim dB. */
  setFaderLive(track: TrackId, travel: number): void;
  setFaderCommit(track: TrackId, travel: number): void;
  setPanLive(track: TrackId, pan: number): void;
  setPanCommit(track: TrackId, pan: number): void;
  setMute(track: TrackId, on: boolean): void;
  setSolo(track: TrackId, on: boolean): void;
  setMasterFaderLive(travel: number): void;
  setMasterFaderCommit(travel: number): void;

  // ── Clip ──────────────────────────────────────────────────
  moveClip(clip: ClipId, timelinePos: number): void;
  trimClip(clip: ClipId, edge: 'start' | 'end', timelinePos: number): void;
  setClipGainDb(clip: ClipId, db: number): void;
  setClipFade(clip: ClipId, side: 'in' | 'out', lengthSamples: number): void;
  removeClip(clip: ClipId): void;
  /** NORMALIZE di design: hitung dari peak pyramid, JANGAN modifikasi PCM. */
  normalizeClip(clip: ClipId, peakLinear: number): void;

  // ── FX ────────────────────────────────────────────────────
  setFxParamLive(slot: number, value: number): void;
  setFxBypass(track: TrackId, fx: FxId, bypassed: boolean): void;
}

function findClip(
  tracks: readonly Track[],
  clip: ClipId,
): { readonly trackId: TrackId; readonly clip: Clip } | null {
  for (const t of tracks) {
    const c = t.clips.find((x) => x.id === clip);
    if (c !== undefined) return { trackId: t.id, clip: c };
  }
  return null;
}

function patchClip(trackId: TrackId, clipId: ClipId, fn: (c: Clip) => Clip): void {
  uiActions.patchTrack(trackId, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)),
  }));
}

function build(engine: UiEngine | null): EngineCommands {
  /** Sebelum audio di-unlock engine masih null. UI tetap boleh diedit; mirror
   *  yang jadi kebenaran sementara dan dikirim lewat snapshot saat engine
   *  hidup. Jadi: bukan no-op diam-diam, tapi "mirror-only". */
  const withClip = (clip: ClipId, fn: (trackId: TrackId, c: Clip) => void): void => {
    const found = findClip(uiActionsProject().tracks, clip);
    if (found === null) return;
    fn(found.trackId, found.clip);
  };

  return {
    play: () => {
      engine?.play();
      uiActions.patchTransport({ playing: true });
    },
    pause: () => {
      // Engine tidak punya `pause` terpisah: STOP di ring berarti berhenti di
      // tempat; reset playhead adalah keputusan UI (lihat `stop`).
      engine?.stop();
      uiActions.patchTransport({ playing: false });
    },
    stop: () => {
      engine?.stop();
      engine?.seek(0);
      uiActions.patchTransport({ playing: false });
    },
    seek: (sample) => engine?.seek(Math.max(0, Math.round(sample))),
    toggleRecordArm: () => {
      // docs/08: `Cmd::RecordArm` fase 3 — di MVP hanya toggle visual.
      uiActions.patchTransport({ recordArmed: !uiTransport().recordArmed });
    },
    setLoopEnabled: (on) => {
      engine?.setLoopEnabled(on);
      uiActions.patchTransport({ loopEnabled: on });
    },
    setLoopRange: (startSample, endSample) => {
      const a = Math.max(0, Math.round(startSample));
      const b = Math.max(a, Math.round(endSample));
      engine?.setLoop(a, b);
      uiActions.patchProject((p) => ({
        ...p,
        loopStart: timelineSample(a),
        loopEnd: timelineSample(b),
      }));
    },
    setTempo: (bpm) => {
      // Tempo map bagian dari model struktural — tidak ada opcode SET_TEMPO
      // di ring; ia ikut snapshot berikutnya (lihat catatan kepala file).
      uiActions.patchTransport({ bpm });
      uiActions.patchProject((p) => ({ ...p, tempoMap: [{ atTick: 0, bpm }] }));
    },
    setMetronome: (on) => uiActions.patchTransport({ metronome: on }),

    setFaderLive: (track, travel) =>
      engine?.setParam(trackParam(track, TRACK_PARAM_GAIN), dbToLin(faderToDb(travel))),
    setFaderCommit: (track, travel) => {
      const db = faderToDb(travel);
      engine?.setTrackGain(track, db);
      uiActions.patchTrack(track, (t) => ({ ...t, gain: dbToLin(db) }));
    },
    setPanLive: (track, pan) => engine?.setParam(trackParam(track, TRACK_PARAM_PAN), pan),
    setPanCommit: (track, pan) => {
      engine?.setPan(track, pan);
      uiActions.patchTrack(track, (t) => ({ ...t, pan }));
    },
    setMute: (track, on) => {
      engine?.setMute(track, on);
      uiActions.patchTrack(track, (t) => ({ ...t, mute: on }));
    },
    setSolo: (track, on) => {
      // Solo bukan op engine: ia diterjemahkan jadi mute pada track lain.
      // Daftar solo dihitung dari mirror SETELAH perubahan ini diterapkan.
      const tracks = uiActionsProject().tracks;
      const soloed = tracks.filter((t) => (t.id === track ? on : t.solo)).map((t) => t.id);
      engine?.setSolo(soloed, tracks.map((t) => t.id));
      uiActions.patchTrack(track, (t) => ({ ...t, solo: on }));
    },
    setMasterFaderLive: (travel) => engine?.setParam(MASTER_PARAM_GAIN, dbToLin(faderToDb(travel))),
    setMasterFaderCommit: (travel) => {
      const db = faderToDb(travel);
      engine?.setBusGain(MASTER_BUS, db);
      uiActions.patchProject((p) => ({ ...p, masterGain: dbToLin(db) }));
    },

    // Posisi selalu dikirim SUDAH ter-snap. Engine tidak men-snap ulang —
    // satu tempat, satu kebenaran (docs/08 §Arrangement).
    moveClip: (clip, timelinePos) => {
      const pos = Math.max(0, Math.round(timelinePos));
      // (struktural: mirror-only sampai serializer snapshot ada)
      withClip(clip, (trackId) =>
        patchClip(trackId, clip, (c) => ({ ...c, timelinePos: timelineSample(pos) })),
      );
    },
    trimClip: (clip, edge, timelinePos) => {
      const pos = Math.max(0, Math.round(timelinePos));
      // (struktural: mirror-only sampai serializer snapshot ada)
      withClip(clip, (trackId, c) => {
        if (edge === 'start') {
          // Trim kiri menggeser posisi timeline DAN offset source dengan delta
          // yang sama — kalau tidak, audio "meluncur" di dalam clip (docs/06).
          const delta = pos - c.timelinePos;
          const scaled = Math.round(delta * c.speedRatio);
          patchClip(trackId, clip, (x) => ({
            ...x,
            timelinePos: timelineSample(pos),
            sourceStart: (x.sourceStart + scaled) as Clip['sourceStart'],
            sourceLen: Math.max(1, x.sourceLen - scaled),
          }));
        } else {
          const lenTimeline = Math.max(1, pos - c.timelinePos);
          patchClip(trackId, clip, (x) => ({
            ...x,
            sourceLen: Math.max(1, Math.round(lenTimeline * x.speedRatio)),
          }));
        }
      });
    },
    setClipGainDb: (clip, db) => {
      // (struktural: mirror-only sampai serializer snapshot ada)
      withClip(clip, (trackId) => patchClip(trackId, clip, (c) => ({ ...c, gain: dbToLin(db) })));
    },
    setClipFade: (clip, side, lengthSamples) => {
      const len = Math.max(0, Math.round(lengthSamples));
      // (struktural: mirror-only sampai serializer snapshot ada)
      withClip(clip, (trackId) =>
        patchClip(trackId, clip, (c) => ({
          ...c,
          ...(side === 'in'
            ? { fadeIn: { ...c.fadeIn, lengthSamples: len } }
            : { fadeOut: { ...c.fadeOut, lengthSamples: len } }),
        })),
      );
    },
    removeClip: (clip) => {
      // (struktural: mirror-only sampai serializer snapshot ada)
      withClip(clip, (trackId) =>
        uiActions.patchTrack(trackId, (t) => ({
          ...t,
          clips: t.clips.filter((c) => c.id !== clip),
        })),
      );
    },
    normalizeClip: (clip, peakLinear) => {
      // Gain yang membuat peak menyentuh -0.3 dBFS. PCM tidak disentuh.
      const target = dbToLin(-0.3);
      const db = linToDb(peakLinear > 0 ? target / peakLinear : 1);
      // (struktural: mirror-only sampai serializer snapshot ada)
      withClip(clip, (trackId) => patchClip(trackId, clip, (c) => ({ ...c, gain: dbToLin(db) })));
    },

    setFxParamLive: (slot, value) => engine?.setParam(slot, value),
    setFxBypass: (track, fx, bypassed) => {
      uiActions.patchTrack(track, (t) => ({
        ...t,
        insertChain: t.insertChain.map((f) => (f.id === fx ? { ...f, bypassed } : f)),
      }));
    },
  };
}

export function useEngineCommands(): EngineCommands {
  const engine = useEngineOrNull();
  return useMemo(() => build(engine), [engine]);
}
