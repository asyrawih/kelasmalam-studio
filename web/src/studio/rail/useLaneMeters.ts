/**
 * Level meter per lane.
 *
 * STATUS SAAT INI: engine (WASM) belum dibangun dan tidak ada `EngineClient`
 * yang bisa dijangkau rail, jadi hook ini mengembalikan `null` dan Lane Mixer
 * menggambar **posisi fader** (state nyata) alih-alih level yang bergerak.
 * Mengarang gerakan meter tanpa audio = berbohong ke user, jadi tidak dilakukan.
 *
 * Cara mengaktifkan nanti (satu tempat saja, tidak ada komponen yang berubah):
 * begitu ada EngineClient yang bisa diakses (context/prop), pakai
 * `EngineClient.createMeterBuffer()` sekali, lalu di dalam rAF panggil
 * `client.readMetersInto(buf)` (SeqLock, nol alokasi — lihat
 * `audio/engine-client.ts`) dan petakan indeks track → laneId lewat urutan lane
 * di project snapshot. Peak dalam linear; ubah ke travel dengan `dbToFader`.
 */

/** Level 0..1 per laneId, atau `null` kalau meter tidak tersedia. */
export type LaneMeters = Readonly<Record<string, number>> | null;

export function useLaneMeters(): LaneMeters {
  return null;
}
