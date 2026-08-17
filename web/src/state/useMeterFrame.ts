/**
 * SATU rAF loop bersama untuk seluruh aplikasi.
 *
 * Dua aturan keras yang ditegakkan file ini:
 *
 * 1. TIDAK ADA rAF per-komponen. Kalau setiap meter memasang loop-nya sendiri,
 *    33 meter membaca SeqLock 33× per frame dan ballistics-nya beda fase.
 * 2. TIDAK ADA setState di dalam loop. Callback menerima data dan menggambar
 *    langsung ke canvas lewat ref. Nilai SAB tidak pernah masuk state React
 *    (docs/08 §Ringkasan arus state) — kalau masuk, React render 60×/detik.
 *
 * Ballistics decay WAJIB berbasis waktu, bukan per-frame (docs/05 §Tab
 * throttling). Di background tab rAF berhenti total; saat kembali, satu frame
 * bisa punya delta 30 detik. Karena itu `dt` di-clamp ke 100 ms sehingga
 * lompatan besar menghasilkan SATU langkah decay, bukan meter yang jatuh ke
 * dasar. Konsekuensi: konstanta decay di bawah dinyatakan dalam dB/detik,
 * bukan dB/frame — mengubahnya jadi per-frame akan membuat tampilan bergantung
 * pada refresh rate monitor (60 vs 120 Hz) dan itu bug.
 *
 * Loop ini juga yang memanggil `commitParams()`: drag fader boleh memanggil
 * `setParam()` sesering pointermove mau, tapi publikasi ke audio thread terjadi
 * tepat sekali per frame (docs/08 §8a).
 */

import { useEffect, useRef } from 'react';
import type { MeterFrame as Meter, TransportSnapshot, UiEngine } from './engine-types';
import { METER_COUNT, createMeterBuffer } from './engine-types';

/** Laju turun tampilan meter. Peak-hold sendiri ditulis audio thread. */
const DECAY_DB_PER_SEC = 20;
/** Clamp dari docs/05. Jangan diubah tanpa membaca bagian itu. */
const MAX_DT_MS = 100;
const MIN_DB = -100;

export interface MeterFrameData {
  /** Milidetik sejak frame sebelumnya, sudah di-clamp ke <= 100. */
  readonly dtMs: number;
  readonly now: number;
  readonly transport: TransportSnapshot;
  /** Nilai mentah dari SAB, index 0..31 = track, 32 = master. */
  readonly meters: readonly Meter[];
  /** dB yang sudah kena decay berbasis waktu — ini yang digambar.
   *  Layout: [peakL, peakR] per meter, panjang METER_COUNT * 2. */
  readonly displayDb: Float32Array;
}

type FrameCallback = (frame: MeterFrameData) => void;

const callbacks = new Set<FrameCallback>();

let client: UiEngine | null = null;
let rafId = 0;
let lastTime = 0;

// Buffer dialokasi sekali; loop ini tidak boleh mengalokasi apa pun per frame.
const meters = createMeterBuffer();
const displayDb = new Float32Array(METER_COUNT * 2).fill(MIN_DB);

const frame: { -readonly [K in keyof MeterFrameData]: MeterFrameData[K] } = {
  dtMs: 0,
  now: 0,
  transport: { state: 0, playhead: 0, loopStart: 0, loopEnd: 0, xruns: 0, cpuLoad: 0 },
  meters,
  displayDb,
};

function linToDb(x: number): number {
  return x > 1e-5 ? 20 * Math.log10(x) : MIN_DB;
}

/** dB → posisi 0..1 pada skala meter design (-60 dB di kiri, 0 dB di kanan).
 *  Dipakai semua penggambar meter supaya L/R, strip mixer, dan master memakai
 *  skala yang sama persis. */
export function dbToNorm(db: number, floorDb = -60): number {
  if (db <= floorDb) return 0;
  return Math.min(1, (db - floorDb) / -floorDb);
}

function tick(now: number): void {
  rafId = requestAnimationFrame(tick);
  const engine = client;
  if (engine === null) return;

  const dtMs = lastTime === 0 ? 16.7 : Math.min(now - lastTime, MAX_DT_MS);
  lastTime = now;

  // Publikasikan param yang ditulis drag sejak frame lalu (satu kali, di sini).
  engine.commitParams();

  const fresh = engine.readMetersInto(meters);
  const maxFall = (DECAY_DB_PER_SEC * dtMs) / 1000;
  for (let i = 0; i < METER_COUNT; i++) {
    // Kalau pembacaan gagal (SeqLock sibuk / jalur degraded tanpa SAB), jangan
    // membekukan tampilan: teruskan decay dari nilai terakhir supaya meter
    // turun alih-alih menggantung di puncak.
    const target = fresh ? linToDb(meters[i]!.peakL) : MIN_DB;
    const targetR = fresh ? linToDb(meters[i]!.peakR) : MIN_DB;
    // Attack instan, release dibatasi waktu.
    displayDb[i * 2] = Math.max(target, displayDb[i * 2]! - maxFall);
    displayDb[i * 2 + 1] = Math.max(targetR, displayDb[i * 2 + 1]! - maxFall);
  }

  frame.dtMs = dtMs;
  frame.now = now;
  frame.transport = engine.readTransport();

  for (const cb of callbacks) cb(frame);
}

function start(): void {
  if (rafId !== 0) return;
  lastTime = 0;
  rafId = requestAnimationFrame(tick);
}

function stop(): void {
  if (rafId === 0) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

/** Dipasang sekali di App, setelah audio di-unlock. */
export function attachMeterLoop(engine: UiEngine): () => void {
  client = engine;
  if (callbacks.size > 0) start();
  return () => {
    client = null;
    stop();
  };
}

/**
 * Daftarkan callback per-frame.
 *
 * `cb` boleh berubah tiap render (disimpan di ref), tapi TIDAK BOLEH memanggil
 * setState. Gambar ke canvas lewat ref.
 */
export function useMeterFrame(cb: FrameCallback): void {
  const ref = useRef(cb);
  ref.current = cb;

  useEffect(() => {
    const stable: FrameCallback = (f) => ref.current(f);
    callbacks.add(stable);
    if (client !== null) start();
    return () => {
      callbacks.delete(stable);
      if (callbacks.size === 0) stop();
    };
  }, []);
}
