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
import { MIN_MASTER_GAIN_DB, MAX_MASTER_GAIN_DB, MIN_RENDER_SPEED, MAX_RENDER_SPEED, type EqMode, timelineLenFor, MAX_LANE_SPEED, MIN_LANE_SPEED,
  EQ_PRESETS,
  cloneEq,
  defaultEq,
  clampEqBand,
  LANE_COLORS,
  findClip,
  samplesToSec,
  secToSamples,
  type EqBandId,
  type EqPreset,
  type EqSettings,
  type ExportFormat,
  type RailTab,
  type Samples,
  type Speed,
  type StudioClip,
  type StudioLane,
  type StudioState,
} from './model';
import { createDemoStudio, createInitialStudio } from './demo';
import type { Envelope } from './timeline/envelope';

/**
 * Tempo hasil analisis WASM (`daw-analysis`, lewat `audio/tempo-worker.ts`).
 *
 * Disimpan pada ASSET, bukan pada clip: BPM adalah sifat materi sumbernya.
 * Dua clip dari lagu yang sama punya BPM sumber yang sama; yang membedakannya
 * adalah kecepatan lane tempat mereka duduk — dan itu dihitung saat dipakai
 * (`selectPlayheadTempo`), bukan disalin ke tiap clip.
 */
export interface AssetTempo {
  readonly bpm: number;
  /** 0..1. Di bawah `TEMPO_UNCERTAIN` angka BPM tidak layak dipajang polos. */
  readonly confidence: number;
  readonly beatOffsetSec: number;
}

/**
 * Ambang "tidak yakin". Di bawah ini UI menandai angkanya, bukan
 * menyembunyikannya — materi tanpa ketukan jelas tetap punya jawaban paling
 * mungkin, dan menyembunyikannya sama menyesatkannya dengan memajangnya polos.
 *
 * Nilainya DIUKUR, bukan ditebak. `detectTempo` dijalankan atas materi nyata
 * lewat artefak WASM yang sama dengan yang dipakai aplikasi:
 *
 *   derau putih                    0.015
 *   pad ambient (tanpa transien)   0.017
 *   burst mirip bicara             0.046
 *   lagu nyata #1 (155 BPM)        0.191
 *   lagu nyata #2 (135 BPM)        0.224
 *   groove sintetis (tes Rust)     0.45 – 0.60
 *
 * 0.1 duduk di celah antara dua kelompok itu. Angka pertama yang dipakai di
 * sini adalah 0.2, dan itu SALAH: kedua lagu nyata di atas — yang BPM-nya
 * terbukti benar karena tiap potongan 25 detiknya memberi angka yang sama —
 * akan ditandai "tidak yakin". Musik nyata punya banyak isi ODF yang bukan
 * ketukan, jadi periodisitasnya wajar lebih rendah dari materi sintetis.
 */
export const TEMPO_UNCERTAIN = 0.1;

/** Asset audio yang sudah di-decode. Peak nyata, bukan mock. */
export interface StudioAsset {
  readonly id: number;
  readonly name: string;
  /**
   * Peak pyramid multi-resolusi (min/max/rms per bucket, 64/512/4096 sample).
   * Menggantikan `peaks: Float32Array` beresolusi tunggal: dengan satu
   * resolusi tetap, waveform lagu panjang mentok jadi persegi panjang rata.
   * Lihat `timeline/envelope.ts`.
   */
  readonly envelope: Envelope;
  readonly frames: Samples;
  readonly sampleRate: number;
  /**
   * `null` selama analisis belum selesai ATAU kalau materinya tidak bisa
   * dianalisis (< 8 detik, senyap). Dua keadaan itu sengaja tidak dibedakan di
   * sini; yang membedakannya adalah `tempoPending`.
   */
  readonly tempo: AssetTempo | null;
  /** true selama worker masih bekerja. Memisahkan "belum tahu" dari "tidak ada". */
  readonly tempoPending: boolean;
  /**
   * Koreksi oktaf dari user: BPM efektif = `tempo.bpm * 2 ** tempoOctave`.
   *
   * Ada karena oktaf tempo memang tidak selalu bisa diputuskan oleh mesin —
   * lagu 170 BPM dengan backbeat sama sahnya didengar sebagai 85. Setiap
   * perkakas DJ menyediakan ×2 / ÷2 untuk alasan yang sama.
   */
  readonly tempoOctave: number;
}

/**
 * `StudioState` (model.ts, binding) + hal-hal yang murni milik shell:
 * asset ter-decode dan status engine.
 */
export interface StudioAppState extends StudioState {
  /** assetId → asset. Clip tanpa entri di sini digambar dari `seed` (mock). */
  readonly assets: Readonly<Record<number, StudioAsset>>;
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
  /** true selama playhead sedang di-drag. Audio dibisukan sampai dilepas. */
  readonly scrubbing: boolean;
  /**
   * true selama CLIP sedang di-drag. Playback tidak dijadwalkan ulang selama
   * ini berlangsung — penjadwalan ulang tiap pointermove hanya menghasilkan
   * deretan klik. Begitu dilepas, flag turun dan posisi baru langsung berlaku.
   */
  readonly draggingClip: boolean;
  /** Clip hasil COPY, siap di-paste. Bukan PCM — hanya metadata. */
  readonly clipboard: StudioClip | null;
  /** Ulangi dari awal saat mencapai akhir materi. */
  readonly loop: boolean;
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
  /** Batas bawah panjang timeline (detik), diatur manual. */
  readonly minDurationSec: number;
  /** Batas atas panjang timeline (detik). null = ikut konten (otomatis). */
  readonly maxDurationSec: number | null;
}

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
  assets: {},
  engineReady: false,
  seekEpoch: 0,
  scrubbing: false,
  draggingClip: false,
  clipboard: null,
  loop: true,
  contentEnd: 0,
  panelOrder: DEFAULT_PANEL_ORDER,
  railOrder: DEFAULT_RAIL_ORDER,
  maximizedPanel: null,
  eqMode: 'curve',
  minDurationSec: MIN_DURATION_SEC,
  maxDurationSec: null,
  engineError: null,
});

type Listener = () => void;
const listeners = new Set<Listener>();

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
  state = merged;
  for (const fn of [...listeners]) fn();
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
  return {
    ...s,
    duration: farthest,
    contentEnd,
    panelOrder,
    railOrder,
    selectedLaneId: laneOk ? s.selectedLaneId : (s.lanes[0]?.id ?? null),
    selectedClipId: clipOk ? s.selectedClipId : null,
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

// ── Aksi publik ──────────────────────────────────────────────────────────────

export const studioActions = {
  // — seleksi —
  selectLane(laneId: string): void {
    set(() => ({ selectedLaneId: laneId }));
  },
  selectClip(clipId: string | null, laneId?: string): void {
    set((s) => ({
      selectedClipId: clipId,
      selectedLaneId: laneId ?? s.selectedLaneId,
    }));
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
          clips: [],
        },
      ],
    }));
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
  updateClip(clipId: string, patch: Partial<StudioClip>): void {
    set((s) => ({
      lanes: s.lanes.map((l) => ({
        ...l,
        clips: l.clips.map((c) => (c.id === clipId ? { ...c, ...patch, id: c.id } : c)),
      })),
    }));
  },
  removeClip(clipId: string): void {
    set((s) => ({
      lanes: s.lanes.map((l) => ({ ...l, clips: l.clips.filter((c) => c.id !== clipId) })),
    }));
  },
  /** Belah clip terpilih di playhead. Tidak melakukan apa-apa kalau di luar clip. */
  splitClipAtPlayhead(clipId: string): void {
    set((s) => {
      const hit = findClip(s.lanes, clipId);
      if (hit === null) return null;
      const { clip } = hit;
      const cut = s.playhead - clip.start;
      if (cut <= 0 || cut >= clip.len) return null;
      // Potongan diukur di TIMELINE-space, lalu dikonversi ke SOURCE-space
      // dengan ratio. Tanpa konversi ini, memotong clip yang di-speed-up akan
      // mengambil bagian source yang salah (docs/07 §8d: dua koordinat space).
      const cutSource = Math.round(cut * hit.lane.speedRatio);
      const left: StudioClip = { ...clip, len: cut, sourceLen: cutSource };
      const right: StudioClip = {
        ...clip,
        id: nextId('clip-'),
        start: clip.start + cut,
        len: clip.len - cut,
        sourceStart: clip.sourceStart + cutSource,
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
  /** Tambah clip baru (dipakai jalur drag & drop file). */
  addClip(laneId: string, clip: StudioClip): void {
    set((s) => ({
      ...mapLane(s, laneId, (l) => ({
        ...l,
        clips: [...l.clips, clip].sort((a, b) => a.start - b.start),
      })),
      selectedClipId: clip.id,
      selectedLaneId: laneId,
    }));
  },
  registerAsset(asset: StudioAsset): void {
    set((s) => ({ assets: { ...s.assets, [asset.id]: asset } }));
  },
  /**
   * Hasil dari worker tempo. `tempo === null` berarti sudah dianalisis dan
   * memang tidak ada jawabannya — `tempoPending` tetap dimatikan supaya UI
   * berhenti menampilkan "menganalisis".
   */
  setAssetTempo(id: number, tempo: AssetTempo | null): void {
    set((s) => {
      const asset = s.assets[id];
      if (asset === undefined) return {};
      return { assets: { ...s.assets, [id]: { ...asset, tempo, tempoPending: false } } };
    });
  },
  /** Tandai bahwa analisis sedang berjalan (dipanggil saat worker di-post). */
  markAssetTempoPending(id: number): void {
    set((s) => {
      const asset = s.assets[id];
      if (asset === undefined || asset.tempoPending) return {};
      return { assets: { ...s.assets, [id]: { ...asset, tempoPending: true } } };
    });
  },
  /** ×2 (`+1`) atau ÷2 (`-1`) pada BPM asset. Dibatasi ±2 oktaf. */
  shiftAssetTempoOctave(id: number, delta: number): void {
    set((s) => {
      const asset = s.assets[id];
      if (asset === undefined) return {};
      const next = Math.max(-2, Math.min(2, asset.tempoOctave + delta));
      if (next === asset.tempoOctave) return {};
      return { assets: { ...s.assets, [id]: { ...asset, tempoOctave: next } } };
    });
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
    set(() => ({
      ...clean,
      playing: false,
      scrubbing: false,
      draggingClip: false,
      exportProgress: null,
      seekEpoch: 0,
    }));
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

  setClipDragging(dragging: boolean): void {
    set((s) => (s.draggingClip === dragging ? null : { draggingClip: dragging }));
  },

  /** COPY: simpan metadata clip terpilih. PCM tidak ikut — asset tetap dibagi. */
  copySelectedClip(): void {
    set((s) => {
      const found = findClip(s.lanes, s.selectedClipId);
      return found === null ? null : { clipboard: { ...found.clip } };
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
      if (src === null) return null;
      const laneId = s.selectedLaneId ?? s.lanes[0]?.id;
      if (laneId === undefined) return null;
      const copy: StudioClip = { ...src, id: nextId('clip-'), start: Math.max(0, s.playhead) };
      return {
        ...mapLane(s, laneId, (l) => ({
          ...l,
          clips: [...l.clips, copy].sort((a, b) => a.start - b.start),
        })),
        selectedClipId: copy.id,
        selectedLaneId: laneId,
      };
    });
  },

  /** DELETE clip terpilih. Mengembalikan true kalau ada yang dihapus. */
  deleteSelectedClip(): void {
    set((s) => {
      if (s.selectedClipId === null) return null;
      const id = s.selectedClipId;
      return {
        lanes: s.lanes.map((l) => {
          const clips = l.clips.filter((c) => c.id !== id);
          return clips.length === l.clips.length ? l : { ...l, clips };
        }),
        selectedClipId: null,
      };
    });
  },

  newClipId(): string {
    return nextId('clip-');
  },
  /**
   * Id asset baru. WAJIB muat di `u32`: engine memakainya sebagai index tabel
   * asset (`AssetId = u32`), dan id berbasis timestamp (~1.7e15) ditolak saat
   * snapshot dideserialisasi.
   *
   * Di-seed dari id terbesar yang sudah ada supaya tidak bentrok dengan project
   * yang dipulihkan; id lama yang terlalu besar diabaikan saat menghitung seed,
   * jadi rentangnya tidak pernah bertabrakan.
   */
  newAssetId(): number {
    const existing = Object.keys(state.assets)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 0xffff_ffff);
    const floor = existing.length > 0 ? Math.max(...existing) : 0;
    idCounter = Math.max(idCounter + 1, floor + 1);
    return idCounter;
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
   * Majukan playhead sebesar `dtMs` waktu dinding. Wrap ke 0 di ujung, sama
   * seperti interval di design. Dipanggil dari App; ini yang membuat UI bisa
   * diuji tanpa engine — bukan simulasi audio, hanya animasi playhead.
   */
  tick(dtMs: number): void {
    set((s) => {
      if (!s.playing) return null;
      const advance = secToSamples((dtMs / 1000) * s.speed, s.sampleRate);
      const next = s.playhead + advance;

      // Batas transport = ujung MATERI. Kalau belum ada clip sama sekali,
      // pakai `duration` supaya playhead tetap bisa bergerak di project kosong.
      const end = s.contentEnd > 0 ? s.contentEnd : s.duration;
      if (next < end) return { playhead: next };

      if (s.loop) {
        // `seekEpoch` WAJIB naik: itu satu-satunya sinyal yang membuat playback
        // menjadwalkan ulang voice dari posisi baru. Tanpa ini, playhead
        // melompat ke 0 tapi audionya tidak ikut mengulang — loop-nya cuma
        // terlihat, tidak terdengar.
        return { playhead: 0, seekEpoch: s.seekEpoch + 1 };
      }
      // Tanpa loop: berhenti tepat di ujung materi, jangan terus berjalan
      // menembus ekor kosong.
      return { playing: false, playhead: end, seekEpoch: s.seekEpoch + 1 };
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
  setEngineStatus(ready: boolean, error: string | null): void {
    set(() => ({ engineReady: ready, engineError: error }));
  },

  /**
   * Hanya untuk tes. `seed: 'demo'` (default) memberi clip mock supaya tes
   * punya materi untuk diutak-atik; `'empty'` memakai state awal aplikasi
   * yang sebenarnya — satu lane kosong.
   */
  __resetForTest(seed: 'demo' | 'empty' = 'demo'): void {
    state = withDerived({
      ...(seed === 'empty' ? createInitialStudio() : createDemoStudio()),
      assets: {},
      engineReady: false,
      engineError: null,
      seekEpoch: 0,
      scrubbing: false,
      draggingClip: false,
      clipboard: null,
      loop: true,
      contentEnd: 0,
      panelOrder: DEFAULT_PANEL_ORDER,
      railOrder: DEFAULT_RAIL_ORDER,
      maximizedPanel: null,
      eqMode: 'curve',
      minDurationSec: MIN_DURATION_SEC,
      maxDurationSec: null,
    });
    for (const fn of [...listeners]) fn();
  },
};

// ── Selector siap pakai (stabil secara referensi) ────────────────────────────

export const selectLanes = (s: StudioAppState): readonly StudioLane[] => s.lanes;
export const selectDurationSec = (s: StudioAppState): number =>
  samplesToSec(s.duration, s.sampleRate);
export const selectClipCount = (s: StudioAppState): number =>
  s.lanes.reduce((a, l) => a + l.clips.length, 0);
