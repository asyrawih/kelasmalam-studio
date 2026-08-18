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
 *   - Penjadwalannya "sekali tembak" per GENERASI: semua clip dijadwalkan di
 *     muka. Mengubah susunan saat berbunyi menjadwalkan satu generasi baru dan
 *     menyilangkannya dengan yang lama (`reschedule`) — bukan menjadwalkan
 *     ulang satu voice saja seperti engine nanti.
 *   - Mixing terjadi di JS, BUKAN lewat `render_block`. Artinya hasil preview
 *     TIDAK identik dengan hasil export — dan itu persis yang docs/03 peringatkan
 *     (dua jalur render). Karena itu modul ini HARUS DIHAPUS begitu engine hidup;
 *     lihat `docs/09-roadmap.md` M1.
 *
 * Kontrak: satu-satunya pemilik AudioContext untuk decode DAN playback, supaya
 * `AudioBuffer` hasil decode bisa dipakai ulang tanpa decode dua kali.
 */

import { effectiveSpeed, isAudible } from '../model';
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
import { pushFxParams, registerFxWorklet } from './fx-node';
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

/**
 * Satu GENERASI graf: seluruh voice dari satu kali penjadwalan, plus bus gain
 * miliknya sendiri.
 *
 * Ada karena susunan clip harus bisa diganti TANPA senyap. Dengan satu daftar
 * voice global, satu-satunya cara mengganti susunan adalah `stop()` lalu
 * `play()` — dan jeda 50 ms plus potongan seluruh lane itulah yang terdengar
 * sebagai "berhenti dulu, baru jalan lagi" tiap kali lane ditambah atau clip
 * digeser. Dengan generasi, yang baru dijadwalkan mulai PERSIS di titik yang
 * lama dipotong, dan keduanya disilangkan lewat bus masing-masing.
 *
 * Untuk materi yang TIDAK berubah, silangnya bahkan tidak terdengar sama
 * sekali: dua sinyal identik dengan ramp linear yang saling melengkapi
 * berjumlah tepat sinyal itu sendiri (x·(1−t) + x·t = x).
 */
interface Generation {
  readonly bus: GainNode;
  voices: AudioBufferSourceNode[];
  readonly nodes: AudioNode[];
}

/** Generasi yang masih hidup. Lebih dari satu HANYA selama crossfade. */
let generations: Generation[] = [];

/** Lookahead start biasa — cukup untuk menjadwalkan tanpa terlambat. */
const START_LOOKAHEAD_SEC = 0.05;
/**
 * Lookahead saat mengganti susunan di tengah bunyi. Lebih longgar dari start
 * biasa: perakitan graf baru berlangsung di JS, dan kalau titik silangnya
 * terlanjur lewat, hasilnya justru lubang yang mau dihilangkan.
 */
const SWITCH_LOOKAHEAD_SEC = 0.07;
/** Panjang silang antar generasi. Cukup untuk menutup klik, terlalu pendek
 *  untuk terdengar sebagai turun-naik level. */
const XFADE_SEC = 0.012;

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
/** Node `daw-fx` master dari graf yang sedang berbunyi. */
let masterFxNode: AudioWorkletNode | null = null;
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
    // Fire-and-forget: `addModule` asinkron sementara perakitan graf sinkron.
    // Sampai ia selesai, `createFxNode` mengembalikan null dan chain tidak
    // terdengar — sidik jari mix ikut menyertakan kesiapan ini, jadi begitu
    // siap, penjadwalan ulang berikutnya memasangnya.
    void registerFxWorklet(ctx);
  } catch {
    // Safari menolak sampleRate tertentu — biarkan browser memilih.
    ctx = new Ctor();
    void registerFxWorklet(ctx);
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

/**
 * Ramp linear dengan JALAN MUNDUR.
 *
 * `linearRampToValueAtTime` dicek karena Web Audio di tes dipalsukan seminimal
 * mungkin (lihat `master-gain.test.ts`) — satu API yang tidak ada di sana tidak
 * boleh mematikan seluruh jalur preview, cukup crossfade-nya yang jadi potongan
 * keras. Alasannya sama dengan `createAnalyser` di `ensureMaster`.
 */
function rampGain(p: AudioParam, from: number, to: number, at: number, sec: number): void {
  if (sec <= 0 || typeof p.linearRampToValueAtTime !== 'function') {
    p.value = to;
    return;
  }
  p.setValueAtTime(from, at);
  p.linearRampToValueAtTime(to, at + sec);
}

/** Bongkar satu generasi seketika. */
function disposeGeneration(gen: Generation): void {
  for (const v of gen.voices) {
    try {
      v.onended = null;
      v.stop();
    } catch {
      // sudah berhenti sendiri — abaikan
    }
    v.disconnect();
  }
  gen.voices = [];
  for (const n of gen.nodes) n.disconnect();
  gen.bus.disconnect();
}

/**
 * Pensiunkan generasi: turunkan bus-nya dan potong voice-nya TEPAT di ujung
 * silang, lalu bongkar setelah lewat.
 *
 * Pembongkarannya ditunda, bukan langsung: `disconnect()` seketika akan
 * memotong ekor yang justru sedang menyilang.
 */
function retireGeneration(gen: Generation, at: number, fadeSec: number): void {
  const end = at + fadeSec;
  rampGain(gen.bus.gain, 1, 0, at, fadeSec);
  for (const v of gen.voices) {
    try {
      v.stop(end);
    } catch {
      // belum start / sudah berhenti — abaikan
    }
  }
  const waitMs = Math.max(0, (end - (ctx?.currentTime ?? end)) * 1000) + 60;
  setTimeout(() => {
    if (!generations.includes(gen)) return; // sudah dibongkar `stop()`
    generations = generations.filter((g) => g !== gen);
    disposeGeneration(gen);
  }, waitMs);
}

/** Hentikan semua suara. Aman dipanggil berkali-kali. */
export function stop(): void {
  for (const gen of generations) disposeGeneration(gen);
  generations = [];
  stopScrub();
  laneNodes.clear();
  clipStems.clear();
  masterFxNode = null;
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
  if (masterFxNode !== null) {
    pushFxParams(masterFxNode, state.masterChain);
  }
  if (masterGain !== null) {
    masterGain.gain.setTargetAtTime(dbToLin(state.masterGainDb), at, PARAM_RAMP_SEC);
  }
  for (const lane of state.lanes) {
    const n = laneNodes.get(lane.id);
    if (n === undefined) continue;
    n.gain.gain.setTargetAtTime(dbToLin(lane.gainDb), at, PARAM_RAMP_SEC);
    // Knob FX ikut jalur yang SAMA dengan gain dan EQ: nilai dikirim ke node
    // yang sudah berbunyi, bukan memicu perakitan ulang graf. Merakit ulang di
    // tengah drag terdengar sebagai deretan klik.
    if (n.fx !== null) pushFxParams(n.fx, lane.chain);
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
 * Jadwalkan satu generasi baru dari posisi timeline `timelineSec`, dan
 * pensiunkan yang lama tepat di titik yang sama.
 *
 * Perakitan grafnya didelegasikan ke `buildProjectGraph` — jalur yang sama
 * persis dengan yang dipakai export offline.
 */
function startGeneration(
  state: StudioAppState,
  opts: { readonly timelineSec: number; readonly startAt: number; readonly fadeSec: number },
): void {
  const audio = ensureContext(state.sampleRate);
  if (audio === null) return;
  void audio.resume().catch(() => undefined);

  // Master dirakit DULU supaya lane punya tujuan: `buildProjectGraph` menerima
  // `destination`, jadi tidak ada satu pun lane yang menyambung langsung ke
  // `audio.destination` dan amplify tidak mungkin terlewat oleh salah satunya.
  const master = ensureMaster(audio, state);

  // Bus per generasi: SATU titik untuk menyilangkan seluruh susunan sekaligus.
  // Menyilangkan per lane berarti n ramp yang bisa saling telat sepersekian
  // blok — persis alasan yang sama kenapa amplify master hanya satu node.
  const bus = audio.createGain();
  bus.gain.value = opts.fadeSec > 0 ? 0 : 1;
  bus.connect(master);
  if (opts.fadeSec > 0) rampGain(bus.gain, 0, 1, opts.startAt, opts.fadeSec);

  const graph = buildProjectGraph(audio, state, {
    playheadSec: opts.timelineSec,
    startAt: opts.startAt,
    getBuffer: (id) => buffers.get(id),
    destination: bus,
    // Clip yang sedang diaudisi berbunyi dari pemutar audisi, bukan dari sini.
    skipClipId: state.clipLoop?.clipId,
  });

  // Yang lama dipotong PERSIS di titik yang baru mulai — bukan sebelumnya
  // (lubang) dan bukan sesudahnya (dua kali materi yang sama).
  for (const gen of generations) retireGeneration(gen, opts.startAt, opts.fadeSec);

  const gen: Generation = { bus, voices: [...graph.voices], nodes: [...graph.nodes] };
  generations = [...generations, gen];
  for (const src of gen.voices) {
    src.onended = () => {
      gen.voices = gen.voices.filter((v) => v !== src);
    };
  }

  // Parameter live selalu menunjuk generasi TERBARU: generasi lama hanya hidup
  // belasan milidetik lagi, dan menyetel gain-nya di tengah fade-out justru
  // melawan ramp yang sedang berjalan.
  laneNodes.clear();
  clipStems.clear();
  masterFxNode = null;
  for (const [id, ln] of graph.lanes) laneNodes.set(id, ln);
  masterFxNode = graph.masterFx;
  for (const [id, chain] of graph.clipStems) clipStems.set(id, chain);

  anchor = { ctxTime: opts.startAt, timelineSec: opts.timelineSec, speed: state.speed };
}

/**
 * Mulai dari `playhead` — dipakai saat menekan PLAY dan saat user MELOMPAT.
 *
 * Kalau sudah ada yang berbunyi, perpindahannya tetap disilangkan: melompat
 * saat sedang play adalah potongan yang memang dikehendaki, tapi klik di
 * sambungannya tidak.
 */
export function play(state: StudioAppState): void {
  const audio = ensureContext(state.sampleRate);
  if (audio === null) return;
  stopScrub();
  startGeneration(state, {
    timelineSec: state.playhead / state.sampleRate,
    startAt: audio.currentTime + START_LOOKAHEAD_SEC,
    fadeSec: generations.length > 0 ? XFADE_SEC : 0,
  });
}

/**
 * Susunan berubah SAAT berbunyi — lanjutkan di posisi yang sama persis.
 *
 * Bedanya dengan `play()` ada di titik mulainya, dan itu seluruh intinya:
 * `play()` memakai `state.playhead`, yang hanya di-tick 16×/detik dan karena
 * itu tertinggal sampai 60 ms dari yang benar-benar terdengar. Memakainya untuk
 * "tambah lane" atau "geser clip" membuat lagu melompat mundur sedikit tiap
 * kali — yang terdengar sebagai stop-lalu-play, bukan sebagai satu lagu yang
 * terus berjalan. Di sini titiknya dihitung dari jam audio.
 */
export function reschedule(state: StudioAppState): void {
  const audio = ctx;
  const a = anchor;
  if (audio === null || a === null || generations.length === 0) {
    play(state);
    return;
  }
  const startAt = audio.currentTime + SWITCH_LOOKAHEAD_SEC;
  // Posisi di titik silang dihitung dengan kecepatan LAMA: sampai `startAt`,
  // yang berbunyi masih generasi lama.
  const timelineSec = a.timelineSec + Math.max(0, startAt - a.ctxTime) * a.speed;
  startGeneration(state, { timelineSec, startAt, fadeSec: XFADE_SEC });
}

// ── Scrub audio ──────────────────────────────────────────────────────────────

/**
 * SCRUB = butiran, bukan mix.
 *
 * Menggeser playhead sambil membiarkan mix berjalan tidak mungkin: mix
 * dijadwalkan di muka dan berjalan maju sendiri, sedangkan tangan bisa berhenti
 * atau mundur. Yang dilakukan di sini sama dengan yang dilakukan pita: setiap
 * beberapa milidetik, satu potongan pendek materi DI POSISI PLAYHEAD dibunyikan.
 * Digeser cepat ke depan, potongannya berbaris maju — itu bunyi forward.
 * Digeser mundur, potongannya berbaris mundur — itu bunyi rewind. Tangan
 * berhenti, tidak ada potongan baru, dan hasilnya senyap seperti pita yang
 * berhenti.
 *
 * BATASAN yang disengaja: butir hanya lewat gain lane + gain clip, TANPA EQ,
 * stem, dan fade. Scrub dipakai untuk mencari posisi, bukan untuk menilai mix,
 * dan merakit rantai penuh 20× per detik akan memakan lebih banyak daripada
 * yang didengar.
 */
const GRAIN_SEC = 0.09;
/** Jarak antar butir. Lebih rapat dari `GRAIN_SEC` supaya butirnya bertindih
 *  dan terdengar menyambung, bukan seperti deretan ketukan. */
const GRAIN_INTERVAL_SEC = 0.045;
/** Fade di kedua ujung butir. Tanpa ini tiap butir mulai dan berhenti di tengah
 *  gelombang, dan yang terdengar hanya klik. */
const GRAIN_FADE_SEC = 0.012;

interface ScrubGrain {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}
let scrubGrains: ScrubGrain[] = [];
/** Waktu konteks butir terakhir, −1 kalau belum ada. */
let lastGrainAt = -1;
/** Posisi timeline butir terakhir — dipakai mengenali tangan yang DIAM. */
let lastGrainTimelineSec = Number.NaN;

/** Hentikan dan bongkar semua butir scrub. Aman dipanggil berkali-kali. */
export function stopScrub(): void {
  for (const g of scrubGrains) {
    try {
      g.source.onended = null;
      g.source.stop();
    } catch {
      // sudah berhenti sendiri — abaikan
    }
    g.source.disconnect();
    g.gain.disconnect();
  }
  scrubGrains = [];
  lastGrainAt = -1;
  lastGrainTimelineSec = Number.NaN;
}

/**
 * Bunyikan satu butir di posisi playhead sekarang. Dipanggil tiap `pointermove`
 * selama scrub; pembatasannya ada di dalam, bukan di pemanggil.
 */
export function scrubTo(state: StudioAppState): void {
  const audio = ensureContext(state.sampleRate);
  if (audio === null) return;
  const now = audio.currentTime;
  const timelineSec = state.playhead / state.sampleRate;

  const still = Number.isFinite(lastGrainTimelineSec)
    ? Math.abs(timelineSec - lastGrainTimelineSec) < 1e-4
    : false;
  if (lastGrainAt >= 0 && (still || now - lastGrainAt < GRAIN_INTERVAL_SEC)) return;
  lastGrainAt = now;
  lastGrainTimelineSec = timelineSec;

  void audio.resume().catch(() => undefined);
  const master = ensureMaster(audio, state);
  const sr = state.sampleRate;
  const startAt = now + 0.005;

  for (const lane of state.lanes) {
    if (!isAudible(lane, state.lanes)) continue;
    const rate = effectiveSpeed(lane, state.speed);
    for (const clip of lane.clips) {
      // Setengah-terbuka, sama dengan `selectPlayheadTempo`: di batas akhir,
      // yang berbunyi clip berikutnya.
      if (state.playhead < clip.start || state.playhead >= clip.start + clip.len) continue;
      const buffer = buffers.get(clip.assetId);
      if (buffer === undefined) continue;

      // KONVERSI RUANG sama dengan `buildProjectGraph`: jarak diukur di
      // TIMELINE, `offset` milik source diukur di SOURCE.
      const intoClipSec = (state.playhead - clip.start) / sr;
      const offsetSec = clip.sourceStart / sr + intoClipSec * lane.speedRatio;
      if (offsetSec < 0 || offsetSec >= buffer.duration) continue;
      const durSec = Math.min(GRAIN_SEC * rate, buffer.duration - offsetSec);
      if (durSec <= 0) continue;

      const gain = audio.createGain();
      gain.gain.value = 0;
      const level = dbToLin(lane.gainDb) * dbToLin(clip.gainDb);
      const wallSec = durSec / rate;
      const fade = Math.min(GRAIN_FADE_SEC, wallSec / 2);
      rampGain(gain.gain, 0, level, startAt, fade);
      rampGain(gain.gain, level, 0, startAt + wallSec - fade, fade);
      gain.connect(master);

      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.connect(gain);
      try {
        source.start(startAt, offsetSec, durSec);
      } catch {
        gain.disconnect();
        continue; // offset di luar buffer — lewati, jangan bunuh lane lain
      }
      const grain: ScrubGrain = { source, gain };
      scrubGrains = [...scrubGrains, grain];
      source.onended = () => {
        scrubGrains = scrubGrains.filter((g) => g !== grain);
        source.disconnect();
        gain.disconnect();
      };
    }
  }
}
