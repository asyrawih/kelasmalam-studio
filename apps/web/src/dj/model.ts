/**
 * Model DJ Performance Mixer — SATU sumber kebenaran untuk halaman `/dj`.
 *
 * SEMUA posisi di berkas ini SOURCE-space (sample di dalam asset). Tidak ada
 * TIMELINE-space di sini: deck memutar satu lagu UTUH, jadi dua koordinat
 * docs/07 §8d runtuh jadi satu. Tempo fader mengubah LAJU BACA, bukan geometri.
 *
 * Itu bukan penyederhanaan yang kebetulan cocok — itu yang membuat
 * `ScrollingWave` bisa dipakai apa adanya dengan `clipStart = 0` dan
 * `speedRatio = 1`. Kalau suatu saat deck bisa memuat POTONGAN alih-alih lagu
 * utuh, di situlah dua koordinat harus kembali, dan bukan sebelum itu.
 *
 * Detik hanya untuk DITAMPILKAN (docs/00). Tidak ada posisi yang disimpan
 * sebagai detik.
 *
 * Berkas ini TIDAK meng-import React, store, maupun Web Audio. Semua yang bisa
 * salah diam-diam — konversi tempo, kurva crossfader, penempelan ke grid — ada
 * di sini sebagai fungsi murni supaya bisa dites tanpa merender apa pun. Pola
 * yang sama dengan `studio/analysis/beat-grid.ts` dan `studio/timeline/fade.ts`.
 */

import type { Samples } from '../studio/model';
import type { BeatGrid } from '../studio/analysis/beat-grid';
import { samplesPerBeat, snapSourceToGrid } from '../studio/analysis/beat-grid';

export type { Samples };

const clamp = (v: number, lo: number, hi: number): number =>
  v <= lo ? lo : v >= hi ? hi : Number.isNaN(v) ? lo : v;

// ── Identitas ────────────────────────────────────────────────────────────────

/**
 * Dua deck. Union literal, bukan `number`: dengan kunci literal,
 * `Record<DeckId, T>` BUKAN index signature, jadi `decks[id]` tetap bertipe
 * pasti meskipun `noUncheckedIndexedAccess` menyala. Itu menghemat puluhan
 * `?? fallback` yang masing-masing adalah tempat bug bersembunyi.
 */
export type DeckId = 'A' | 'B';
export const DECK_IDS: readonly DeckId[] = ['A', 'B'];

/**
 * Sisi layar. Sengaja TERPISAH dari `DeckId` supaya tata letak bisa diubah
 * tanpa menyentuh arti deck, dan supaya deck C/D nanti tidak butuh komponen
 * baru — hanya baris baru di peta ini.
 */
export type DeckSide = 'left' | 'right';
export const SIDE_OF: Readonly<Record<DeckId, DeckSide>> = { A: 'left', B: 'right' };

/** Warna aksen per deck. Dari palet CyberUI — tidak ada warna baru. */
export const DECK_ACCENT: Readonly<Record<DeckId, string>> = {
  A: '#ffd400', // --cy-accent
  B: '#ffb020', // --cy-accent-alt
};

// ── Hot cue ──────────────────────────────────────────────────────────────────

export type HotCueSlot = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
export const HOT_CUE_SLOTS: readonly HotCueSlot[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * Delapan warna TETAP dan berbeda, bukan satu amber untuk semuanya: seluruh
 * guna hot cue adalah dikenali dari sudut mata sambil melihat hal lain.
 *
 * Empat di antaranya di luar palet `--cy-*`, dan itu disengaja — sama seperti
 * `#ff4d4d` / `#6ee7ff` yang sudah ditulis literal di `studio/model.ts` karena
 * design pun menulisnya literal (lihat catatan di kepala `ui/cyber/theme.css`).
 */
export const HOT_CUE_COLORS: Readonly<Record<HotCueSlot, string>> = {
  A: '#ffd400',
  B: '#ffb020',
  C: '#6ee7ff',
  D: '#ff7ad9',
  E: '#a78bfa',
  F: '#7ee787',
  G: '#ff4d4d',
  H: '#f2efe6',
};

export interface HotCue {
  /** Posisi SOURCE-space. */
  readonly at: Samples;
  /** Label bebas; kosong = pakai nama slot. */
  readonly label: string;
  readonly color: string;
}

/** Delapan slot, selalu delapan. `null` = kosong. */
export type HotCueBank = Readonly<Record<HotCueSlot, HotCue | null>>;

export const EMPTY_HOT_CUES: HotCueBank = {
  A: null,
  B: null,
  C: null,
  D: null,
  E: null,
  F: null,
  G: null,
  H: null,
};

/**
 * Keputusan user ATAS SATU LAGU — bukan atas deck.
 *
 * Hot cue mengikuti MATERI, persis seperti di rekordbox: muat lagu yang sama ke
 * deck lain, cue-nya ikut. Kalau ia disimpan di `DeckState`, meng-eject lalu
 * memuat ulang lagu yang sama akan menghapus sepuluh menit kerja tanpa satu pun
 * peringatan.
 *
 * Bentuknya mengikuti `assetGrids` di `studio/persist/persistence.ts`: yang
 * disimpan hanya KEPUTUSAN USER, karena hanya itu yang tidak bisa dibangun
 * ulang dari file-nya.
 */
export interface TrackCues {
  readonly hotCues: HotCueBank;
  /** Titik CUE (memory cue utama). */
  readonly cuePoint: Samples;
  /** Memory cue tambahan, urut menaik. Tombol CALL ◀ ▶ berjalan di daftar ini. */
  readonly memoryCues: readonly Samples[];
}

export const EMPTY_TRACK_CUES: TrackCues = {
  hotCues: EMPTY_HOT_CUES,
  cuePoint: 0,
  memoryCues: [],
};

// ── Loop ─────────────────────────────────────────────────────────────────────

/**
 * KENAPA `inAt`/`outAt` TETAP TERSIMPAN SETELAH LOOP DIMATIKAN: itu seluruh
 * guna tombol RELOOP. Kalau keluar loop menghapus batasnya, satu-satunya cara
 * kembali adalah memasangnya lagi dengan tangan — dan itu tidak bisa dilakukan
 * di tengah mix. Karena itu `active` adalah bit TERPISAH, bukan
 * `loop: {in,out} | null`.
 */
export interface LoopState {
  readonly inAt: Samples | null;
  readonly outAt: Samples | null;
  /** true = playhead sedang terkurung di antara in dan out. */
  readonly active: boolean;
  /**
   * Panjang loop dalam KETUKAN kalau ia lahir dari tombol beat-loop, atau
   * `null` kalau in/out dipasang manual.
   *
   * Disimpan supaya ×2 dan ÷2 tahu ia sedang membagi APA. Menurunkannya dari
   * `outAt - inAt` memang bisa, tapi hasilnya pecahan kotor begitu grid-nya
   * meleset sedikit, dan setelah tiga kali ÷2 angkanya berhenti berarti.
   */
  readonly beats: number | null;
}

export const NO_LOOP: LoopState = { inAt: null, outAt: null, active: false, beats: null };

/** Preset tombol beat-loop, urut dari terkecil = urutan di layar. */
export const BEAT_LOOP_PRESETS: readonly number[] = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
export const MIN_LOOP_BEATS = 1 / 32;
export const MAX_LOOP_BEATS = 64;
/** Loop lebih pendek dari ini tidak bisa dibaca sebagai loop, hanya sebagai dengung. */
export const MIN_LOOP_SAMPLES = 64;

export function loopLen(l: LoopState): Samples | null {
  if (l.inAt === null || l.outAt === null) return null;
  const n = l.outAt - l.inAt;
  return n >= MIN_LOOP_SAMPLES ? n : null;
}

// ── Tempo ────────────────────────────────────────────────────────────────────

/**
 * Rentang tempo fader, dalam persen.
 *
 * `100` adalah **WIDE**, dan itu memang ±100% — bukan sekadar "lebih lebar
 * dari 16". Di −100% lagu berhenti. Angkanya dari manual CDJ/rekordbox.
 */
export type TempoRange = 6 | 10 | 16 | 100;
export const TEMPO_RANGES: readonly TempoRange[] = [6, 10, 16, 100];

/**
 * Langkah terkecil fader per rentang, dalam persen. Dipakai tombol nudge dan
 * penempelan nilai supaya angka di layar tidak pernah menampilkan presisi yang
 * tidak dimiliki alatnya.
 *
 * rekordbox memakai 0.04% untuk ±10 dan ±16; manual CDJ menyebut 0.05% untuk
 * keduanya. Kita mengikuti rekordbox — itu yang sedang ditiru.
 */
export const TEMPO_STEP_PCT: Readonly<Record<TempoRange, number>> = {
  6: 0.02,
  10: 0.04,
  16: 0.04,
  100: 0.5,
};

export interface DeckTempo {
  /**
   * Posisi FISIK fader, −1..+1, dengan 0 = detent tengah.
   *
   * DISIMPAN SEBAGAI TRAVEL, BUKAN PERSEN, dan itu meniru perilaku perangkat
   * keras: mengganti RANGE dari ±6 ke ±16 TIDAK menggerakkan fader-nya — yang
   * berubah adalah berapa banyak arti dari posisi yang sama itu. Kalau yang
   * disimpan persen, mengganti range harus menggeser fader supaya persennya
   * tetap, dan itu gerakan hantu yang tidak dilakukan alat mana pun.
   */
  readonly fader: number;
  readonly rangePct: TempoRange;
  /**
   * KEY LOCK (MASTER TEMPO). Disimpan, TAPI lihat `KEY_LOCK_AVAILABLE`.
   */
  readonly keyLock: boolean;
}

export const DEFAULT_TEMPO: DeckTempo = { fader: 0, rangePct: 10, keyLock: false };

/**
 * Sama bentuknya dengan `PITCH_LOCK_AVAILABLE` di `studio/model.ts`, dan sama
 * alasannya.
 *
 * Key lock menjanjikan time-stretch yang mempertahankan pitch. docs/07 §8a
 * memutuskan varispeed, dan docs/09 menunda WSOLA/phase-vocoder secara SADAR —
 * lebih dari itu, rencana §8c ditulis untuk PRE-RENDER di worker, yang tidak
 * berlaku untuk deck DJ karena tempo fader digerakkan saat lagunya berbunyi.
 *
 * Jadi tombolnya ADA (tempatnya di panel memang di sana), disabled, dengan
 * alasan yang terbaca. Menampilkannya aktif berarti berbohong tentang apa yang
 * terjadi pada audio — dan di perkakas audio itu kebohongan yang paling mahal.
 */
export const KEY_LOCK_AVAILABLE = false;
export const KEY_LOCK_REASON =
  'MASTER TEMPO belum ada — tempo fader = varispeed, pitch ikut bergeser (docs/07 §8a)';

// ── Sync, pad, quantize ──────────────────────────────────────────────────────

export type SyncRole = 'off' | 'master' | 'follower';

export type PadMode = 'hotcue' | 'loop' | 'beatjump' | 'roll';
export const PAD_MODES: readonly PadMode[] = ['hotcue', 'loop', 'beatjump', 'roll'];
export const PAD_MODE_LABEL: Readonly<Record<PadMode, string>> = {
  hotcue: 'HOT CUE',
  loop: 'BEAT LOOP',
  beatjump: 'BEAT JUMP',
  roll: 'LOOP ROLL',
};

/**
 * Pembagian quantize, dalam ketukan.
 *
 * Daftarnya mengikuti rekordbox, yang satu langkah LEBIH HALUS dari CDJ:
 * CDJ mulai di 1/8, rekordbox menyediakan 1/16. Default rekordbox 1 ketukan.
 */
export type QuantizeDiv = 'off' | '1/16' | '1/8' | '1/4' | '1/2' | '1';
export const QUANTIZE_DIVS: readonly QuantizeDiv[] = ['off', '1/16', '1/8', '1/4', '1/2', '1'];
export const QUANTIZE_BEATS: Readonly<Record<Exclude<QuantizeDiv, 'off'>, number>> = {
  '1/16': 0.0625,
  '1/8': 0.125,
  '1/4': 0.25,
  '1/2': 0.5,
  '1': 1,
};
export const DEFAULT_QUANTIZE_DIV: QuantizeDiv = '1';

// ── DeckState ────────────────────────────────────────────────────────────────

export interface DeckState {
  readonly id: DeckId;

  // — materi —
  /** `null` = deck kosong. */
  readonly assetId: number | null;
  /**
   * SALINAN `asset.frames`.
   *
   * Aman disalin karena `frames` diset sekali di `assetFromBuffer` dan tidak
   * pernah berubah seumur hidup asset. Ada di sini supaya store bisa meng-clamp
   * playhead, cue, dan loop SENDIRI di satu tempat (`withDerived`) tanpa
   * membaca store lain — invarian ditegakkan sekali, bukan diingat di tiap aksi.
   *
   * Bandingkan dengan BPM, yang TIDAK disalin: `bpmOverride` dan `tempoOctave`
   * bisa diubah user di halaman Studio kapan saja, jadi salinannya akan basi
   * diam-diam. Aturannya: **kalau bisa berubah dari luar deck, turunkan.**
   */
  readonly frames: Samples;
  /** Salinan `asset.name`; alasan sama. Kosong saat deck kosong. */
  readonly name: string;
  /** Salinan `asset.sampleRate`; untuk konversi sample↔detik di layar. */
  readonly sampleRate: number;

  // — transport —
  readonly playing: boolean;
  /** Posisi SOURCE-space. */
  readonly playhead: Samples;
  /**
   * Naik tiap kali posisi dipindah SECARA EKSPLISIT (cue, hot cue, jog, beat
   * jump, wrap loop). `tick()` TIDAK menaikkannya.
   *
   * Belum dipakai siapa pun di fase 1, dan itu disengaja: ini persis sinyal
   * yang dipakai `usePreviewPlayback` untuk membedakan "playhead maju sendiri"
   * dari "user melompat" (lihat `seekEpoch` di `studio/store.ts`). Menyediakannya
   * sekarang membuat fase audio jadi penyambungan, bukan penulisan ulang.
   */
  readonly seekEpoch: number;

  /**
   * true selama tombol CUE DITAHAN.
   *
   * State sesi murni, tapi harus di store: tombol CUE dan jog wheel adalah dua
   * komponen berbeda yang keduanya perlu tahu, dan semantik CDJ ("tahan = putar
   * dari cue, lepas = balik ke cue") tidak bisa dijalankan tanpanya.
   */
  readonly cueHeld: boolean;

  /**
   * Hot cue yang sedang "menyala", atau `null`.
   *
   * Ada supaya pad hot cue berperilaku sebagai **tombol on/off**: menekan slot
   * yang sedang menyala menghentikan lagu dan mengembalikannya ke titik cue
   * itu, alih-alih melompat ke sana lagi (yang saat sedang berbunyi tidak
   * terdengar melakukan apa pun).
   *
   * Sesi murni, bukan milik asset: yang disimpan pada lagu adalah POSISI
   * cue-nya, bukan apakah ia sedang dipakai sekarang.
   */
  readonly activeHotCue: HotCueSlot | null;

  readonly loop: LoopState;
  readonly tempo: DeckTempo;

  /**
   * Bend sesaat dari jog / tombol nudge — PENGALI di sekitar 1.0.
   *
   * Terpisah dari `tempo.fader` karena ia harus KEMBALI ke 1 saat tangan lepas.
   * Kalau ia menulis ke fader, satu nudge akan mengubah BPM lagu secara permanen.
   */
  readonly bend: number;

  /**
   * SLIP. Saat menyala, posisi BAYANGAN terus berjalan seolah tidak ada loop
   * dan tidak ada lompatan; melepas loop/cue mengembalikan deck ke sana.
   *
   * Yang membuatnya berarti adalah apa yang TERDENGAR saat dilepas, jadi ia
   * baru punya arti sejak lapisan audio ada — sebelum itu tombolnya mati.
   */
  readonly slip: boolean;

  readonly sync: SyncRole;
  /**
   * true selama waveform deck ini SEDANG DITARIK.
   *
   * State sesi murni, tapi harus di store karena pembacanya bukan komponen yang
   * menariknya: `startSyncFollow` memakainya untuk TIDAK memfase ulang follower
   * pada tiap `pointermove`. Tanpa ini, satu tarikan di deck master
   * menghasilkan puluhan lompatan di deck sebelahnya.
   */
  readonly scrubbing: boolean;
  readonly padMode: PadMode;
  /** Quantize per deck; PEMBAGIANNYA global (`DjState.quantizeDiv`). */
  readonly quantize: boolean;
}

export function emptyDeck(id: DeckId): DeckState {
  return {
    id,
    assetId: null,
    frames: 0,
    name: '',
    sampleRate: 48_000,
    playing: false,
    playhead: 0,
    seekEpoch: 0,
    cueHeld: false,
    activeHotCue: null,
    slip: false,
    scrubbing: false,
    loop: NO_LOOP,
    tempo: DEFAULT_TEMPO,
    bend: 1,
    sync: 'off',
    padMode: 'hotcue',
    quantize: true,
  };
}

// ── Channel ──────────────────────────────────────────────────────────────────

export type EqBandDj = 'hi' | 'mid' | 'low';
export const DJ_EQ_BANDS: readonly EqBandDj[] = ['hi', 'mid', 'low'];

/**
 * Rentang EQ mixer DJ: **−26 dB … +6 dB**.
 *
 * Angka ini BUKAN pilihan kita — itu spesifikasi DJM-900NXS2 yang ditiru
 * rekordbox (HI shelf 30 kHz, MID peaking 1 kHz, LOW shelf 20 Hz). Ujung
 * bawahnya dipakai sebagai KILL.
 *
 * Kenapa −26 dan bukan −∞: −∞ memaksa cabang khusus di setiap rumus gain, dan
 * pada satu band di dalam mix telinga tidak bisa membedakan −26 dari −∞. Beda
 * dengan EQ4 Studio yang bergerak ±24 dB dengan Q yang bisa diatur — EQ DJ
 * adalah ISOLATOR, dan ujung kirinya harus benar-benar membuang pita itu.
 */
export const EQ_KILL_DB = -26;
export const EQ_MAX_DB = 6;
/** Frekuensi tengah tiap band, mengikuti perangkat yang ditiru. */
export const EQ_BAND_HZ: Readonly<Record<EqBandDj, number>> = { hi: 30_000, mid: 1_000, low: 20 };

export interface ChannelEq {
  readonly hi: number;
  readonly mid: number;
  readonly low: number;
}
export const FLAT_EQ: ChannelEq = { hi: 0, mid: 0, low: 0 };

/**
 * KILL per band, sebagai BIT TERPISAH dari nilai knob.
 *
 * Manual rekordbox harfiah: *"When you click words of `[HIGH]`/`[MID]`/`[LOW]`
 * to light up, the band is turned off. **While they light up, each controller
 * is not activated.**"* — knob-nya tidak berubah, ia hanya berhenti berpengaruh.
 *
 * Kalau KILL ditulis sebagai nilai (−26 dB menimpa knob), mematikan lalu
 * menyalakan lagi akan mengembalikan band ke 0 dan **membuang setelan yang
 * sudah dibuat tangan**. Di tengah mix itu kehilangan yang tidak bisa
 * dibatalkan — dan penyebabnya tidak kelihatan, karena knob-nya memang
 * bergerak sendiri.
 */
export type EqKill = Readonly<Record<EqBandDj, boolean>>;
export const NO_KILL: EqKill = { hi: false, mid: false, low: false };

/** dB efektif satu band: nilai knob, atau KILL kalau band-nya dimatikan. */
export function bandDb(eq: ChannelEq, kill: EqKill, band: EqBandDj): number {
  return kill[band] ? EQ_KILL_DB : eq[band];
}

export const MIN_TRIM_DB = -26;
export const MAX_TRIM_DB = 6;
export const MIN_MASTER_DB = -26;
export const MAX_MASTER_DB = 6;

export interface ChannelState {
  readonly deck: DeckId;
  /** Trim / gain masukan, dB. */
  readonly trimDb: number;
  readonly eq: ChannelEq;
  /** Band yang DIMATIKAN. Nilai knob di `eq` tetap utuh — lihat `EqKill`. */
  readonly eqKill: EqKill;
  /**
   * Knob COLOR / FILTER. −1 = LPF penuh, 0 = bypass, +1 = HPF penuh.
   *
   * SATU knob dua arah, bukan dua knob — itu bentuk fisik yang ditiru, dan yang
   * membuat "0 = tidak ada filter sama sekali" jadi satu titik yang bisa
   * dikembalikan dengan klik-ganda.
   *
   * Manual rekordbox harfiah: *"If the knob is in the center position, the
   * effect is not applied. The effect level differs according to the clockwise
   * or counterclockwise turn of the knob."* Kiri dan kanan bukan dua arah dari
   * besaran yang sama — keduanya perilaku berbeda. Untuk FILTER: kiri
   * menurunkan cutoff LPF, kanan menaikkan cutoff HPF.
   */
  readonly filter: number;
  /**
   * Channel fader, TRAVEL 0..1 (0 = bawah/senyap, 1 = atas/unity).
   *
   * TRAVEL, bukan dB — beda dari lane Studio (`studio/rail/fader.ts` menyimpan
   * dB dengan unity di 75% travel). Fader DJ punya unity DI PUNCAK dan nol
   * MUTLAK di dasar; itu kontrol pertunjukan yang posisinya sendiri adalah
   * kebenarannya. Bolak-balik lewat dB membuat "benar-benar nol" jadi −∞ yang
   * harus dijaga di setiap konversi.
   */
  readonly fader: number;
  /** Monitor headphone. */
  readonly cue: boolean;
}

export function defaultChannel(deck: DeckId): ChannelState {
  return { deck, trimDb: 0, eq: FLAT_EQ, eqKill: NO_KILL, filter: 0, fader: 1, cue: false };
}

/**
 * Lengkapi channel yang datang dari sesi tersimpan.
 *
 * Sesi yang ditulis sebelum `eqKill` ada tidak punya field itu, dan membacanya
 * langsung menghasilkan `undefined` yang lolos tipe (dibaca lewat index) lalu
 * meledak saat dipakai. Sama seperti `panelOrder ?? DEFAULT` di
 * `studio/persist/persistence.ts` — field baru yang opsional dibaca dengan
 * default, bukan dengan menaikkan versi dan membuang sesi user.
 */
export function normalizeChannel(deck: DeckId, raw: Partial<ChannelState> | undefined): ChannelState {
  const base = defaultChannel(deck);
  if (raw === undefined) return base;
  return {
    ...base,
    ...raw,
    eq: { ...base.eq, ...(raw.eq ?? {}) },
    eqKill: { ...base.eqKill, ...(raw.eqKill ?? {}) },
  };
}

// ── Mixer ────────────────────────────────────────────────────────────────────

export type CrossfaderCurve = 'smooth' | 'sharp' | 'cut';
export const CROSSFADER_CURVES: readonly CrossfaderCurve[] = ['smooth', 'sharp', 'cut'];

export interface MixerState {
  /** 0 = deck A penuh, 1 = deck B penuh. */
  readonly crossfader: number;
  readonly curve: CrossfaderCurve;
  readonly masterDb: number;
  /** Campuran headphone: 0 = CUE saja, 1 = MASTER saja. */
  readonly cueMix: number;
  readonly cueDb: number;
  readonly channels: Readonly<Record<DeckId, ChannelState>>;
}

export function defaultMixer(): MixerState {
  return {
    crossfader: 0.5,
    curve: 'smooth',
    masterDb: 0,
    cueMix: 0.5,
    cueDb: -12,
    channels: { A: defaultChannel('A'), B: defaultChannel('B') },
  };
}

// ── Beat FX ──────────────────────────────────────────────────────────────────

/**
 * SATU unit Beat FX yang bisa diarahkan, bukan rantai per-deck.
 *
 * Itu bentuk DJM, dan alasannya bukan kesederhanaan: efek DJ adalah gerakan
 * pertunjukan ("sekarang, di sini"), dan tiga rantai yang bisa aktif bersamaan
 * tidak pernah dipakai sekaligus oleh tangan yang sama.
 *
 * `kind` adalah id dari KATALOG RUST (`crates/engine/src/fx/registry.rs` lewat
 * `audio/fx-catalog.ts`), bukan enum baru. Efek ke-9 yang ditambahkan di Rust
 * harus muncul di panel tanpa satu baris TypeScript pun.
 */
export type FxTargetDj = DeckId | 'master';

export interface FxState {
  readonly on: boolean;
  /** Id efek dari katalog, atau string kosong kalau katalog belum dimuat. */
  readonly kind: string;
  readonly target: FxTargetDj;
  /** Panjang efek dalam KETUKAN. */
  readonly beats: number;
  /** Kedalaman / wet, 0..1. */
  readonly level: number;
}

/**
 * Pembagian ketukan yang ditawarkan UI.
 *
 * ⚠️ Rentang sebenarnya BERBEDA PER EFEK di rekordbox: DELAY/ECHO/SPIRAL
 * 1/16–16, sedangkan FILTER/FLANGER/PHASER sampai 1/16–**64**; REVERB dan PITCH
 * bahkan tidak memakai ketukan sama sekali (persen). Karena itu pemilih ini
 * hanya ditampilkan untuk efek yang parameternya ber-`pflag::BEAT_SYNC` —
 * benderanya dibaca dari katalog, tidak diasumsikan. Lihat
 * `recordbox/01-fitur-rekordbox.md`.
 */
export const FX_BEAT_DIVS: readonly number[] = [
  1 / 16,
  1 / 8,
  1 / 4,
  1 / 2,
  1,
  2,
  4,
  8,
  16,
];

export function defaultFx(): FxState {
  return { on: false, kind: '', target: 'master', beats: 1, level: 0.5 };
}

// ── Browser ──────────────────────────────────────────────────────────────────

export type BrowseSort = 'name' | 'bpm' | 'time';

export interface BrowseState {
  readonly query: string;
  readonly sort: BrowseSort;
  readonly ascending: boolean;
  /** Baris yang tersorot. Bukan berarti sedang dimuat ke deck. */
  readonly selectedAssetId: number | null;
}

export function defaultBrowse(): BrowseState {
  return { query: '', sort: 'name', ascending: true, selectedAssetId: null };
}

// ── Grid edit ────────────────────────────────────────────────────────────────

/**
 * Lebar jendela waveform saat menyunting grid, dalam BAR.
 *
 * Preset yang sama dengan `ZOOM_BAR_PRESETS` di `timeline/BeatSection.tsx`, dan
 * itu disengaja: dua skala zoom yang berbeda untuk pekerjaan yang sama berarti
 * grid yang terlihat rapi di satu halaman terlihat meleset di halaman lain,
 * tanpa satu pun angka yang berubah.
 *
 * `DECK_WINDOW_SEC` (8 detik) yang dipakai di luar mode grid TIDAK cukup di
 * sini: menaruh downbeat di transien butuh 1–2 bar memenuhi layar.
 */
export type GridZoom = 1 | 2 | 4 | 8;
/** Mati + tiga tingkat. Definisinya di `audio/metronome.ts`, di-reekspor di
 *  sini supaya `model.ts` tetap tidak meng-import apa pun yang berbau audio. */
export type MetroLevel = 0 | 1 | 2 | 3;
export const METRO_LEVELS: readonly MetroLevel[] = [0, 1, 2, 3];
export const GRID_ZOOMS: readonly GridZoom[] = [1, 2, 4, 8];

/** Arti menarik waveform besar saat mode grid menyala. */
export type GridDragMode = 'seek' | 'grid';

/**
 * Cakupan suntingan grid — kontrol #7 rekordbox.
 *
 * `'track'` — satu tempo untuk SELURUH lagu (`[Normal]` rekordbox). Ini yang
 * benar untuk materi elektronik, dan ia bawaannya.
 *
 * `'here'` — suntingan hanya berlaku DARI POSISI INI ke belakang, dengan
 * membuat anchor ruas baru (`[Dynamic]`). Untuk lagu yang direkam manusia dan
 * temponya bergeser di tengah jalan: tanpa ini, memperbaiki reff berarti
 * merusak intro.
 */
export type GridScope = 'track' | 'here';

export interface GridEditState {
  /** Deck yang sedang disunting grid-nya. `null` = mode mati. */
  readonly deck: DeckId | null;
  readonly zoomBars: GridZoom;
  /**
   * `[fine]` rekordbox, dan HANYA seperti rekordbox: ia membesarkan langkah
   * renggang/rapat dari 1 ms ke 3 ms, dan tidak menyentuh apa pun yang lain.
   *
   * Versi sebelumnya ikut menghaluskan geser anchor jadi 0.1 ms. Niatnya baik —
   * satu kontrol mengejar fase, satunya mengejar drift — tapi satu tombol yang
   * mengubah dua langkah ke arah BERLAWANAN tidak bisa ditebak dari namanya,
   * dan tidak ada alat DJ yang berperilaku begitu.
   */
  readonly fine: boolean;
  /**
   * Arti MENARIK waveform besar selama mode grid menyala.
   *
   * `'seek'` — seperti di luar mode grid, dan seperti rekordbox: tarikan
   * mencari posisi, grid hanya berubah lewat tombol. Ini bawaannya, karena
   * menyetel grid menuntut playhead dipindah berkali-kali (ke kick pertama,
   * lalu ke drop terakhir), dan tarikan adalah cara paling langsung ke sana.
   *
   * `'grid'` — tarikan menggeser GRID sementara playhead diam. Lebih cepat
   * daripada menekan ◀ ▶ puluhan kali, tapi ia MEMBAJAK gerakan yang di
   * seluruh aplikasi ini berarti "cari posisi", jadi ia harus dipilih dengan
   * sadar dan tidak boleh jadi bawaan.
   */
  readonly drag: GridDragMode;
  /** Cakupan suntingan: seluruh lagu, atau dari posisi ini ke belakang. */
  readonly scope: GridScope;
  /**
   * Cap waktu tombol TAP, ms. Di store dan bukan di komponen karena TAP punya
   * dua pintu masuk (tombol dan keyboard) yang harus menambah ke deretan yang
   * SAMA — dua deretan terpisah berarti menepuk bergantian menghasilkan angka
   * yang tidak berarti apa-apa.
   */
  readonly taps: readonly number[];
  /**
   * Metronom: mati, lalu tiga tingkat volume — persis rekordbox.
   *
   * Nilainya di sini, bukan di lapisan audio, karena ia keputusan UI dan harus
   * bertahan saat context audio dibangun ulang (perangkat keluaran berganti,
   * tab dibangunkan). Lihat `audio/metronome.ts` untuk aturan routing-nya.
   */
  readonly metroLevel: MetroLevel;
}

export function defaultGridEdit(): GridEditState {
  return { deck: null, zoomBars: 2, fine: false, drag: 'seek', scope: 'track', taps: [], metroLevel: 0 };
}

// ── DjState ──────────────────────────────────────────────────────────────────

export interface DjState {
  readonly decks: Readonly<Record<DeckId, DeckState>>;
  /**
   * Cue per ASSET, bukan per deck. Lihat `TrackCues`.
   * Ini satu-satunya bagian `DjState` yang layak di-persist.
   */
  readonly cues: Readonly<Record<number, TrackCues>>;
  readonly mixer: MixerState;
  readonly fx: FxState;
  readonly browse: BrowseState;
  /**
   * Mode GRID EDIT. Di `DjState` dan bukan di komponen karena command keyboard
   * harus bisa menyalakannya, dan karena `DeckScrollingWave` perlu tahu apakah
   * tarikan pointer berarti "cari posisi" atau "geser grid".
   *
   * SENGAJA bukan sesuatu yang layak disimpan: ini keadaan pekerjaan, bukan
   * keputusan atas materi. Yang layak bertahan adalah grid hasil suntingannya,
   * dan itu ikut `assetGrids` milik Studio.
   */
  readonly gridEdit: GridEditState;
  readonly quantizeDiv: QuantizeDiv;
  /** Deck acuan tempo, atau null. Direkonsiliasi di `withDerived`. */
  readonly masterDeck: DeckId | null;
  /**
   * Deck yang jadi SASARAN aksi tanpa sasaran eksplisit.
   *
   * Ada karena keyboard butuh jawaban untuk "PLAY yang mana": di halaman dua
   * deck, Spasi tanpa deck fokus adalah tombol yang tidak bisa dijelaskan.
   * Ia juga yang menerima `Enter` dari daftar Collection, sehingga memuat lagu
   * bisa dilakukan tanpa menyentuh tetikus sama sekali.
   *
   * Berbeda dari `masterDeck`: master adalah acuan TEMPO (milik audio), fokus
   * adalah sasaran PERINTAH (milik antarmuka). Menyatukannya berarti mengganti
   * acuan tempo hanya karena user ingin menekan tombol di deck lain.
   */
  readonly focusedDeck: DeckId;
  /**
   * true kalau lapisan audio benar-benar hidup. Di iterasi ini SELALU false,
   * dan header memajang "UI ONLY · TANPA AUDIO". Bentuknya sengaja sama dengan
   * `engineReady`/`engineError` di `studio/store.ts`.
   */
  readonly audioReady: boolean;
  readonly audioError: string | null;
  /** Satu baris pesan untuk kegagalan yang harus dibaca user (SYNC, import). */
  readonly notice: string | null;
}

export function createInitialDj(): DjState {
  return {
    decks: { A: emptyDeck('A'), B: emptyDeck('B') },
    cues: {},
    mixer: defaultMixer(),
    fx: defaultFx(),
    browse: defaultBrowse(),
    gridEdit: defaultGridEdit(),
    quantizeDiv: DEFAULT_QUANTIZE_DIV,
    masterDeck: null,
    focusedDeck: 'A',
    audioReady: false,
    audioError: null,
    notice: null,
  };
}

// ── Tempo: konversi ──────────────────────────────────────────────────────────

/** Posisi fader → persen penyimpangan tempo. Satu-satunya tempat perkaliannya. */
export function tempoPercent(t: DeckTempo): number {
  return clamp(t.fader, -1, 1) * t.rangePct;
}

/** Pengali laju baca dari tempo fader saja (tanpa bend). */
export function tempoRatio(t: DeckTempo): number {
  return 1 + tempoPercent(t) / 100;
}

/**
 * Laju baca EFEKTIF: tempo fader × bend jog. Ini yang dipakai audio nanti, dan
 * yang dipakai `tick()` sekarang — satu rumus, satu tempat.
 */
export function effectiveRate(d: DeckState): number {
  const bend = Number.isFinite(d.bend) && d.bend > 0 ? d.bend : 1;
  return Math.max(0, tempoRatio(d.tempo) * bend);
}

/** BPM yang benar-benar terdengar. `null` kalau grid lagu belum diketahui. */
export function effectiveBpm(baseBpm: number | null, t: DeckTempo): number | null {
  return baseBpm === null ? null : baseBpm * tempoRatio(t);
}

/**
 * Kebalikan `effectiveBpm`: posisi fader yang membuat `baseBpm` terdengar
 * sebagai `targetBpm`. Ini inti SYNC.
 *
 * Mengembalikan `null` kalau jawabannya di luar jangkauan range yang dipilih —
 * dan itu jawaban yang BENAR, bukan alasan untuk men-clamp diam-diam. Fader
 * yang mentok di ±16% sambil mengaku SYNC adalah kebohongan yang hanya
 * ketahuan lewat telinga, setelah dua lagu terlanjur melenceng di depan orang.
 */
export function faderForBpm(
  targetBpm: number,
  baseBpm: number,
  rangePct: TempoRange,
): number | null {
  if (!(baseBpm > 0) || !(targetBpm > 0)) return null;
  const fader = ((targetBpm / baseBpm - 1) * 100) / rangePct;
  if (!Number.isFinite(fader)) return null;
  return Math.abs(fader) <= 1 + 1e-9 ? clamp(fader, -1, 1) : null;
}

// ── Crossfader ───────────────────────────────────────────────────────────────

export interface CrossGains {
  readonly a: number;
  readonly b: number;
}

/** Lebar transisi kurva `cut`, dalam fraksi travel. */
const CUT_WIDTH = 0.02;

/**
 * Gain kedua deck dari posisi crossfader. Tiga kurva, dan bedanya bukan selera:
 *
 * - `smooth` (equal power, cosinus): `a² + b² = 1`. Menyilangkan dua lagu utuh
 *   tanpa lubang volume di tengah. Default.
 * - `sharp`: kedua sisi PENUH sepanjang setengah travel lalu turun linear. Di
 *   tengah keduanya 1.0 — itu bukan bug, itu yang dicari untuk potongan cepat.
 * - `cut`: praktis biner, dengan lereng 2% supaya tidak ada klik DC.
 *
 * MENGEMBALIKAN OBJEK BARU — jangan pernah dipakai sebagai selector store.
 * Panggil di dalam render, dari dua nilai primitif. Lihat catatan stabilitas
 * referensi di kepala `store.ts`.
 */
export function crossfaderGains(x: number, curve: CrossfaderCurve): CrossGains {
  const t = clamp(x, 0, 1);
  if (curve === 'smooth') {
    return { a: Math.cos((t * Math.PI) / 2), b: Math.sin((t * Math.PI) / 2) };
  }
  if (curve === 'sharp') {
    return { a: clamp((1 - t) * 2, 0, 1), b: clamp(t * 2, 0, 1) };
  }
  const edge = (v: number): number => clamp((v + CUT_WIDTH) / (2 * CUT_WIDTH), 0, 1);
  return { a: edge(0.5 - t), b: edge(t - 0.5) };
}

// ── Gain ─────────────────────────────────────────────────────────────────────

/**
 * Travel fader → gain linear.
 *
 * Bukan `faderToDb` Studio: unity di PUNCAK, dan travel 0 = gain 0 EKSAK
 * (bukan −96 dB). Kurva pangkat dua memberi kendali yang mirip fader mixer
 * nyata di sepertiga atas travel.
 */
export function channelFaderGain(travel: number): number {
  const t = clamp(travel, 0, 1);
  return t * t;
}

/** dB → linear, dengan KILL benar-benar nol. */
export function dbToGain(db: number): number {
  return db <= EQ_KILL_DB ? 0 : Math.pow(10, db / 20);
}

export interface FilterSpec {
  readonly type: 'lowpass' | 'highpass' | 'none';
  readonly cutoffHz: number;
  readonly q: number;
}

/** Zona mati di sekitar tengah supaya knob benar-benar bisa "mati". */
const FILTER_DEADZONE = 0.03;
export const FILTER_MIN_HZ = 30;
export const FILTER_MAX_HZ = 18_000;
const FILTER_Q_FLAT = Math.SQRT1_2;
const FILTER_Q_MAX = 8;

/**
 * Knob COLOR −1..+1 → spesifikasi filter.
 *
 * Frekuensinya EKSPONENSIAL: telinga mendengar RASIO, bukan selisih, dan sapuan
 * linear menghabiskan tiga perempat putaran knob di daerah yang tidak terdengar
 * berubah. Alasan yang sama sudah ditulis panjang di
 * `crates/engine/src/fx/filter.rs` — file ini adalah bayangannya di sisi UI,
 * untuk menggambar dan melabeli, bukan untuk memproses audio.
 */
export function filterSpec(knob: number): FilterSpec {
  const c = colorFilterCoeffs(knob);
  const k = clamp(knob, -1, 1);
  if (Math.abs(k) <= FILTER_DEADZONE) {
    return { type: 'none', cutoffHz: FILTER_MAX_HZ, q: FILTER_Q_FLAT };
  }
  return k < 0
    ? { type: 'lowpass', cutoffHz: c.lpHz, q: c.lpQ }
    : { type: 'highpass', cutoffHz: c.hpHz, q: c.hpQ };
}

/**
 * Koefisien untuk DUA biquad yang SELALU terpasang seri.
 *
 * Bentuk naif `if (knob < 0) lowpass else highpass` punya diskontinuitas nyata,
 * dan bukan di tempat orang mencarinya — bukan di frekuensinya, melainkan di
 * (a) STATE filter, yang maknanya bergantung koefisien sehingga menukar jenis
 * membuat state bukan-nol ditafsirkan sebagai milik filter lain, dan (b)
 * RESONANSI, yang pada Q tinggi menyisakan puncak di kedua ujung sapuan.
 * Hasilnya: klik tiap kali knob melewati tengah.
 *
 * Dengan dua biquad permanen, tidak ada cabang, tidak ada pergantian jenis, dan
 * tidak ada state yang direinterpretasi — diskontinuitasnya bukan "dihindari",
 * ia tidak ada. Harganya dua biquad per kanal, dan itu harga yang benar.
 *
 * Ini bayangan TypeScript dari `crates/engine/src/fx/filter.rs`, yang memuat
 * argumen lengkapnya. Kalau keduanya menyimpang, yang di Rust yang benar.
 */
export interface ColorFilterCoeffs {
  readonly lpHz: number;
  readonly lpQ: number;
  readonly hpHz: number;
  readonly hpQ: number;
}

export function colorFilterCoeffs(knob: number): ColorFilterCoeffs {
  const k = clamp(knob, -1, 1);
  const mag = Math.abs(k);
  // Zona mati: kedua filter diparkir di posisi yang benar-benar transparan.
  const t = mag <= FILTER_DEADZONE ? 0 : (mag - FILTER_DEADZONE) / (1 - FILTER_DEADZONE);
  const q = FILTER_Q_FLAT + (FILTER_Q_MAX - FILTER_Q_FLAT) * t;

  if (k < 0) {
    return {
      lpHz: FILTER_MAX_HZ * Math.pow(FILTER_MIN_HZ / FILTER_MAX_HZ, t),
      lpQ: t === 0 ? FILTER_Q_FLAT : q,
      hpHz: FILTER_MIN_HZ,
      hpQ: FILTER_Q_FLAT,
    };
  }
  return {
    lpHz: FILTER_MAX_HZ,
    lpQ: FILTER_Q_FLAT,
    hpHz: FILTER_MIN_HZ * Math.pow(FILTER_MAX_HZ / FILTER_MIN_HZ, t),
    hpQ: t === 0 ? FILTER_Q_FLAT : q,
  };
}

// ── Waktu & ketukan ──────────────────────────────────────────────────────────

const srOf = (d: DeckState): number => (d.sampleRate > 0 ? d.sampleRate : 48_000);

export const deckPositionSec = (d: DeckState): number => d.playhead / srOf(d);
export const deckDurationSec = (d: DeckState): number => d.frames / srOf(d);

/** Sisa waktu pada laju EFEKTIF — angka yang benar-benar dilihat DJ. */
export function deckRemainingSec(d: DeckState): number {
  const rate = effectiveRate(d);
  if (!(rate > 0)) return Infinity;
  return Math.max(0, (d.frames - d.playhead) / srOf(d) / rate);
}

export function beatsToSamples(beats: number, grid: BeatGrid, sr: number): Samples {
  return Math.max(MIN_LOOP_SAMPLES, Math.round(beats * samplesPerBeat(grid, sr)));
}

/**
 * Tempelkan posisi ke grid KALAU quantize menyala.
 *
 * Membungkus `snapSourceToGrid` supaya tidak ada pemanggil yang menulis ulang
 * cabang "quantize mati" sendiri — cabang itu yang paling sering terlupa di
 * satu dari delapan pad, dan gejalanya hanya muncul pada lagu tertentu.
 */
export function quantized(
  at: Samples,
  grid: BeatGrid | null,
  sr: number,
  on: boolean,
  div: QuantizeDiv,
): Samples {
  if (!on || grid === null || div === 'off') return at;
  return snapSourceToGrid(at, grid, sr, QUANTIZE_BEATS[div]);
}

/** Format `M:SS.d` seperti readout deck rekordbox (`03:40.2`). */
export function formatDeckTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--.-';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Format persen tempo seperti di platter: `+2.4%`, `0.0%`. */
export function formatTempoPct(pct: number, range: TempoRange): string {
  const digits = TEMPO_STEP_PCT[range] >= 0.5 ? 1 : 2;
  const v = pct.toFixed(digits);
  return `${pct > 0 ? '+' : ''}${v}%`;
}
