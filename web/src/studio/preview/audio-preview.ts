/**
 * PREVIEW PLAYBACK — jalur SEMENTARA, bukan arsitektur akhir.
 *
 * Kenapa ada: engine Rust/WASM belum di-build (`web/src/wasm/` kosong, butuh
 * nightly + `-Z build-std`), jadi tanpa ini tombol PLAY tidak mengeluarkan
 * suara sama sekali. Modul ini memakai Web Audio biasa — satu
 * `AudioBufferSourceNode` per clip — supaya hasil drag & drop bisa langsung
 * didengar.
 *
 * BATASAN YANG DISENGAJA (jangan ditambah, jangan dianggap engine):
 *   - Tidak ada FX, tidak ada compressor. Yang ada hanya gain, mute/solo,
 *     playbackRate, EQ parametrik 4 band lewat BiquadFilterNode, dan satu gain
 *     master (AMPLIFY) di ujung rantai.
 *   - Tidak ada limiter maupun soft-clipper di master, termasuk yang
 *     direkomendasikan docs/07 §7d — engine pun belum punya. Sample di atas
 *     ±1.0 lewat apa adanya ke destination. Itu keputusan yang harus DIKATAKAN,
 *     bukan disembunyikan, jadi panel Amplify menampilkan peak master asli
 *     (`readMasterPeak`) dan menyatakan bahwa tidak ada limiter.
 *   - `playbackRate` = VARISPEED: pitch ikut berubah. Sama seperti perilaku
 *     engine untuk MVP (docs/07), jadi setidaknya tidak menyesatkan.
 *   - Penjadwalannya "sekali tembak" saat play: semua clip dijadwalkan di muka.
 *     Mengubah clip saat berbunyi tidak terdengar sampai stop/play lagi.
 *   - Mixing terjadi di JS, BUKAN lewat `render_block`. Artinya hasil preview
 *     TIDAK identik dengan hasil export — dan itu persis yang docs/03 peringatkan
 *     (dua jalur render). Karena itu modul ini HARUS DIHAPUS begitu engine hidup;
 *     lihat `docs/09-roadmap.md` M1.
 *
 * Kontrak: satu-satunya pemilik AudioContext untuk decode DAN playback, supaya
 * `AudioBuffer` hasil decode bisa dipakai ulang tanpa decode dua kali.
 */

import { isAudible } from '../model';
import { clipLoopRange, type StudioAppState } from '../store';
import { stemOf } from '../timeline/stem';
import {
  PARAM_RAMP_SEC,
  buildAuditionVoice,
  buildProjectGraph,
  dbToLin,
  type AuditionVoice,
  type LaneNodes,
} from './graph-builder';
import { updateStemNodes, type StemNodes } from './stem-chain';

/**
 * Perakitan grafnya sendiri TIDAK ada di sini — lihat `graph-builder.ts`.
 * Modul ini hanya memiliki AudioContext, cache buffer, dan siklus play/stop.
 * Export offline memakai pembangun graf yang SAMA, dan itu disengaja.
 */
export { applyClipGainEnvelope } from './graph-builder';

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor | null {
  const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let ctx: AudioContext | null = null;
let ctxSampleRate = 48_000;

/** PCM hasil decode, dipakai bersama oleh import (waveform) dan preview (suara). */
const buffers = new Map<number, AudioBuffer>();

/** Node yang sedang berbunyi; dibersihkan tiap `stop()`. */
let voices: AudioBufferSourceNode[] = [];
/** Node non-source (gain lane, filter EQ) — perlu di-disconnect saat stop. */
let nodes: AudioNode[] = [];
const laneNodes = new Map<string, LaneNodes>();
/** Rantai stem per clip yang sedang berbunyi. Kosong untuk clip tanpa REMOVE. */
const clipStems = new Map<string, StemNodes>();

/**
 * Titik ikat antara JAM AUDIO dan posisi timeline, dipasang saat `play()`.
 *
 * Ada untuk satu hal: waveform yang bergeser mulus. Playhead di store hanya
 * maju 16×/detik dari `setInterval` di App — cukup untuk garis yang bergerak,
 * tapi kalau gambar seluruh waveform digeser dengan angka itu, hasilnya
 * tersendat dan tidak pernah persis di posisi yang terdengar. `ctx.currentTime`
 * adalah jam yang SAMA dengan yang memutar sample-nya.
 */
interface PlayAnchor {
  /** Waktu konteks saat `timelineSec` benar-benar terdengar. */
  readonly ctxTime: number;
  readonly timelineSec: number;
  readonly speed: number;
}
let anchor: PlayAnchor | null = null;

/**
 * PEMUTAR AUDISI — hidup terpisah dari transport.
 *
 * Ia menyala/mati lewat tombol LOOP PLAY, bukan lewat play/stop, dan tetap
 * berbunyi saat transport berhenti. Itu seluruh intinya: mendengar dua bar dari
 * satu clip tidak boleh menghentikan lagu di lane lain.
 */
let auditionVoice: AuditionVoice | null = null;

/**
 * AMPLIFY MASTER — satu gain yang dilewati SEMUA lane sebelum destination.
 *
 * Bukan dikalikan ke gain tiap lane: dengan satu node, menggeser slider hanya
 * menyentuh satu AudioParam (n lane = n ramp yang bisa saling telat sepersekian
 * blok, dan itu terdengar sebagai mix yang "goyang"), dan titik penerapannya
 * sama persis dengan fader bus master di engine (⑮ docs/07 §7a) — yang membuat
 * export selevel dengan preview.
 */
let masterGain: GainNode | null = null;
/**
 * Tap peak SESUDAH amplify. Ada supaya panel Amplify bisa menyatakan level
 * sebenarnya alih-alih menebak: tidak ada limiter di jalur ini, jadi
 * satu-satunya cara jujur memberi tahu user bahwa boost-nya clip adalah
 * mengukurnya.
 */
let masterTap: AnalyserNode | null = null;
/** `ArrayBuffer` eksplisit: `getFloatTimeDomainData` menolak view di atas
 *  SharedArrayBuffer, dan `Float32Array` polos ikut memuat kemungkinan itu. */
let masterTapBuf: Float32Array<ArrayBuffer> | null = null;

/**
 * AudioContext dibuat malas (lazy) karena browser mewajibkan user gesture.
 * Dipanggil dari handler drop dan dari tombol PLAY — keduanya gesture.
 */
export function ensureContext(sampleRate: number): AudioContext | null {
  if (ctx !== null) return ctx;
  const Ctor = audioContextCtor();
  if (Ctor === null) return null;
  try {
    ctx = new Ctor({ sampleRate });
  } catch {
    // Safari menolak sampleRate tertentu — biarkan browser memilih.
    ctx = new Ctor();
  }
  ctxSampleRate = ctx.sampleRate;
  return ctx;
}

export function previewSampleRate(): number {
  return ctx?.sampleRate ?? ctxSampleRate;
}

export function registerBuffer(assetId: number, buffer: AudioBuffer): void {
  buffers.set(assetId, buffer);
}

export function hasBuffer(assetId: number): boolean {
  return buffers.has(assetId);
}

export function getBuffer(assetId: number): AudioBuffer | undefined {
  return buffers.get(assetId);
}

/** Akses cache PCM untuk konsumen lain (export offline memakai yang SAMA). */
export function bufferLookup(): (assetId: number) => AudioBuffer | undefined {
  return (id) => buffers.get(id);
}

/** Apakah ada minimal satu clip terdengar yang PCM-nya sudah ada. */
export function hasRenderableAudio(state: StudioAppState): boolean {
  for (const lane of state.lanes) {
    if (!isAudible(lane, state.lanes)) continue;
    for (const c of lane.clips) if (buffers.has(c.assetId)) return true;
  }
  return false;
}

export function isPreviewAvailable(): boolean {
  return buffers.size > 0 && audioContextCtor() !== null;
}

/** Hentikan semua suara. Aman dipanggil berkali-kali. */
export function stop(): void {
  for (const v of voices) {
    try {
      v.onended = null;
      v.stop();
    } catch {
      // sudah berhenti sendiri — abaikan
    }
    v.disconnect();
  }
  voices = [];
  for (const n of nodes) n.disconnect();
  nodes = [];
  laneNodes.clear();
  clipStems.clear();
  anchor = null;
  // Master SENGAJA dibiarkan hidup: pemutar audisi menyambung ke sana dan
  // hidupnya tidak terikat transport. Membongkarnya di sini berarti menekan
  // STOP membisukan loop yang justru sedang didengarkan.
}

/** Buang master juga — dipakai tes dan pembongkaran total. */
export function teardown(): void {
  stop();
  stopAudition();
  masterGain?.disconnect();
  masterTap?.disconnect();
  masterGain = null;
  masterTap = null;
  masterTapBuf = null;
}

/**
 * Rantai master (amplify + tap peak), dibuat sekali dan dipakai bersama oleh
 * mix utama DAN pemutar audisi.
 *
 * Bersama, bukan dua: kalau audisi punya jalur sendiri ke destination, slider
 * AMPLIFY tidak berlaku untuknya dan meter tidak melihatnya — dua kebohongan
 * kecil yang baru ketahuan saat level ekspor tidak cocok.
 */
function ensureMaster(audio: BaseAudioContext, state: StudioAppState): GainNode {
  if (masterGain !== null) {
    masterGain.gain.value = dbToLin(state.masterGainDb);
    return masterGain;
  }
  const master = audio.createGain();
  master.gain.value = dbToLin(state.masterGainDb);
  master.connect(audio.destination);
  masterGain = master;

  // Analyser opsional: jsdom (dan browser sangat lama) tidak punya. Meter
  // hilang jauh lebih baik daripada preview yang mati total karenanya.
  if (typeof audio.createAnalyser === 'function') {
    const tap = audio.createAnalyser();
    // 2048 @48k = 43 ms — lebih panjang dari satu frame rAF (17 ms), jadi tidak
    // ada sample yang lolos di antara dua pembacaan panel.
    tap.fftSize = 2048;
    master.connect(tap); // cabang buntu: tap tidak menyambung ke destination
    masterTap = tap;
    masterTapBuf = new Float32Array(tap.fftSize);
  }
  return master;
}

/**
 * Posisi yang BENAR-BENAR sedang terdengar (detik timeline), atau null kalau
 * tidak ada yang berbunyi.
 *
 * `null` bukan 0 — sama seperti `readMasterPeak`. Pemanggil harus bisa
 * membedakan "belum mulai" dari "di detik nol", karena jawabannya menentukan
 * apakah ia memakai angka ini atau playhead dari store.
 */
export function previewPositionSec(): number | null {
  const a = anchor;
  if (a === null || ctx === null) return null;
  // Sebelum `startAt` (ada lookahead 50 ms) belum ada sample yang keluar;
  // jangan mundur ke belakang posisi awal.
  const elapsed = Math.max(0, (ctx.currentTime - a.ctxTime) * a.speed);
  return a.timelineSec + elapsed;
}

/**
 * Posisi yang sedang terdengar dari pemutar AUDISI, dalam detik SOURCE, atau
 * null kalau tidak ada audisi.
 *
 * Voice-nya mengulang sendiri di Web Audio sehingga jam audio terus maju lurus;
 * pembungkusannya dilakukan di sini dengan batas yang sama persis dengan yang
 * dipasang ke `loopStart`/`loopEnd`. Tanpa itu, waveform akan terus meluncur
 * menjauh sementara yang terdengar tetap dua bar yang sama.
 */
export function auditionPositionSourceSec(): number | null {
  const v = auditionVoice;
  if (v === null || ctx === null) return null;
  const span = v.loopEndSec - v.loopStartSec;
  if (span <= 0) return v.loopStartSec;
  const elapsed = Math.max(0, (ctx.currentTime - v.startAt) * v.rate);
  return v.loopStartSec + (elapsed % span);
}

export function isAuditionRunning(): boolean {
  return auditionVoice !== null;
}

/** Hentikan pemutar audisi. Aman dipanggil berkali-kali. */
export function stopAudition(): void {
  const v = auditionVoice;
  if (v === null) return;
  auditionVoice = null;
  try {
    v.source.onended = null;
    v.source.stop();
  } catch {
    // sudah berhenti sendiri — abaikan
  }
  for (const n of v.nodes) n.disconnect();
}

/**
 * Mulai (atau mulai ulang) pemutar audisi dari state sekarang.
 *
 * Selalu dari AWAL region, bukan dari posisi lama: memindahkan loop lalu
 * melanjutkan di tengah-tengah membuat putaran pertama setelah perpindahan
 * terdengar terpotong.
 */
export function startAudition(state: StudioAppState): void {
  stopAudition();
  const range = clipLoopRange(state);
  if (range === null) return;
  const buffer = buffers.get(range.clip.assetId);
  if (buffer === undefined) return;
  const audio = ensureContext(state.sampleRate);
  if (audio === null) return;
  void audio.resume().catch(() => undefined);

  auditionVoice = buildAuditionVoice(audio, {
    lane: range.lane,
    clip: range.clip,
    buffer,
    sourceStart: range.sourceStart,
    sourceLen: range.sourceLen,
    sampleRate: state.sampleRate,
    transportSpeed: state.speed,
    startAt: audio.currentTime + 0.05,
    destination: ensureMaster(audio, state),
  });
}

/**
 * Peak master (linear, sesudah amplify) sejak jendela analyser terakhir, atau
 * `null` kalau tidak ada yang berbunyi / browser tanpa AnalyserNode.
 *
 * `null` BUKAN 0: panel harus bisa membedakan "senyap" dari "tidak terukur",
 * karena meter yang menampilkan −inf saat sebenarnya tidak mengukur apa pun
 * adalah meter yang berbohong.
 */
export function readMasterPeak(): number | null {
  const tap = masterTap;
  const buf = masterTapBuf;
  if (tap === null || buf === null) return null;
  tap.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]!);
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Terapkan gain & EQ lane ke node yang sedang berbunyi. Dipanggil tiap kali
 * store berubah — murah, dan TIDAK menyentuh penjadwalan voice.
 */
export function updateLaneParams(state: StudioAppState): void {
  if (ctx === null) return;
  if (laneNodes.size === 0 && auditionVoice === null) return;
  const at = ctx.currentTime;
  // Amplify master lewat jalur yang SAMA dengan gain lane: `setTargetAtTime`
  // pada node yang sudah ada. Membangun ulang graf tiap kali slider bergerak
  // satu piksel akan terdengar sebagai deretan klik, bukan perubahan level.
  if (masterGain !== null) {
    masterGain.gain.setTargetAtTime(dbToLin(state.masterGainDb), at, PARAM_RAMP_SEC);
  }
  for (const lane of state.lanes) {
    const n = laneNodes.get(lane.id);
    if (n === undefined) continue;
    n.gain.gain.setTargetAtTime(dbToLin(lane.gainDb), at, PARAM_RAMP_SEC);
    // Node EQ parametrik bisa digeser MENDATAR juga, jadi frekuensi (dan Q)
    // ikut di-ramp — bukan cuma gain seperti pada EQ 3-slider dulu. Semuanya
    // lewat setTargetAtTime pada node yang SUDAH ADA: membangun ulang rantai
    // di tengah drag akan terdengar sebagai klik di setiap pixel gerakan.
    lane.eq.bands.forEach((band, i) => {
      const f = n.filters[i];
      if (f === undefined) return;
      f.frequency.setTargetAtTime(band.freq, at, PARAM_RAMP_SEC);
      f.gain.setTargetAtTime(band.gainDb, at, PARAM_RAMP_SEC);
      f.Q.setTargetAtTime(band.q, at, PARAM_RAMP_SEC);
    });
    // Stem juga parameter kontinu, dan lewat jalur yang sama: menggeser slider
    // REMOVE tidak boleh menunggu stop/play. Yang TIDAK bisa diperbarui di sini
    // hanyalah clip yang berpindah antara bypass dan aktif — rantainya memang
    // belum/tidak lagi ada, dan itu ditangani `mixFingerprint`.
    for (const clip of lane.clips) {
      const chain = clipStems.get(clip.id);
      if (chain === undefined) continue;
      updateStemNodes(chain, stemOf(clip), at);
    }
  }

  // Pemutar audisi ikut jalur yang sama. Kalau tidak, menggeser fader/EQ/REMOVE
  // saat mendengarkan loop tidak terdengar sama sekali — padahal justru di situ
  // orang menyetelnya.
  const v = auditionVoice;
  if (v !== null) {
    const range = clipLoopRange(state);
    if (range !== null) {
      v.laneGain.gain.setTargetAtTime(dbToLin(range.lane.gainDb), at, PARAM_RAMP_SEC);
      v.gain.gain.setTargetAtTime(dbToLin(range.clip.gainDb), at, PARAM_RAMP_SEC);
      range.lane.eq.bands.forEach((band, i) => {
        const f = v.filters[i];
        if (f === undefined) return;
        f.frequency.setTargetAtTime(band.freq, at, PARAM_RAMP_SEC);
        f.gain.setTargetAtTime(band.gainDb, at, PARAM_RAMP_SEC);
        f.Q.setTargetAtTime(band.q, at, PARAM_RAMP_SEC);
      });
      if (v.stem !== null) updateStemNodes(v.stem, stemOf(range.clip), at);
    }
  }
}

/**
 * Jadwalkan semua clip yang terdengar, relatif terhadap `playhead`.
 * Perakitannya didelegasikan ke `buildProjectGraph` — jalur yang sama persis
 * dengan yang dipakai export offline.
 */
export function play(state: StudioAppState): void {
  stop();
  const audio = ensureContext(state.sampleRate);
  if (audio === null) return;
  void audio.resume().catch(() => undefined);

  // Master dirakit DULU supaya lane punya tujuan: `buildProjectGraph` menerima
  // `destination`, jadi tidak ada satu pun lane yang menyambung langsung ke
  // `audio.destination` dan amplify tidak mungkin terlewat oleh salah satunya.
  const master = ensureMaster(audio, state);

  const playheadSec = state.playhead / state.sampleRate;
  const startAt = audio.currentTime + 0.05; // sedikit lookahead supaya start-nya rapi
  anchor = { ctxTime: startAt, timelineSec: playheadSec, speed: state.speed };
  const graph = buildProjectGraph(audio, state, {
    playheadSec,
    startAt,
    getBuffer: (id) => buffers.get(id),
    destination: master,
    // Clip yang sedang diaudisi berbunyi dari pemutar audisi, bukan dari sini.
    skipClipId: state.clipLoop?.clipId,
  });

  nodes = [...graph.nodes];
  voices = [...graph.voices];
  for (const [id, ln] of graph.lanes) laneNodes.set(id, ln);
  for (const [id, chain] of graph.clipStems) clipStems.set(id, chain);

  for (const src of voices) {
    src.onended = () => {
      voices = voices.filter((v) => v !== src);
    };
  }
}
