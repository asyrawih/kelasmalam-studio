/**
 * Store Audio Studio — `useSyncExternalStore` dengan langganan ber-selector.
 *
 * KENAPA BUKAN CONTEXT: Context menyiarkan ke seluruh consumer setiap kali
 * nilainya berubah. Satu drag clip akan me-render ulang semua lane header,
 * semua clip, rail, dan detail panel. Dengan `useSyncExternalStore` tiap
 * komponen hanya bangun kalau irisan datanya benar-benar berubah.
 *
 * ATURAN PENTING untuk pemakai (termasuk agent rail): selector HARUS
 * mengembalikan nilai yang stabil secara referensi — primitif, atau objek/array
 * yang memang tersimpan di state. JANGAN mengembalikan objek/array baru tiap
 * panggilan (`s => ({a: s.a})`) karena `getSnapshot` yang selalu berbeda
 * membuat React render tanpa henti. Kalau butuh beberapa nilai, panggil
 * `useStudio` beberapa kali.
 *
 * Kebenaran audio nantinya ada di engine (Rust). State di sini adalah state UI
 * + mirror project; semua mutasi lewat `studioActions`.
 */

import { useSyncExternalStore } from 'react';

import type { AssetMap, ImportStage } from '@kelasmalam/studio-core/assets/model';
import { assetActions, assetStore } from '@kelasmalam/studio-core/assets/store';
import { registerAssetUsage, type AssetUsage } from '@kelasmalam/studio-core/assets/usage';
import { computeClipSync, type SyncAlignment } from './analysis/beat-sync';
import { MIN_MASTER_GAIN_DB, MAX_MASTER_GAIN_DB, MIN_RENDER_SPEED, MAX_RENDER_SPEED, type EqMode, timelineLenFor, MAX_LANE_SPEED, MIN_LANE_SPEED,
  EQ_PRESETS,
  cloneEq,
  defaultEq,
  clampEqBand,
  DEFAULT_LANE_HEIGHT,
  LANE_COLORS,
  STEM_BYPASS,
  clampStemMix,
  findClip,
  samplesToSec,
  secToSamples,
  type EqBandId,
  type EqPreset,
  type EqSettings,
  type ExportFormat,
  type FxInsert,
  type FxTarget,
  type LaneHeightId,
  type RailTab,
  type Samples,
  type Speed,
  type StudioClip,
  type StemMix,
  type StudioLane,
  type StudioState,
} from './model';
import { createDemoStudio, createInitialStudio } from './demo';
import { applyLoopCut, type LoopCutSpec } from './timeline/beat-cut';
import { activeLoopLen, applyClipLoop, clearClipLoop, MIN_LOOP_LEN } from './timeline/clip-loop';
import { slipClip, trimLeft, trimRight } from './timeline/clip-trim';
import { normalizeClipStem } from './timeline/stem';

/*
 * ASET TIDAK LAGI DI SINI (docs/25 P4). `StudioAsset`, `AssetTempo`,
 * `TEMPO_UNCERTAIN`, dan seluruh aksi aset (`registerAsset`, `setAssetBeatGrid`,
 * …) hidup di `@kelasmalam/studio-core/assets/{model,store}` — registry yang
 * dibagi Studio lane, Studio FL, dan `/dj`. Store ini MEMBACA `assetStore`
 * (lihat `assetStore.getState().assets[...]` di aksi clip) dan BERLANGGANAN
 * padanya untuk dua hal yang tetap milik project: riwayat undo dan penanda
 * kotor — lihat `assetStore.subscribe` di bawah.
 */

/**
 * Satu clip di papan salin, beserta lane-nya RELATIF terhadap clip paling kiri.
 *
 * Offset lane disimpan supaya menyalin empat clip dari dua lane lalu mem-paste-
 * nya tetap menghasilkan bentuk yang sama — bukan tumpukan di satu lane.
 */
export interface ClipboardEntry {
  readonly clip: StudioClip;
  /** Selisih indeks lane terhadap clip pertama (yang paling kiri, lane teratas). */
  readonly laneOffset: number;
  /** Selisih posisi terhadap clip pertama, dalam sample. */
  readonly startOffset: Samples;
}

/**
 * Satu import yang sedang berjalan.
 *
 * DAFTAR, bukan satu slot: user boleh menjatuhkan tiga lagu ke tiga lane
 * sekaligus, dan tiap lane harus memperlihatkan miliknya sendiri. Satu slot
 * global akan membuat file kedua menimpa tampilan file pertama, padahal
 * keduanya benar-benar sedang berjalan bersamaan.
 *
 * `laneId` null berarti import tanpa lane (mis. dari halaman lain); UI lane
 * hanya menampilkan yang laneId-nya cocok. Tahapnya (`ImportStage`) milik core
 * karena jalur decode-nya di sana; DAFTAR job-nya milik lane, jadi tetap di
 * sini.
 */
export interface ImportJob {
  readonly id: string;
  readonly laneId: string | null;
  /** Nama file/URL apa adanya, untuk dipajang. */
  readonly name: string;
  readonly stage: ImportStage;
  /** 0..1 kalau bisa diukur; null = tak tentu (bar indeterminate). */
  readonly ratio: number | null;
}

/** Posisi awal sebuah clip saat drag dimulai. Dipakai `moveClips`. */
export interface ClipOrigin {
  readonly id: string;
  readonly start: Samples;
  readonly laneIndex: number;
}

/** Region audisi di dalam sebuah clip, SOURCE-space. */
export interface ClipLoop {
  readonly clipId: string;
  readonly sourceStart: Samples;
  readonly sourceLen: Samples;
}

/** `ClipLoop` + batasnya di timeline dan clip/lane pemiliknya. */
export interface ClipLoopRange extends ClipLoop {
  readonly lane: StudioLane;
  readonly clip: StudioClip;
  /** TIMELINE-space. */
  readonly start: Samples;
  readonly end: Samples;
}

/**
 * `StudioState` (model.ts, binding) + hal-hal yang murni milik shell:
 * asset ter-decode dan status engine.
 */
export interface StudioAppState extends StudioState {
  /**
   * Import yang SEDANG berjalan, urut sesuai waktu mulai.
   *
   * State sesi murni: tidak ikut disimpan (lihat `persist/persistence.ts`,
   * yang memilih field satu per satu) dan dikosongkan oleh `hydrate` — sebuah
   * bar progres yang hidup kembali setelah refresh tidak akan pernah selesai,
   * karena file yang dibacanya sudah tidak ada lagi.
   */
  readonly importJobs: readonly ImportJob[];
  /** true kalau EngineClient berhasil dibuat. Selama false, audio tidak bunyi. */
  readonly engineReady: boolean;
  /** Alasan engine tidak tersedia — ditampilkan apa adanya, tidak disembunyikan. */
  readonly engineError: string | null;
  /**
   * Naik tiap kali playhead dipindah SECARA EKSPLISIT (klik/scrub/skip).
   * `tick()` TIDAK menaikkannya. Playback memakai ini untuk membedakan
   * "playhead maju sendiri" (tidak perlu apa-apa) dari "user melompat"
   * (voice harus dijadwalkan ulang dari posisi baru).
   */
  readonly seekEpoch: number;
  /**
   * true selama playhead sedang di-drag.
   *
   * MIX-nya dibisukan sampai dilepas — ia dijadwalkan di muka dan berjalan maju
   * sendiri, sedangkan tangan bisa diam atau mundur. Yang menggantikannya
   * adalah butir scrub di `preview/audio-preview.ts`, dan butir itu berbunyi
   * BAIK saat transport play MAUPUN saat berhenti.
   */
  readonly scrubbing: boolean;
  /**
   * true selama CLIP sedang di-drag. Playback tidak dijadwalkan ulang selama
   * ini berlangsung — penjadwalan ulang tiap pointermove hanya menghasilkan
   * deretan klik. Begitu dilepas, flag turun dan posisi baru langsung berlaku.
   */
  readonly draggingClip: boolean;
  /**
   * SELURUH clip yang terpilih. `selectedClipId` adalah yang PRIMER — clip yang
   * ditampilkan Clip Detail — dan selalu termasuk di sini selama tidak kosong.
   *
   * Dua field, bukan satu, karena keduanya menjawab pertanyaan berbeda: aksi
   * massal (geser, hapus, salin) butuh himpunannya, sedangkan editor di Clip
   * Detail hanya masuk akal untuk SATU clip. Menyatukannya berarti salah satu
   * dari keduanya harus menebak, dan tebakan itu yang akan salah.
   *
   * Invariannya ditegakkan di `withDerived`, bukan di tiap aksi.
   */
  readonly selectedClipIds: readonly string[];
  /** Clip hasil COPY, siap di-paste. Bukan PCM — hanya metadata. */
  readonly clipboard: readonly ClipboardEntry[] | null;
  /** Ulangi dari awal saat mencapai akhir materi. */
  readonly loop: boolean;
  /**
   * AUDISI LOOP: satu region di dalam satu clip yang diputar berulang, sendirian.
   *
   * State SESI, bukan bagian dari karya — karena itu di sini, bukan di
   * `StudioState`, dan tidak ikut disimpan. Ia menjawab "coba dengar 2 bar ini
   * berulang-ulang", pertanyaan yang selalu datang SEBELUM user memutuskan
   * memotong. Region-nya sendiri disimpan di SOURCE-space: batas timeline-nya
   * diturunkan lewat `clipLoopRange`, supaya menggeser clip atau mengubah
   * kecepatan lane tidak membuat loop menunjuk materi yang berbeda.
   */
  readonly clipLoop: ClipLoop | null;
  /**
   * Ujung MATERI (clip terjauh), tanpa ekor kosong dan tanpa minimum.
   * Berbeda dari `duration`, yang selalu punya ruang sisa untuk menaruh clip
   * baru. Transport berhenti/mengulang di sini, bukan di `duration` — kalau
   * tidak, setelah lagu habis playhead masih berjalan lama di ruang senyap.
   */
  readonly contentEnd: Samples;
  /**
   * Urutan panel di kolom kiri, dari atas ke bawah. Preferensi tata letak,
   * bukan bagian dari karya — tapi ikut disimpan supaya susunan yang sudah
   * diatur tidak hilang tiap refresh.
   */
  readonly panelOrder: readonly PanelId[];
  /** Urutan panel di rail kanan. Daftar terpisah dari kolom kiri. */
  readonly railOrder: readonly PanelId[];
  /**
   * Panel yang sedang dibentangkan penuh layar, atau null.
   *
   * SENGAJA TIDAK DIPERSIST: membuka aplikasi dan langsung mendapati satu panel
   * menutupi segalanya, tanpa ingat pernah memilihnya, itu membingungkan —
   * apalagi kalau tombol keluarnya belum ditemukan. Ini state sesi, bukan
   * bagian dari project.
   */
  readonly maximizedPanel: PanelId | null;
  /** Tampilan EQ yang dipilih user. Preferensi UI, tidak mempengaruhi audio. */
  readonly eqMode: EqMode;
  /** Tinggi baris lane. Preferensi tata letak, ikut disimpan. */
  readonly laneHeight: LaneHeightId;
  /**
   * Menu toolbar yang sedang terbuka, atau null.
   *
   * SENGAJA TIDAK DISIMPAN, alasan yang sama dengan `maximizedPanel`: membuka
   * aplikasi dan langsung mendapati sebuah popup menutupi timeline, tanpa ingat
   * pernah membukanya, membingungkan. Ini keadaan sesi, bukan bagian dari karya.
   *
   * Satu slot, bukan himpunan: hanya satu menu boleh terbuka. Beberapa popup
   * sekaligus akan menutupi permukaan kerja yang justru sedang dilihat.
   */
  readonly openMenu: MenuId | null;
  /** Magnetic snap saat clip digeser. Preferensi sesi/proyek. */
  readonly snapEnabled: boolean;
  /** Batas bawah panjang timeline (detik), diatur manual. */
  readonly minDurationSec: number;
  /** Batas atas panjang timeline (detik). null = ikut konten (otomatis). */
  readonly maxDurationSec: number | null;
  /**
   * PENANDA KOTOR, dalam bentuk dua angka.
   *
   * `projectSerial` naik tiap kali KARYA berubah — pakai definisi yang sama
   * dengan riwayat undo (`EDIT_KEYS`), termasuk undo/redo itu sendiri.
   * `savedSerial` adalah nilai `projectSerial` saat terakhir disimpan atau
   * dibuka. Kotor = keduanya tidak sama.
   *
   * Dua angka, bukan satu boolean, karena simpan itu ASINKRON: user boleh
   * mengedit selama unggahan berjalan, dan `markSaved(serialSaatMulai)` harus
   * membiarkan project tetap kotor kalau ada edit di antaranya. Boolean tidak
   * bisa membedakan itu. Keduanya state sesi — tidak ikut diserialisasi.
   */
  readonly projectSerial: number;
  readonly savedSerial: number;
}

/**
 * Menu di toolbar atas. Urutannya = urutan ikon di layar.
 *
 * Dikelompokkan berdasarkan APA YANG DISENTUH, bukan asal panelnya:
 * `beat`/`loop`/`clip`/`stem` menyentuh satu clip, `mix`/`eq`/`master`/`export`
 * menyentuh keseluruhan project.
 */
export type MenuId =
  | 'fx'
  | 'transport'
  | 'beat'
  | 'loop'
  | 'clip'
  | 'stem'
  | 'mix'
  | 'eq'
  | 'master'
  | 'export'
  | 'help';

/** Panel yang bisa diurutkan ulang. Dua tumpukan terpisah: kolom kiri & rail. */
export type PanelId =
  | 'timeline'
  | 'clip-detail'
  | 'transport'
  | 'rail-tabs'
  | 'amplify'
  | 'render-speed'
  | 'shortcuts';

export const DEFAULT_PANEL_ORDER: readonly PanelId[] = ['timeline', 'clip-detail'];
export const DEFAULT_RAIL_ORDER: readonly PanelId[] = [
  'transport',
  'rail-tabs',
  'amplify',
  'render-speed',
  'shortcuts',
];

/** Panjang minimum timeline (design memakai DUR = 120 detik). */
export const MIN_DURATION_SEC = 120;

/**
 * Ruang kosong yang selalu disediakan SETELAH clip terakhir.
 *
 * Tanpa ini, `duration` persis sama dengan ujung clip terjauh, dan karena
 * `moveClip` membatasi posisi ke `duration - len`, clip terakhir tidak akan
 * pernah bisa digeser ke kanan — timeline mengunci dirinya sendiri di panjang
 * saat ini. Ekor ini juga yang memberi tempat untuk menjatuhkan file baru
 * di belakang materi yang sudah ada. Semua DAW punya perilaku ini.
 */
export const TAIL_ROOM_SEC = 30;

// ── Inti store ───────────────────────────────────────────────────────────────

let state: StudioAppState = withDerived({
  ...createInitialStudio(),
  importJobs: [],
  engineReady: false,
  seekEpoch: 0,
  scrubbing: false,
  draggingClip: false,
  clipboard: null,
  selectedClipIds: [],
  loop: true,
  clipLoop: null,
  contentEnd: 0,
  panelOrder: DEFAULT_PANEL_ORDER,
  railOrder: DEFAULT_RAIL_ORDER,
  maximizedPanel: null,
  eqMode: 'curve',
  laneHeight: DEFAULT_LANE_HEIGHT,
  openMenu: null,
  snapEnabled: true,
  minDurationSec: MIN_DURATION_SEC,
  maxDurationSec: null,
  engineError: null,
  projectSerial: 0,
  savedSerial: 0,
});

type Listener = () => void;
const listeners = new Set<Listener>();
const MAX_UNDO_HISTORY = 100;

/**
 * Satu langkah riwayat = project DAN peta aset pada saat itu.
 *
 * Aset tidak lagi field store ini (docs/25 P4), tapi ia tetap bagian KARYA:
 * mengimpor lagu, mengetik BPM, menggeser downbeat — semuanya tersimpan bersama
 * project dan semuanya bisa di-undo, persis seperti sebelum registry-nya
 * dipisah. Snapshot gabungan inilah yang mempertahankan itu: ⌘Z sesudah import
 * mengembalikan daftar lagu, bukan hanya clip-nya.
 */
interface HistoryEntry {
  readonly project: StudioAppState;
  readonly assets: AssetMap;
}
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
let restoringHistory = false;
let dragHistoryRecorded = false;

/** Field yang benar-benar mengubah karya. State transport/seleksi/UI tidak
 * masuk riwayat, jadi Undo tidak meloncatkan playhead atau membuka popup lama.
 * Peta aset ikut dihitung karya lewat langganan `assetStore` di bawah. */
const EDIT_KEYS: readonly (keyof StudioAppState)[] = [
  'lanes', 'masterGainDb', 'masterChain', 'renderSpeed',
  'exportFileName', 'minDurationSec', 'maxDurationSec',
];

function hasProjectEdit(before: StudioAppState, after: StudioAppState): boolean {
  return EDIT_KEYS.some((key) => before[key] !== after[key]);
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Simpan keadaan SEBELUM sebuah edit. Pointermove selama drag dirapatkan jadi satu. */
function recordHistory(entry: HistoryEntry): void {
  if (!state.draggingClip || !dragHistoryRecorded) {
    undoStack.push(entry);
    if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift();
    redoStack.length = 0;
  }
  if (state.draggingClip) dragHistoryRecorded = true;
}

function restoreProject(snapshot: HistoryEntry): void {
  const patch = Object.fromEntries(
    EDIT_KEYS.map((key) => [key, snapshot.project[key]]),
  ) as Partial<StudioAppState>;
  // Aset dipulihkan DULU, di bawah `restoringHistory`, supaya langganan di
  // bawah tidak merekamnya sebagai edit baru; lalu project-nya.
  assetActions.restoreAssets(snapshot.assets);
  // Undo/redo mengubah karya relatif terhadap yang tersimpan, jadi ia juga
  // mengotori — walaupun secara kebetulan kembali ke bentuk yang sama persis
  // dengan yang disimpan. Membandingkan isi untuk mendeteksi kasus itu berarti
  // menyerialisasi seluruh project tiap ketukan ⌘Z; tidak sepadan.
  state = withDerived({ ...state, ...patch, draggingClip: false, projectSerial: state.projectSerial + 1 });
  notify();
}

/** Keadaan sekarang sebagai satu langkah riwayat. */
function currentEntry(): HistoryEntry {
  return { project: state, assets: assetStore.getState().assets };
}

/*
 * LANGGANAN KE REGISTRY ASET.
 *
 * Perubahan aset adalah edit karya: ia masuk riwayat undo (dengan peta aset
 * SEBELUM perubahan) dan menaikkan `projectSerial` — definisi "karya berubah"
 * yang sama dengan `set()` di bawah, supaya tidak ada edit yang bisa di-undo
 * tapi tidak membuat judul jendela bertanda. Selama `restoringHistory`
 * (undo/redo/hydrate) perubahan itu justru DATANG dari riwayat, jadi tidak
 * direkam lagi.
 */
let lastAssets: AssetMap = assetStore.getState().assets;
assetStore.subscribe(() => {
  const next = assetStore.getState().assets;
  if (next === lastAssets) return;
  const prev = lastAssets;
  lastAssets = next;
  if (restoringHistory) return;
  recordHistory({ project: state, assets: prev });
  state = { ...state, projectSerial: state.projectSerial + 1 };
  notify();
});

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getState(): StudioAppState {
  return state;
}

/** Set state + turunkan ulang `duration`, lalu beri tahu pelanggan. */
function set(patch: (s: StudioAppState) => Partial<StudioAppState> | null): void {
  const next = patch(state);
  if (next === null) return;
  const merged = withDerived({ ...state, ...next });
  if (merged === state) return;
  if (!restoringHistory && hasProjectEdit(state, merged)) {
    // Pointermove bisa memanggil store puluhan kali. Selama drag aktif hanya
    // keadaan sebelum gerakan pertama yang disimpan.
    recordHistory(currentEntry());
    // Satu definisi "karya berubah" untuk riwayat undo DAN penanda kotor —
    // kalau keduanya punya daftar field sendiri, suatu hari ada edit yang bisa
    // di-undo tapi tidak membuat judul jendela bertanda.
    state = { ...merged, projectSerial: merged.projectSerial + 1 };
  } else {
    state = merged;
  }
  notify();
}

/**
 * Pertahankan urutan pilihan user, buang id yang sudah tidak dikenal, lalu
 * tambahkan panel baru di akhir. Mengembalikan array LAMA kalau tidak ada yang
 * berubah — supaya selector berbasis referensi tidak ikut render ulang.
 */
function reconcileOrder(
  current: readonly PanelId[] | undefined,
  canonical: readonly PanelId[],
): readonly PanelId[] {
  const known = (current ?? []).filter((id) => canonical.includes(id));
  const missing = canonical.filter((id) => !known.includes(id));
  if (missing.length === 0 && known.length === (current ?? []).length) {
    return current ?? canonical;
  }
  return [...known, ...missing];
}

/**
 * Batas TIMELINE dari region audisi, atau null kalau tidak ada / clip-nya sudah
 * hilang.
 *
 * Diturunkan setiap kali dipakai, bukan disimpan: kalau batas timeline ikut
 * disimpan, menggeser clip atau mengubah kecepatan lane akan membuat loop
 * menunjuk materi yang berbeda dari yang disorot di layar — dan tidak ada satu
 * pun yang memberi tahu. Perhitungannya beberapa operasi; `tick()` boleh
 * memanggilnya 16×/detik.
 */
export function clipLoopRange(s: StudioAppState): ClipLoopRange | null {
  const cl = s.clipLoop;
  if (cl === null) return null;
  const hit = findClip(s.lanes, cl.clipId);
  if (hit === null) return null;
  const { lane, clip } = hit;
  // SOURCE → TIMELINE lewat ratio lane, arah yang sama dengan `splitClipAt`.
  const start = clip.start + (cl.sourceStart - clip.sourceStart) / lane.speedRatio;
  const end = start + cl.sourceLen / lane.speedRatio;
  if (!(end > start)) return null;
  return { ...cl, lane, clip, start: Math.round(start), end: Math.round(end) };
}

/**
 * `duration` diturunkan dari clip terjauh + ekor kosong, minimal 2 menit.
 * Tumbuh otomatis begitu clip ditambah/digeser ke kanan.
 */
function withDerived(s: StudioAppState): StudioAppState {
  const minimum = secToSamples(Math.max(1, s.minDurationSec), s.sampleRate);
  const tail = secToSamples(TAIL_ROOM_SEC, s.sampleRate);
  let contentEnd = 0;
  for (const lane of s.lanes) {
    for (const clip of lane.clips) contentEnd = Math.max(contentEnd, clip.start + clip.len);
  }
  let farthest = Math.max(minimum, contentEnd + tail);
  // MAX hanya boleh MEMENDEKKAN timeline sampai batas konten. Kalau ada clip
  // yang melewatinya, konten yang menang — memotong timeline di bawah audio
  // yang benar-benar ada berarti menyembunyikan materi dari user (dan dari
  // export). Batasnya jadi "sesingkat mungkin", bukan "buang yang lebih".
  if (s.maxDurationSec !== null) {
    const cap = secToSamples(Math.max(1, s.maxDurationSec), s.sampleRate);
    farthest = Math.max(Math.min(farthest, cap), contentEnd);
  }
  // Urutan panel DIREKONSILIASI dengan daftar kanonik setiap kali state
  // berubah. Tanpa ini, project yang tersimpan sebelum sebuah panel ada akan
  // menyimpan urutan tanpa id panel itu — panelnya tetap tampil (di-append
  // sebagai "extra"), tapi `movePanel` menolaknya karena tidak ada di daftar,
  // jadi drag-nya diam saja tanpa error. Gejalanya: panel baru tidak bisa
  // dipindah, hanya di project lama.
  const panelOrder = reconcileOrder(s.panelOrder, DEFAULT_PANEL_ORDER);
  const railOrder = reconcileOrder(s.railOrder, DEFAULT_RAIL_ORDER);

  // Seleksi yang menunjuk ke sesuatu yang sudah dihapus harus dibersihkan,
  // kalau tidak panel detail akan menampilkan clip hantu.
  const laneOk = s.lanes.some((l) => l.id === s.selectedLaneId);
  const clipOk = findClip(s.lanes, s.selectedClipId) !== null;

  // INVARIAN SELEKSI, ditegakkan di satu tempat supaya tiap aksi tidak perlu
  // mengingatnya sendiri:
  //   1. id yang clip-nya sudah hilang dibuang;
  //   2. primer selalu anggota himpunan (kalau himpunan tidak kosong);
  //   3. himpunan kosong + primer ada  → himpunan diisi primer. Aturan ketiga
  //      inilah yang membuat project LAMA (yang hanya menyimpan `selectedClipId`)
  //      langsung punya seleksi yang sah tanpa migrasi.
  const alive = new Set(s.lanes.flatMap((l) => l.clips.map((c) => c.id)));
  let ids = s.selectedClipIds.filter((id) => alive.has(id));
  const primary = clipOk ? s.selectedClipId : (ids[ids.length - 1] ?? null);
  if (primary !== null && !ids.includes(primary)) ids = [...ids, primary];
  if (primary === null) ids = [];
  const idsSame =
    ids.length === s.selectedClipIds.length && ids.every((id, i) => id === s.selectedClipIds[i]);
  // Loop yang clip-nya sudah dihapus harus mati DI SINI, bukan nanti di
  // pemutar: `buildProjectGraph` akan diam saja (tidak menemukan clip-nya),
  // sehingga transport berjalan tanpa suara dan tanpa ada yang menjelaskan.
  const loopOk = s.clipLoop === null || findClip(s.lanes, s.clipLoop.clipId) !== null;
  return {
    ...s,
    duration: farthest,
    contentEnd,
    panelOrder,
    railOrder,
    selectedLaneId: laneOk ? s.selectedLaneId : (s.lanes[0]?.id ?? null),
    selectedClipId: primary,
    // Array LAMA dikembalikan kalau isinya sama — selector berbasis referensi
    // tidak boleh ikut render ulang hanya karena state disentuh.
    selectedClipIds: idsSame ? s.selectedClipIds : ids,
    clipLoop: loopOk ? s.clipLoop : null,
  };
}

/**
 * Berlangganan satu irisan state. Lihat catatan stabilitas di kepala file.
 */
export function useStudio(): StudioAppState;
export function useStudio<T>(selector: (s: StudioAppState) => T): T;
export function useStudio<T>(selector?: (s: StudioAppState) => T): T | StudioAppState {
  // Tanpa selector = seluruh state. Bentuk ini dipakai `studio/rail` (agent
  // lain) lewat adapternya; aman karena `state` selalu referensi yang sama
  // selama tidak ada mutasi.
  const read = (): T | StudioAppState => (selector === undefined ? state : selector(state));
  return useSyncExternalStore(subscribe, read, read);
}

/** Akses langsung untuk kode non-React (handler pointer, tes). */
export const studioStore = { getState, subscribe };

// ── Helper mutasi lane ───────────────────────────────────────────────────────

function mapLane(
  s: StudioAppState,
  laneId: string,
  fn: (lane: StudioLane) => StudioLane,
): Partial<StudioAppState> {
  return { lanes: s.lanes.map((l) => (l.id === laneId ? fn(l) : l)) };
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter}`;
}

/**
 * Aturan UJUNG MATERI, satu tempat untuk kedua sumber waktu playhead
 * (`tick` dari jam dinding, `tickTo` dari jam audio): keduanya WAJIB berhenti
 * dan mengulang di titik yang sama, kalau tidak loop hanya bekerja di salah
 * satunya dan tidak ada yang memberi tahu yang mana.
 *
 * Audisi loop SENGAJA tidak muncul di sini. Ia pemutar terpisah dengan jamnya
 * sendiri; playhead timeline tidak boleh ikut terkurung di dua bar hanya karena
 * satu clip sedang didengarkan berulang.
 */
function advancePlayhead(s: StudioAppState, next: Samples): Partial<StudioAppState> | null {
  // Batas transport = ujung MATERI. Kalau belum ada clip sama sekali, pakai
  // `duration` supaya playhead tetap bisa bergerak di project kosong.
  const end = s.contentEnd > 0 ? s.contentEnd : s.duration;
  if (next < end) return { playhead: Math.max(0, next) };

  if (s.loop) {
    // `seekEpoch` WAJIB naik: itu satu-satunya sinyal yang membuat playback
    // menjadwalkan ulang voice dari posisi baru. Tanpa ini, playhead melompat
    // ke 0 tapi audionya tidak ikut mengulang — loop-nya cuma terlihat, tidak
    // terdengar.
    return { playhead: 0, seekEpoch: s.seekEpoch + 1 };
  }
  // Tanpa loop: berhenti tepat di ujung materi, jangan terus berjalan menembus
  // ekor kosong.
  return { playing: false, playhead: end, seekEpoch: s.seekEpoch + 1 };
}

// ── Aksi publik ──────────────────────────────────────────────────────────────

/**
 * Terapkan `edit` pada chain milik `target`, tanpa menyentuh yang lain.
 *
 * Satu tempat untuk ketiga target: kalau tiap aksi mengurai targetnya sendiri,
 * cabang `clip` akan terlewat di salah satunya dan efeknya menghilang tanpa
 * error.
 */
function editFxChain(
  s: StudioAppState,
  target: FxTarget,
  edit: (chain: FxInsert[]) => FxInsert[],
): Partial<StudioAppState> {
  if (target.kind === 'master') {
    return { masterChain: edit(s.masterChain) };
  }
  if (target.kind === 'lane') {
    return mapLane(s, target.id, (l) => ({ ...l, chain: edit(l.chain) }));
  }
  return {
    lanes: s.lanes.map((l) => ({
      ...l,
      clips: l.clips.map((c) => (c.id === target.id ? { ...c, chain: edit(c.chain) } : c)),
    })),
  };
}

export const studioActions = {
  undo(): boolean {
    const previous = undoStack.pop();
    if (previous === undefined) return false;
    redoStack.push(currentEntry());
    restoringHistory = true;
    restoreProject(previous);
    restoringHistory = false;
    dragHistoryRecorded = false;
    return true;
  },
  redo(): boolean {
    const next = redoStack.pop();
    if (next === undefined) return false;
    undoStack.push(currentEntry());
    restoringHistory = true;
    restoreProject(next);
    restoringHistory = false;
    dragHistoryRecorded = false;
    return true;
  },
  canUndo(): boolean {
    return undoStack.length > 0;
  },
  canRedo(): boolean {
    return redoStack.length > 0;
  },
  // — seleksi —
  selectLane(laneId: string): void {
    set(() => ({ selectedLaneId: laneId }));
  },
  /**
   * Pilih SATU clip, membuang seleksi sebelumnya. Ini yang dipakai klik biasa.
   */
  selectClip(clipId: string | null, laneId?: string): void {
    set((s) => ({
      selectedClipId: clipId,
      selectedClipIds: clipId === null ? [] : [clipId],
      selectedLaneId: laneId ?? s.selectedLaneId,
    }));
  },
  /**
   * Tambah/buang satu clip dari seleksi (Ctrl/Cmd/Shift-klik).
   *
   * Membuang clip PRIMER tidak mengosongkan seleksi: primer berpindah ke sisa
   * yang masih terpilih (lewat invarian di `withDerived`). Mengosongkannya akan
   * membuat Ctrl-klik pada satu clip di antara empat terasa seperti membatalkan
   * semuanya.
   */
  toggleClipSelection(clipId: string, laneId?: string): void {
    set((s) => {
      const has = s.selectedClipIds.includes(clipId);
      const ids = has
        ? s.selectedClipIds.filter((id) => id !== clipId)
        : [...s.selectedClipIds, clipId];
      return {
        selectedClipIds: ids,
        selectedClipId: has ? (s.selectedClipId === clipId ? null : s.selectedClipId) : clipId,
        selectedLaneId: laneId ?? s.selectedLaneId,
      };
    });
  },
  /**
   * Ganti seluruh seleksi sekaligus. Dipakai kotak seleksi (marquee), yang
   * menghitung ulang himpunannya di SETIAP gerakan pointer.
   *
   * Mengembalikan array LAMA kalau isinya sama — marquee memanggil ini puluhan
   * kali per detik, dan array baru tiap kali berarti seluruh timeline
   * digambar ulang tanpa ada yang berubah.
   */
  setSelectedClips(ids: readonly string[], primaryId?: string | null): void {
    set((s) => {
      const same =
        ids.length === s.selectedClipIds.length && ids.every((id, i) => id === s.selectedClipIds[i]);
      if (same) return null;
      const primary =
        primaryId !== undefined
          ? primaryId
          : ids.includes(s.selectedClipId ?? '')
            ? s.selectedClipId
            : (ids[ids.length - 1] ?? null);
      return { selectedClipIds: ids, selectedClipId: primary };
    });
  },
  clearClipSelection(): void {
    set((s) =>
      s.selectedClipIds.length === 0 && s.selectedClipId === null
        ? null
        : { selectedClipIds: [], selectedClipId: null },
    );
  },

  // — lane —
  addLane(): void {
    set((s) => ({
      lanes: [
        ...s.lanes,
        {
          id: nextId('lane-'),
          name: `LANE ${s.lanes.length + 1}`,
          color: LANE_COLORS[s.lanes.length % LANE_COLORS.length] ?? '#6f6a5e',
          mute: false,
          solo: false,
          gainDb: 0,
        speedRatio: 1,
          eq: defaultEq(),
          chain: [],
          clips: [],
        },
      ],
    }));
  },
  /**
   * Sisipkan lane-lane baru TEPAT di bawah `laneId`, urut sesuai input.
   *
   * Dipakai hasil pemisahan vokal (docs/26 §3a): dua lane (VOCALS, INST)
   * lahir dari satu clip sumber, dan yang paling sering diinginkan sesudahnya
   * adalah lane sumber diam — `muteSource`. Mute itu terjadi dalam mutasi yang
   * SAMA dengan penyisipan, jadi satu ⌘Z mengembalikan keduanya sekaligus;
   * kalau dua langkah, undo pertama hanya membunyikan lagi lane sumber di
   * atas dua stem yang masih ada, dan itu terdengar seperti bug.
   *
   * Id clip tidak diminta dari pemanggil: id-nya dari pembilang yang sama
   * dengan `newClipId`, supaya hasil job yang datang belakangan tidak bisa
   * bertabrakan dengan clip yang dibuat user sementara job berjalan.
   *
   * @returns id lane baru (urut sesuai input); `[]` kalau `laneId` tidak ada.
   */
  insertLanesBelow(
    laneId: string,
    lanes: readonly { name: string; color?: string; clips: readonly Omit<StudioClip, 'id'>[] }[],
    options?: { muteSource?: boolean },
  ): readonly string[] {
    const at = state.lanes.findIndex((l) => l.id === laneId);
    if (at < 0) return [];
    const inserted: StudioLane[] = lanes.map((lane, i) => ({
      id: nextId('lane-'),
      name: lane.name,
      // Palet berjalan dari jumlah lane SEKARANG, seperti `addLane` — lane
      // ke-n selalu dapat warna ke-n, dari mana pun ia datang.
      color: lane.color ?? LANE_COLORS[(state.lanes.length + i) % LANE_COLORS.length] ?? '#6f6a5e',
      mute: false,
      solo: false,
      gainDb: 0,
      speedRatio: 1,
      eq: defaultEq(),
      chain: [],
      clips: lane.clips
        .map((clip) => ({ ...clip, id: nextId('clip-') }))
        .sort((a, b) => a.start - b.start),
    }));
    const first = inserted[0];
    const firstClip = first?.clips[0];
    set((s) => {
      const next = s.lanes.map((l) =>
        options?.muteSource === true && l.id === laneId ? { ...l, mute: true } : l,
      );
      next.splice(at + 1, 0, ...inserted);
      return {
        lanes: next,
        ...(first === undefined
          ? {}
          : {
              selectedLaneId: first.id,
              selectedClipId: firstClip?.id ?? null,
              selectedClipIds: firstClip === undefined ? [] : [firstClip.id],
            }),
      };
    });
    return inserted.map((l) => l.id);
  },
  renameLane(laneId: string, name: string): void {
    set((s) => mapLane(s, laneId, (l) => ({ ...l, name })));
  },
  removeLane(laneId: string): void {
    set((s) => ({ lanes: s.lanes.filter((l) => l.id !== laneId) }));
  },
  toggleMute(laneId: string): void {
    set((s) => mapLane(s, laneId, (l) => ({ ...l, mute: !l.mute })));
  },
  toggleSolo(laneId: string): void {
    set((s) => mapLane(s, laneId, (l) => ({ ...l, solo: !l.solo })));
  },
  setLaneGain(laneId: string, gainDb: number): void {
    set((s) => mapLane(s, laneId, (l) => ({ ...l, gainDb })));
  },
  /** Warna lane (hex). Dipakai clip, waveform, dan chip di mixer. */
  setLaneColor(laneId: string, color: string): void {
    set((s) => mapLane(s, laneId, (l) => (l.color === color ? l : { ...l, color })));
  },

  /**
   * Tambah efek ke akhir chain sebuah target.
   *
   * `params` sengaja dibiarkan kosong: nilai yang tidak dikirim memakai default
   * KATALOG di sisi Rust. Menyalin seluruh default ke sini akan membekukan
   * angka yang seharusnya dimiliki deskriptor — dan begitu default di Rust
   * berubah, project lama tetap memakai salinan lamanya tanpa ada yang tahu.
   */
  addFx(target: FxTarget, kind: string): void {
    set((s) => editFxChain(s, target, (chain) => [...chain, { kind, enabled: true, params: {} }]));
  },

  removeFx(target: FxTarget, index: number): void {
    set((s) => editFxChain(s, target, (chain) => chain.filter((_, i) => i !== index)));
  },

  /** Pindahkan efek di dalam chain. Urutan efek mengubah suara, jadi ini bukan
   *  sekadar kosmetik. */
  moveFx(target: FxTarget, from: number, to: number): void {
    set((s) =>
      editFxChain(s, target, (chain) => {
        if (from === to || from < 0 || from >= chain.length || to < 0 || to >= chain.length) {
          return chain;
        }
        const next = [...chain];
        const [moved] = next.splice(from, 1);
        if (moved === undefined) return chain;
        next.splice(to, 0, moved);
        return next;
      }),
    );
  },

  setFxEnabled(target: FxTarget, index: number, enabled: boolean): void {
    set((s) =>
      editFxChain(s, target, (chain) =>
        chain.map((fx, i) => (i === index ? { ...fx, enabled } : fx)),
      ),
    );
  },

  setFxParam(target: FxTarget, index: number, param: string, value: number): void {
    set((s) =>
      editFxChain(s, target, (chain) =>
        chain.map((fx, i) =>
          i === index ? { ...fx, params: { ...fx.params, [param]: value } } : fx,
        ),
      ),
    );
  },

  setLaneEq(laneId: string, eq: EqSettings): void {
    set((s) => mapLane(s, laneId, (l) => ({ ...l, eq: cloneEq(eq) })));
  },
  /**
   * Ubah satu band EQ lane. Dipakai drag node di kurva, jadi dipanggil sangat
   * sering — karena itu hanya band yang tersentuh yang objeknya diganti.
   */
  setLaneEqBand(
    laneId: string,
    bandId: EqBandId,
    patch: { freq?: number; gainDb?: number; q?: number },
  ): void {
    set((s) =>
      mapLane(s, laneId, (l) => ({
        ...l,
        eq: {
          bands: l.eq.bands.map((b) => (b.id === bandId ? clampEqBand({ ...b, ...patch }) : b)),
        },
      })),
    );
  },

  // — clip —
  /**
   * Pindahkan clip dalam waktu dan/atau antar lane. `start` di-clamp ke
   * 0..(duration - len) seperti di design.
   */
  moveClip(clipId: string, start: Samples, toLaneIndex?: number): void {
    set((s) => {
      const from = s.lanes.findIndex((l) => l.clips.some((c) => c.id === clipId));
      if (from < 0) return null;
      const clip = s.lanes[from]?.clips.find((c) => c.id === clipId);
      if (clip === undefined) return null;
      const to = Math.max(0, Math.min(s.lanes.length - 1, toLaneIndex ?? from));
      // TIDAK dibatasi oleh `duration`: menggeser ke kanan justru yang membuat
      // timeline memanjang (lihat withDerived). Membatasinya di sini berarti
      // panjang timeline tidak akan pernah bertambah.
      const moved: StudioClip = { ...clip, start: Math.max(0, Math.round(start)) };
      const lanes = s.lanes.map((l, i) => {
        let clips = l.clips.filter((c) => c.id !== clipId);
        if (i === to) clips = [...clips, moved].sort((a, b) => a.start - b.start);
        return clips === l.clips ? l : { ...l, clips };
      });
      return { lanes, selectedLaneId: s.lanes[to]?.id ?? s.selectedLaneId };
    });
  },
  /**
   * Geser BANYAK clip sekaligus dengan satu selisih.
   *
   * `origins` = posisi saat drag DIMULAI, bukan posisi sekarang. Menggeser
   * relatif terhadap posisi sekarang akan menumpuk galat pembulatan di setiap
   * `pointermove`, dan setelah beberapa detik menyeret, jarak antar clip yang
   * seharusnya tetap sudah tidak sama lagi.
   *
   * Selisihnya di-CLAMP satu kali untuk seluruh rombongan, bukan per clip:
   * kalau tiap clip dibatasi sendiri-sendiri, clip yang menabrak batas kiri
   * akan berhenti sementara yang lain terus jalan — dan susunan yang sedang
   * dipindahkan berubah bentuk di tangan user.
   */
  moveClips(origins: readonly ClipOrigin[], deltaSamples: number, deltaLanes: number): void {
    set((s) => {
      if (origins.length === 0) return null;
      const lastLane = s.lanes.length - 1;
      let dx = Math.round(deltaSamples);
      let dl = Math.round(deltaLanes);
      for (const o of origins) {
        dx = Math.max(dx, -o.start);
        dl = Math.max(dl, -o.laneIndex);
        dl = Math.min(dl, lastLane - o.laneIndex);
      }

      const moving = new Map(origins.map((o) => [o.id, o]));
      const target = new Map<number, StudioClip[]>();
      const lanes = s.lanes.map((lane) => {
        const kept = lane.clips.filter((c) => !moving.has(c.id));
        return kept.length === lane.clips.length ? lane : { ...lane, clips: kept };
      });
      for (const lane of s.lanes) {
        for (const clip of lane.clips) {
          const o = moving.get(clip.id);
          if (o === undefined) continue;
          const to = o.laneIndex + dl;
          const list = target.get(to) ?? [];
          list.push({ ...clip, start: Math.max(0, o.start + dx) });
          target.set(to, list);
        }
      }
      if (target.size === 0) return null;

      const next = lanes.map((lane, i) => {
        const incoming = target.get(i);
        if (incoming === undefined) return lane;
        return { ...lane, clips: [...lane.clips, ...incoming].sort((a, b) => a.start - b.start) };
      });
      return { lanes: next };
    });
  },
  /**
   * Tarik salah satu TEPI clip. Non-destruktif: yang berubah hanya jendela ke
   * dalam materi, bukan materinya.
   *
   * Absolut (`at` = posisi timeline tujuan), bukan berbasis selisih — jadi
   * memanggilnya berkali-kali selama tarikan tidak menumpuk galat. Yang butuh
   * titik awal justru `slipClip`, dan hanya itu.
   */
  trimClip(clipId: string, edge: 'left' | 'right', at: Samples): void {
    set((s) => {
      const hit = findClip(s.lanes, clipId);
      if (hit === null) return null;
      const { lane, clip } = hit;
      const frames = assetStore.getState().assets[clip.assetId]?.frames;
      const next =
        edge === 'right'
          ? trimRight(clip, lane.speedRatio, at, frames)
          : trimLeft(clip, lane.speedRatio, at);
      if (next === clip) return null;
      return {
        lanes: s.lanes.map((l) =>
          l.id === lane.id
            ? { ...l, clips: l.clips.map((c) => (c.id === clipId ? next : c)) }
            : l,
        ),
      };
    });
  },
  /** Geser materi di dalam clip tanpa memindahkan clip-nya (Alt-drag). */
  slipClip(clipId: string, originSourceStart: Samples, deltaSource: number): void {
    set((s) => {
      const hit = findClip(s.lanes, clipId);
      if (hit === null) return null;
      const { lane, clip } = hit;
      const next = slipClip(clip, originSourceStart, deltaSource, assetStore.getState().assets[clip.assetId]?.frames);
      if (next === clip) return null;
      return {
        lanes: s.lanes.map((l) =>
          l.id === lane.id
            ? { ...l, clips: l.clips.map((c) => (c.id === clipId ? next : c)) }
            : l,
        ),
      };
    });
  },
  updateClip(clipId: string, patch: Partial<StudioClip>): void {
    set((s) => ({
      lanes: s.lanes.map((l) => ({
        ...l,
        clips: l.clips.map((c) => (c.id === clipId ? { ...c, ...patch, id: c.id } : c)),
      })),
    }));
  },
  /**
   * Ubah pembuangan stem sebuah clip. Selalu lewat `normalizeClipStem`, jadi
   * nilai yang setara bypass benar-benar HILANG dari clip — bukan tersimpan
   * sebagai `{vocal:1,bass:1,other:1}` yang membuat `mixFingerprint` melihat
   * perubahan palsu dan menjadwalkan ulang audio tanpa alasan.
   */
  setClipStem(clipId: string, patch: Partial<StemMix>): void {
    set((s) => {
      const hit = findClip(s.lanes, clipId);
      if (hit === null) return null;
      const next = normalizeClipStem({
        ...hit.clip,
        stem: clampStemMix({ ...(hit.clip.stem ?? STEM_BYPASS), ...patch }),
      });
      if (next === hit.clip) return null;
      return {
        lanes: s.lanes.map((l) =>
          l.id === hit.lane.id
            ? { ...l, clips: l.clips.map((c) => (c.id === clipId ? next : c)) }
            : l,
        ),
      };
    });
  },
  removeClip(clipId: string): void {
    set((s) => ({
      lanes: s.lanes.map((l) => ({ ...l, clips: l.clips.filter((c) => c.id !== clipId) })),
    }));
  },
  /** Belah clip terpilih di playhead. Tidak melakukan apa-apa kalau di luar clip. */
  splitClipAtPlayhead(clipId: string): void {
    studioActions.splitClipAt(clipId, getState().playhead);
  },
  /**
   * Belah clip di posisi TIMELINE mana pun. Dipisah dari versi playhead supaya
   * pemanggil yang sudah menyesuaikan posisinya (mis. SPLIT yang menempel ke
   * grid ketukan) tidak perlu memindahkan playhead user lebih dulu hanya untuk
   * bisa memotong.
   */
  splitClipAt(clipId: string, at: Samples): void {
    set((s) => {
      const hit = findClip(s.lanes, clipId);
      if (hit === null) return null;
      const { clip } = hit;
      const cut = Math.round(at) - clip.start;
      if (cut <= 0 || cut >= clip.len) return null;
      // Potongan diukur di TIMELINE-space, lalu dikonversi ke SOURCE-space
      // dengan ratio. Tanpa konversi ini, memotong clip yang di-speed-up akan
      // mengambil bagian source yang salah (docs/07 §8d: dua koordinat space).
      const cutSource = Math.round(cut * hit.lane.speedRatio);
      const left: StudioClip = { ...clip, len: cut, sourceLen: cutSource };
      // CLIP YANG LOOP: kedua belahan tetap memutar REGION YANG SAMA.
      //
      // Belahan kanan TIDAK memajukan `sourceStart` seperti clip biasa. Untuk
      // clip lurus, memajukannya adalah satu-satunya cara agar materi
      // menyambung; untuk clip yang loop ia justru memindahkan region ke materi
      // yang bukan bagian dari loop — dua belahan dari satu loop akan memutar
      // dua hal yang berbeda. Yang terjadi sekarang: putaran mulai lagi dari
      // awalnya di titik potong. Itu lompatan fase yang bisa didengar, tapi
      // tetap materi yang sama, dan itulah yang bisa dijelaskan ke user.
      const looped = activeLoopLen(clip) !== null;
      const right: StudioClip = {
        ...clip,
        id: nextId('clip-'),
        start: clip.start + cut,
        len: clip.len - cut,
        sourceStart: looped ? clip.sourceStart : clip.sourceStart + cutSource,
        sourceLen: clip.sourceLen - cutSource,
        seed: clip.seed + 7,
      };
      return {
        lanes: s.lanes.map((l) =>
          l.id === hit.lane.id
            ? { ...l, clips: l.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])) }
            : l,
        ),
      };
    });
  },
  /**
   * Mulai audisi: putar region ini berulang, di pemutarnya SENDIRI.
   *
   * TIDAK menyentuh transport sama sekali — tidak memindahkan playhead, tidak
   * menyalakan/mematikan play. Itu perbaikan atas versi pertama, yang membajak
   * transport dan karenanya menghentikan lagu di lane lain hanya karena user
   * ingin mendengar dua bar dari satu clip. Audisi adalah pemutar kedua yang
   * berjalan berdampingan dengan timeline; lihat `startAudition` di
   * `preview/audio-preview.ts`.
   *
   * Clip yang sedang diaudisi dibisukan di mix utama (`skipClipId` di
   * `graph-builder`), supaya ia tidak terdengar dua kali dari dua tempat.
   */
  startClipLoop(clipId: string, sourceStart: Samples, sourceLen: Samples): void {
    set((s) => {
      if (findClip(s.lanes, clipId) === null || sourceLen <= 0) return null;
      return {
        clipLoop: {
          clipId,
          sourceStart: Math.round(sourceStart),
          sourceLen: Math.round(sourceLen),
        },
      };
    });
  },
  /** Akhiri audisi. Transport tidak disentuh — ia memang tidak pernah ikut. */
  stopClipLoop(): void {
    set((s) => (s.clipLoop === null ? null : { clipLoop: null }));
  },
  /** Pindahkan region audisi tanpa menghentikan bunyinya. */
  moveClipLoop(sourceStart: Samples, sourceLen: Samples): void {
    set((s) => {
      const cl = s.clipLoop;
      if (cl === null || sourceLen <= 0) return null;
      const next: ClipLoop = {
        ...cl,
        sourceStart: Math.round(sourceStart),
        sourceLen: Math.round(sourceLen),
      };
      if (next.sourceStart === cl.sourceStart && next.sourceLen === cl.sourceLen) return null;
      return { clipLoop: next };
    });
  },
  /**
   * Potong clip jadi region loop dan ulangi. Aritmetikanya ada di
   * `timeline/beat-cut.ts` — di sini hanya penggantian isi lane, supaya bagian
   * yang bisa salah diam-diam tetap bisa dites tanpa store.
   */
  beatLoopCut(clipId: string, spec: LoopCutSpec): void {
    set((s) => {
      const hit = findClip(s.lanes, clipId);
      if (hit === null) return null;
      const cut = applyLoopCut(hit.lane, hit.clip, spec, () => nextId('clip-'), s.sampleRate);
      if (cut.length === 0) return null;
      return {
        // Audisi dimatikan: region-nya baru saja MENJADI clip-nya. Membiarkannya
        // hidup berarti loop menunjuk potongan source yang sekarang berarti
        // lain, dan yang terdengar berhenti cocok dengan yang terlihat.
        clipLoop: null,
        lanes: s.lanes.map((l) =>
          l.id === hit.lane.id
            ? {
                ...l,
                clips: l.clips
                  .flatMap((c) => (c.id === clipId ? cut : [c]))
                  .sort((a, b) => a.start - b.start),
              }
            : l,
        ),
      };
    });
  },
  /**
   * PASANG LOOP KE CLIP — region ini diputar berulang SEPANJANG clip, tanpa
   * memotong apa pun.
   *
   * Perbedaannya dengan `beatLoopCut` adalah perbedaan yang diminta user:
   * timeline tidak bertambah satu objek pun, posisi & panjang clip tetap, dan
   * membatalkannya cukup satu klik (`removeClipLoopRegion`). Yang berubah hanya
   * cara materi clip dibaca — melingkar, bukan lurus.
   *
   * Audisi TIDAK dimatikan (beda dengan LOOP CUT): region yang diaudisi persis
   * region yang baru saja dipasang, jadi yang terdengar tetap cocok dengan yang
   * terlihat. LOOP CUT harus mematikannya karena di sana source clip-nya benar-
   * benar berganti arti.
   */
  setClipLoopRegion(clipId: string, region: { sourceStart: Samples; sourceLen: Samples }): void {
    set((s) => {
      const hit = findClip(s.lanes, clipId);
      if (hit === null || !(region.sourceLen >= MIN_LOOP_LEN)) return null;
      const next = applyClipLoop(hit.clip, region, s.sampleRate);
      return {
        lanes: s.lanes.map((l) =>
          l.id === hit.lane.id
            ? { ...l, clips: l.clips.map((c) => (c.id === clipId ? next : c)) }
            : l,
        ),
      };
    });
  },
  /**
   * Lepaskan loop; clip kembali diputar lurus.
   *
   * Jendelanya ikut dipangkas ke ujung materi kalau perlu. Wajib: clip yang
   * loop boleh lebih panjang dari file-nya (pengulangan yang mengisi), dan
   * membiarkan panjang itu setelah loop dilepas membuat `src.start()` melempar
   * — `graph-builder` menangkapnya dan MELEWATI clip, jadi gejalanya bukan
   * error melainkan clip yang terlihat ada tapi bisu.
   */
  removeClipLoopRegion(clipId: string): void {
    set((s) => {
      const hit = findClip(s.lanes, clipId);
      if (hit === null || hit.clip.loopLen === undefined) return null;
      const bare = clearClipLoop(hit.clip);
      const frames = assetStore.getState().assets[bare.assetId]?.frames;
      const room = frames === undefined ? bare.sourceLen : Math.max(1, frames - bare.sourceStart);
      const sourceLen = Math.min(bare.sourceLen, room);
      const next: StudioClip =
        sourceLen === bare.sourceLen
          ? bare
          : { ...bare, sourceLen, len: timelineLenFor(sourceLen, hit.lane.speedRatio) };
      return {
        lanes: s.lanes.map((l) =>
          l.id === hit.lane.id
            ? { ...l, clips: l.clips.map((c) => (c.id === clipId ? next : c)) }
            : l,
        ),
      };
    });
  },
  /** Tambah clip baru (dipakai jalur drag & drop file). */
  addClip(laneId: string, clip: StudioClip): void {
    set((s) => ({
      ...mapLane(s, laneId, (l) => ({
        ...l,
        clips: [...l.clips, clip].sort((a, b) => a.start - b.start),
      })),
      selectedClipId: clip.id,
      selectedClipIds: [clip.id],
      selectedLaneId: laneId,
    }));
  },
  /** Batas panjang timeline manual. `max === null` = kembali otomatis. */
  /**
   * Ganti seluruh isi project dari data tersimpan.
   *
   * Field transien SENGAJA tidak diterima: `playing` selalu dimulai false, dan
   * clipboard/drag/progress export tidak punya arti setelah refresh.
   */
  hydrate(data: Partial<StudioAppState>): void {
    // Field bernilai `undefined` DIBUANG, bukan diteruskan. Objek hasil
    // deserialisasi versi lama tidak punya semua field, dan `{...state,
    // ...data}` dengan `key: undefined` akan menghapus default yang sah —
    // gejalanya crash jauh di komponen, bukan di sini.
    const clean = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined),
    ) as Partial<StudioAppState>;
    undoStack.length = 0;
    redoStack.length = 0;
    restoringHistory = true;
    set((s) => ({
      ...clean,
      playing: false,
      scrubbing: false,
      draggingClip: false,
      exportProgress: null,
      importJobs: [],
      seekEpoch: 0,
      // Project yang baru dibuka dari data tersimpan itu BERSIH menurut
      // definisi. `restoringHistory` di atas menjamin `set` tidak menaikkan
      // serialnya, jadi menyamakan keduanya di sini cukup.
      projectSerial: s.projectSerial,
      savedSerial: s.projectSerial,
    }));
    restoringHistory = false;
  },
  /**
   * Tandai karya SAAT INI (atau saat `serial` diambil) sudah tersimpan.
   *
   * Pemanggil yang menyimpan secara asinkron harus membaca `projectSerial`
   * SEBELUM menyerialisasi, lalu menyerahkannya ke sini sesudah server
   * menjawab — edit yang terjadi di antaranya tetap terhitung belum tersimpan.
   */
  markSaved(serial?: number): void {
    set((s) => {
      const saved = serial ?? s.projectSerial;
      return s.savedSerial === saved ? null : { savedSerial: saved };
    });
  },

  /**
   * Pindahkan panel ke indeks baru; indeks di luar rentang di-clamp.
   *
   * Tumpukan asalnya ditentukan dari isi daftar, bukan dari argumen — panel
   * tidak bisa berpindah antar kolom, dan pemanggil tidak perlu tahu ia ada
   * di mana.
   */
  movePanel(id: PanelId, toIndex: number): void {
    set((s) => {
      const key = s.panelOrder.includes(id)
        ? ('panelOrder' as const)
        : s.railOrder.includes(id)
          ? ('railOrder' as const)
          : null;
      if (key === null) return null;
      const list = s[key];
      const from = list.indexOf(id);
      const to = Math.max(0, Math.min(list.length - 1, toIndex));
      if (to === from) return null;
      const next = [...list];
      next.splice(from, 1);
      next.splice(to, 0, id);
      return { [key]: next } as Partial<StudioAppState>;
    });
  },

  setMasterGain(db: number): void {
    set(() => ({
      masterGainDb: Math.max(MIN_MASTER_GAIN_DB, Math.min(MAX_MASTER_GAIN_DB, db)),
    }));
  },
  setRenderSpeed(v: number): void {
    set(() => ({ renderSpeed: Math.max(MIN_RENDER_SPEED, Math.min(MAX_RENDER_SPEED, v)) }));
  },
  setExportFileName(name: string): void {
    set(() => ({ exportFileName: name }));
  },

  /** Bentangkan panel, atau kembalikan kalau panel yang sama ditekan lagi. */
  toggleMaximize(id: PanelId): void {
    set((s) => ({ maximizedPanel: s.maximizedPanel === id ? null : id }));
  },
  clearMaximize(): void {
    set((s) => (s.maximizedPanel === null ? null : { maximizedPanel: null }));
  },

  setEqMode(mode: EqMode): void {
    set((s) => (s.eqMode === mode ? null : { eqMode: mode }));
  },

  setDurationBounds(minSec: number, maxSec: number | null): void {
    set(() => ({
      minDurationSec: Math.max(1, Math.round(minSec)),
      maxDurationSec: maxSec === null ? null : Math.max(1, Math.round(maxSec)),
    }));
  },

  /**
   * Kecepatan lane. Panjang timeline SEMUA clip di lane ikut dihitung ulang
   * (`sourceLen / ratio`), sedangkan region source yang dipakai TIDAK berubah —
   * itu inti non-destruktif: bolak-balik mengubah speed tidak kehilangan materi.
   *
   * Posisi `start` sengaja TIDAK diskalakan; lihat catatan di StudioLane.
   */
  setLaneSpeed(laneId: string, ratio: number): void {
    set((s) => {
      const lane = s.lanes.find((l) => l.id === laneId);
      if (lane === undefined) return null;
      const clamped = Math.max(MIN_LANE_SPEED, Math.min(MAX_LANE_SPEED, ratio));
      if (clamped === lane.speedRatio) return null;
      return {
        lanes: s.lanes.map((l) =>
          l.id === laneId
            ? {
                ...l,
                speedRatio: clamped,
                clips: l.clips.map((c) => ({ ...c, len: timelineLenFor(c.sourceLen, clamped) })),
              }
            : l,
        ),
      };
    });
  },

  /**
   * Samakan tempo selected/target clip dengan reference. Untuk beat/bar,
   * clip target juga digeser agar marker grid terdekat bertemu. Seluruh
   * perubahan dilakukan dalam satu `set`, sehingga Undo juga satu langkah.
   */
  syncClipTo(targetClipId: string, referenceClipId: string, alignment: SyncAlignment): void {
    set((s) => {
      const target = findClip(s.lanes, targetClipId);
      const reference = findClip(s.lanes, referenceClipId);
      if (target === null || reference === null || target.lane.id === reference.lane.id) return null;
      const assets = assetStore.getState().assets;
      const targetAsset = assets[target.clip.assetId];
      const referenceAsset = assets[reference.clip.assetId];
      if (targetAsset === undefined || referenceAsset === undefined) return null;

      const result = computeClipSync({
        targetClip: target.clip,
        targetLane: target.lane,
        targetAsset,
        referenceClip: reference.clip,
        referenceLane: reference.lane,
        referenceAsset,
        playhead: s.playhead,
        sampleRate: s.sampleRate,
        alignment,
      });
      if (result === null) return null;
      const speed = Math.max(MIN_LANE_SPEED, Math.min(MAX_LANE_SPEED, result.laneSpeedRatio));

      return {
        lanes: s.lanes.map((lane) => {
          if (lane.id !== target.lane.id) return lane;
          const clips = lane.clips
            .map((clip) => ({
              ...clip,
              start: clip.id === targetClipId ? result.targetStart : clip.start,
              len: timelineLenFor(clip.sourceLen, speed),
            }))
            .sort((a, b) => a.start - b.start);
          return { ...lane, speedRatio: speed, clips };
        }),
      };
    });
  },

  setClipDragging(dragging: boolean): void {
    if (dragging) dragHistoryRecorded = false;
    set((s) => (s.draggingClip === dragging ? null : { draggingClip: dragging }));
    if (!dragging) dragHistoryRecorded = false;
  },

  /**
   * COPY seluruh clip terpilih. PCM tidak ikut — asset tetap dibagi.
   *
   * Yang disimpan bukan posisi absolutnya melainkan SELISIH terhadap clip
   * paling kiri, supaya paste di tempat lain tetap menghasilkan susunan yang
   * sama persis, termasuk jaraknya antar lane.
   */
  copySelectedClip(): void {
    set((s) => {
      const picked: { clip: StudioClip; laneIndex: number }[] = [];
      s.lanes.forEach((lane, laneIndex) => {
        for (const clip of lane.clips) {
          if (s.selectedClipIds.includes(clip.id)) picked.push({ clip, laneIndex });
        }
      });
      if (picked.length === 0) return null;
      picked.sort((a, b) => a.clip.start - b.clip.start || a.laneIndex - b.laneIndex);
      const base = picked[0]!;
      return {
        clipboard: picked.map((p) => ({
          clip: { ...p.clip },
          laneOffset: p.laneIndex - base.laneIndex,
          startOffset: p.clip.start - base.clip.start,
        })),
      };
    });
  },

  /**
   * PASTE di playhead, pada lane terpilih (atau lane asal kalau tidak ada).
   * Clip baru memakai `assetId` yang sama — inilah gunanya model
   * non-destruktif: menyalin clip tidak menyalin PCM sama sekali.
   */
  pasteClipboard(): void {
    set((s) => {
      const src = s.clipboard;
      if (src === null || src.length === 0) return null;
      const baseLane = s.lanes.findIndex((l) => l.id === s.selectedLaneId);
      const from = baseLane < 0 ? 0 : baseLane;
      const at = Math.max(0, s.playhead);

      const added = new Map<number, StudioClip[]>();
      const ids: string[] = [];
      for (const entry of src) {
        // Lane di luar jangkauan DIJEPIT, bukan dilewati: menyalin dua lane ke
        // lane terakhir lebih baik daripada diam-diam kehilangan separuh materi.
        const laneIndex = Math.max(0, Math.min(s.lanes.length - 1, from + entry.laneOffset));
        const copy: StudioClip = {
          ...entry.clip,
          id: nextId('clip-'),
          start: at + entry.startOffset,
        };
        ids.push(copy.id);
        const list = added.get(laneIndex) ?? [];
        list.push(copy);
        added.set(laneIndex, list);
      }
      if (ids.length === 0) return null;

      return {
        lanes: s.lanes.map((lane, i) => {
          const incoming = added.get(i);
          if (incoming === undefined) return lane;
          return { ...lane, clips: [...lane.clips, ...incoming].sort((a, b) => a.start - b.start) };
        }),
        selectedClipIds: ids,
        selectedClipId: ids[ids.length - 1] ?? null,
        selectedLaneId: s.lanes[from]?.id ?? s.selectedLaneId,
      };
    });
  },

  /** DELETE seluruh clip terpilih. */
  deleteSelectedClip(): void {
    set((s) => {
      const doomed = new Set(s.selectedClipIds);
      if (doomed.size === 0) return null;
      return {
        lanes: s.lanes.map((l) => {
          const clips = l.clips.filter((c) => !doomed.has(c.id));
          return clips.length === l.clips.length ? l : { ...l, clips };
        }),
        selectedClipIds: [],
        selectedClipId: null,
      };
    });
  },

  newClipId(): string {
    return nextId('clip-');
  },
  /**
   * Id job import. Cukup unik dalam satu sesi — job tidak pernah disimpan
   * maupun dikirim ke engine, jadi ia tidak punya syarat rentang seperti
   * `newAssetId`.
   */
  newImportId(): string {
    return nextId('import-');
  },
  /** Daftarkan satu import yang baru mulai. Tahap awalnya selalu `reading`. */
  beginImport(job: { id: string; laneId: string | null; name: string }): void {
    set((s) => ({
      importJobs: [...s.importJobs, { ...job, stage: 'reading' as const, ratio: 0 }],
    }));
  },
  /**
   * Perbarui tahap/rasio satu job. Job yang sudah selesai diabaikan diam-diam:
   * callback progres bisa datang terlambat (mis. pembacaan chunk terakhir
   * beriringan dengan `endImport`), dan menghidupkannya kembali akan membuat
   * bar muncul lagi setelah clip-nya sudah ada di layar.
   */
  setImportStage(id: string, stage: ImportStage, ratio: number | null): void {
    set((s) => {
      const cur = s.importJobs.find((j) => j.id === id);
      if (cur === undefined) return {};
      if (cur.stage === stage && cur.ratio === ratio) return {};
      return {
        importJobs: s.importJobs.map((j) => (j.id === id ? { ...j, stage, ratio } : j)),
      };
    });
  },
  /** Job selesai (berhasil ATAU gagal). Dipanggil dari `finally`. */
  endImport(id: string): void {
    set((s) => {
      if (!s.importJobs.some((j) => j.id === id)) return {};
      return { importJobs: s.importJobs.filter((j) => j.id !== id) };
    });
  },

  // — transport —
  togglePlay(): void {
    set((s) => ({ playing: !s.playing }));
  },
  setPlaying(playing: boolean): void {
    set(() => ({ playing }));
  },
  setPlayhead(samples: Samples): void {
    set((s) => ({
      playhead: Math.max(0, Math.min(s.duration, Math.round(samples))),
      seekEpoch: s.seekEpoch + 1,
    }));
  },
  /** Mulai men-drag playhead. Lihat `scrubbing` di StudioAppState. */
  beginScrub(): void {
    set(() => ({ scrubbing: true }));
  },
  endScrub(): void {
    set((s) => (s.scrubbing ? { scrubbing: false, seekEpoch: s.seekEpoch + 1 } : null));
  },
  nudgePlayhead(seconds: number): void {
    set((s) => ({
      playhead: Math.max(
        0,
        Math.min(s.duration, s.playhead + secToSamples(seconds, s.sampleRate)),
      ),
      seekEpoch: s.seekEpoch + 1,
    }));
  },
  setSpeed(speed: Speed): void {
    set(() => ({ speed }));
  },
  /**
   * Majukan playhead sebesar `dtMs` waktu dinding — CADANGAN untuk saat tidak
   * ada audio yang berbunyi (mode UI-only, AudioContext belum ada). Selama tidak
   * ada suara, playhead adalah satu-satunya jam yang ada dan tidak ada apa pun
   * yang bisa ia dahului atau tinggalkan.
   *
   * Saat audio BERBUNYI yang dipakai `tickTo` — lihat catatannya di bawah.
   */
  tick(dtMs: number): void {
    set((s) => {
      if (!s.playing) return null;
      // Selama playhead di-drag, TANGAN yang memegang posisi. Kalau tick tetap
      // memajukannya, tiap 60 ms playhead melompat ke depan lalu ditarik balik
      // oleh `pointermove` berikutnya — dan yang terdengar dari pemutar scrub
      // adalah butiran yang loncat-loncat, bukan gerakan tangan.
      if (s.scrubbing) return null;
      return advancePlayhead(s, s.playhead + secToSamples((dtMs / 1000) * s.speed, s.sampleRate));
    });
  },
  /**
   * Setel playhead ke posisi ABSOLUT (detik timeline) yang dilaporkan JAM AUDIO.
   *
   * Absolut, bukan delta, dan itu seluruh intinya. Menjumlahkan delta 60 ms per
   * tick tidak pernah sama dengan waktu yang benar-benar berjalan: `setInterval`
   * menghitung periodenya ulang SETELAH callback selesai (jadi tiap tick memakan
   * 60 ms + waktu render), dan tab yang tidak aktif dicekik sampai 1×/detik.
   * Galatnya searah dan menumpuk, sehingga garis playhead makin lama makin
   * tertinggal dari yang keluar dari speaker — sampai lagunya habis sementara
   * garisnya masih di tengah. Dengan posisi absolut, tick yang terlambat hanya
   * berarti gambarnya diperbarui lebih jarang; posisinya tetap benar.
   *
   * Sumber angkanya `preview/audio-preview.previewPositionSec()` — jam yang SAMA
   * dengan yang memutar sample-nya, dan sama dengan yang sudah dipakai waveform
   * geser (`timeline/LaneHeaders`) serta kedip beat (`timeline/beat-pulse`).
   * Sebelum ini keduanya berjalan di jam yang berbeda dari playhead, dan bedanya
   * kelihatan di layar.
   */
  tickTo(timelineSec: number): void {
    set((s) => {
      if (!s.playing) return null;
      // Alasan yang sama dengan `tick`: selama scrub, TANGAN yang memegang
      // posisi. Mix-nya pun sudah dihentikan (lihat `usePreviewPlayback`).
      if (s.scrubbing) return null;
      return advancePlayhead(s, secToSamples(timelineSec, s.sampleRate));
    });
  },

  toggleLoop(): void {
    set((s) => ({ loop: !s.loop }));
  },

  // — zoom —
  /** `pxPerSecond = null` berarti mode FIT. */
  setZoom(pxPerSecond: number | null): void {
    set(() => ({
      pxPerSecond:
        pxPerSecond === null || !Number.isFinite(pxPerSecond)
          ? null
          : Math.max(2, Math.min(400, pxPerSecond)),
    }));
  },

  // — rail —
  setTab(tab: RailTab): void {
    set(() => ({ tab }));
  },
  setFormat(format: ExportFormat): void {
    set(() => ({ format }));
  },
  setPreset(preset: EqPreset): void {
    set(() => ({ preset }));
  },
  /**
   * Preset EQ = pilih preset DAN terapkan nilainya ke lane terpilih. Rail
   * memanggil nama ini (lihat `rail/store-adapter.ts`).
   */
  setEqPreset(preset: EqPreset): void {
    set((s) => ({
      preset,
      lanes: s.lanes.map((l) =>
        l.id === s.selectedLaneId ? { ...l, eq: cloneEq(EQ_PRESETS[preset]) } : l,
      ),
    }));
  },
  /** Alias yang dipakai rail untuk skip ±5 detik. */
  seekBySeconds(delta: number): void {
    studioActions.nudgePlayhead(delta);
  },
  /** Alias yang dipakai rail untuk fader lane. */
  setLaneGainDb(laneId: string, gainDb: number): void {
    studioActions.setLaneGain(laneId, gainDb);
  },
  setExportProgress(progress: number | null): void {
    set(() => ({ exportProgress: progress }));
  },
  /** Buka menu ini, atau tutup kalau ia yang sedang terbuka. */
  toggleMenu(id: MenuId): void {
    set((s) => ({ openMenu: s.openMenu === id ? null : id }));
  },
  closeMenu(): void {
    set((s) => (s.openMenu === null ? null : { openMenu: null }));
  },
  toggleSnap(): void {
    set((s) => ({ snapEnabled: !s.snapEnabled }));
  },
  setLaneHeight(id: LaneHeightId): void {
    set((s) => (s.laneHeight === id ? null : { laneHeight: id }));
  },
  setEngineStatus(ready: boolean, error: string | null): void {
    set(() => ({ engineReady: ready, engineError: error }));
  },

  /**
   * Hanya untuk tes. `seed: 'demo'` (default) memberi clip mock supaya tes
   * punya materi untuk diutak-atik; `'empty'` memakai state awal aplikasi
   * yang sebenarnya — satu lane kosong.
   */
  __resetForTest(seed: 'demo' | 'empty' = 'demo'): void {
    undoStack.length = 0;
    redoStack.length = 0;
    dragHistoryRecorded = false;
    // Registry aset ikut dikosongkan — di bawah `restoringHistory` supaya
    // pengosongan itu tidak tercatat sebagai edit pada state yang justru
    // sedang direset.
    restoringHistory = true;
    assetActions.__resetForTest();
    restoringHistory = false;
    state = withDerived({
      ...(seed === 'empty' ? createInitialStudio() : createDemoStudio()),
      importJobs: [],
      engineReady: false,
      engineError: null,
      seekEpoch: 0,
      scrubbing: false,
      draggingClip: false,
      clipboard: null,
      selectedClipIds: [],
      loop: true,
      clipLoop: null,
      contentEnd: 0,
      panelOrder: DEFAULT_PANEL_ORDER,
      railOrder: DEFAULT_RAIL_ORDER,
      maximizedPanel: null,
      eqMode: 'curve',
          laneHeight: DEFAULT_LANE_HEIGHT,
      openMenu: null,
      snapEnabled: true,
      minDurationSec: MIN_DURATION_SEC,
      maxDurationSec: null,
      projectSerial: 0,
      savedSerial: 0,
    });
    for (const fn of [...listeners]) fn();
  },
};

/**
 * True kalau ada perubahan karya yang belum disimpan.
 *
 * Primitif, jadi aman dipakai langsung sebagai selector `useStudio`. Dipakai
 * judul jendela (tanda `•`) dan penjaga tutup jendela di `app-shell`.
 */
export function selectProjectDirty(s: StudioAppState): boolean {
  return s.projectSerial !== s.savedSerial;
}

// ── Selector siap pakai (stabil secara referensi) ────────────────────────────

/**
 * Berapa clip yang memakai sebuah asset, dan di lane mana saja.
 *
 * Ada supaya penghapusan bisa MENOLAK dengan alasan alih-alih meninggalkan
 * clip yang menunjuk asset hantu. Clip seperti itu tidak melempar — ia hanya
 * menggambar placeholder dan diam saat diputar, dan penyebabnya terjadi di
 * halaman lain beberapa menit sebelumnya.
 *
 * Yang bertanya (`/dj`) tidak tahu lane, jadi jawabannya DIDAFTARKAN ke
 * `assets/usage.ts` core saat modul ini dimuat — lihat di bawah.
 */
export function laneAssetUsage(s: StudioAppState, id: number): AssetUsage {
  const where: string[] = [];
  let count = 0;
  for (const lane of s.lanes) {
    const n = lane.clips.filter((c) => c.assetId === id).length;
    if (n === 0) continue;
    count += n;
    where.push(lane.name);
  }
  return { count, where };
}

registerAssetUsage((id) => laneAssetUsage(state, id));

export const selectLanes = (s: StudioAppState): readonly StudioLane[] => s.lanes;
export const selectDurationSec = (s: StudioAppState): number =>
  samplesToSec(s.duration, s.sampleRate);
export const selectClipCount = (s: StudioAppState): number =>
  s.lanes.reduce((a, l) => a + l.clips.length, 0);
