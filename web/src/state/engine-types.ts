/**
 * Jembatan tipe antara lapisan UI dan lapisan audio.
 *
 * Versi pertama file ini ditulis saat `web/src/audio/engine-client.ts` belum
 * ada, jadi ia berisi kontrak ASUMSI. Sekarang file itu ada, dan aturannya
 * berlaku: **engine-client yang benar**. Perbedaan yang ditemukan saat
 * rekonsiliasi, dan bagaimana diselesaikan:
 *
 *   | asumsi lama                     | kenyataan engine-client        | resolusi |
 *   |---------------------------------|--------------------------------|----------|
 *   | `playheadSamples: bigint`        | `playhead: number`             | ikut number (u64 dirakit dari dua u32) |
 *   | `readMeters(out)`                | `readMetersInto(out): boolean` | ikut, hasil false = frame di-skip |
 *   | `ackMeters()`                    | tidak ada                      | dihapus; reset peak-hold dilakukan audio thread saat menulis (docs/07) |
 *   | gain linear di command           | `setTrackGain(track, db)`       | UI mengirim dB; konversi taper tetap di Rust |
 *   | opcode CLIP_MOVE/TRIM/FADE       | tidak ada — edit struktural lewat snapshot | mirror dimutasi, publikasi menunggu serializer snapshot |
 *   | `setSolo(track, on)`             | `setSolo(soloed[], all[])`      | UI menghitung daftar solo dari mirror |
 *   | `setMasterGain(db)`              | `setBusGain(bus, db)`           | master = bus 0 |
 *   | `writeParam(i, v)`               | `setParam(slot, v)` + `commitParams()` | commit dipanggil sekali per rAF oleh loop meter |
 *   | `subscribeProject()`             | tidak ada                      | mirror project hidup di `uiStore`; engine menerimanya lewat `loadProject(snapshot)` |
 *   | `memoryView(ptr, len)`           | tidak diekspos                 | waveform dibaca lewat `PeakSource` (ui/lib/peaks.ts) |
 *
 * `UiEngine` sengaja lebih sempit dari `EngineClient`: hanya yang benar-benar
 * dipakai UI. Itu membuat mock di test/storybook sepele, dan membuat jelas
 * permukaan mana yang kita bergantung padanya.
 */

import type { EngineClient, MeterFrame, TransportSnapshot } from '../audio/engine-client';

export type { MeterFrame, TransportSnapshot };

/** Alias historis — beberapa modul UI memakai nama ini. */
export type MeterSnapshot = MeterFrame;

/** 32 track + master di index 32. Nilai ini duplikat dari `audio/sab-layout.ts`
 *  dan dijaga sama oleh `assertLayout()` di sisi audio. */
export const METER_COUNT = 33;
export const MASTER_METER_INDEX = 32;

/**
 * Permukaan engine yang dipakai UI. `EngineClient` memenuhinya secara
 * struktural.
 *
 * PEMBAGIAN YANG MENGIKAT (ditetapkan `engine-client.ts`): command ring HANYA
 * untuk hal yang harus sample-accurate dan sering — transport, gain, pan,
 * mute, send, trigger. Edit STRUKTURAL (pindah/trim/fade clip, tempo map,
 * routing) tidak punya opcode sama sekali: model project adalah satu sumber
 * kebenaran di Rust, dan perubahannya dikirim sebagai snapshot lewat
 * `loadProject()`. Karena itu `useEngineCommands` memutasi mirror untuk
 * edit clip dan menyerahkan publikasinya ke jalur snapshot — bukan mengarang
 * opcode yang tidak ada.
 */
export interface UiEngine {
  readonly sampleRate: number;

  play(atSample?: number): void;
  stop(): void;
  seek(sample: number): void;
  setLoop(start: number, end: number): void;
  setLoopEnabled(on: boolean): void;

  setTrackGain(track: number, db: number): void;
  /** Master adalah salah satu bus di project model. */
  setBusGain(bus: number, db: number): void;
  setPan(track: number, pan: number): void;
  setMute(track: number, on: boolean): void;
  /** Solo bukan op engine: ia diterjemahkan jadi mute pada track lain. */
  setSolo(soloedTracks: readonly number[], allTracks: readonly number[]): void;
  setSend(track: number, send: number, amount: number): void;

  setParam(slot: number, value: number): void;
  commitParams(): void;

  /** Satu-satunya jalur untuk perubahan struktural. */
  loadProject(snapshot: Uint8Array): void;

  readTransport(): TransportSnapshot;
  readMetersInto(out: MeterFrame[]): boolean;
}

/** Index bus master di project model. */
export const MASTER_BUS = 0;

/** Cek kompatibilitas struktural di waktu kompilasi. Kalau engine-client
 *  berubah dan tidak lagi memenuhi UiEngine, build gagal DI SINI — bukan di
 *  belasan panel. */
type Assert<T extends true> = T;
export type EngineClientSatisfiesUiEngine = Assert<EngineClient extends UiEngine ? true : never>;

export const createMeterBuffer = (): MeterFrame[] =>
  Array.from({ length: METER_COUNT }, () => ({
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
    gainReductionDb: 0,
  }));
