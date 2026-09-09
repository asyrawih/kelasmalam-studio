/**
 * Bentuk project yang bisa disimpan, dan cara memulihkannya kembali.
 *
 * TIDAK ADA SIMPAN OTOMATIS DI SINI, DAN TIDAK ADA PENYIMPANAN LOKAL SAMA
 * SEKALI. Versi sebelumnya berlangganan ke store dan menulis ke IndexedDB
 * 600 ms setelah perubahan apa pun — tiap geser clip, tiap tarik fade. Setiap
 * penulisan itu membaca ULANG byte terenkode SELURUH asset hanya untuk
 * mengetahui kunci mana yang masih dipakai. Dengan satu lagu 27 menit di
 * kepustakaan, itu puluhan MB yang di-deserialize lalu dibuang setiap kali
 * tangan user bergerak — dan itulah lag yang terasa terus-menerus di studio.
 * Pemicunya sudah dibuang lebih dulu; sekarang lapisan IndexedDB-nya ikut.
 *
 * Penggantinya penyimpanan yang EKSPLISIT: user menyimpan project ke
 * kepustakaannya sendiri, yang di-upload ke object storage lewat backend.
 * Fungsi di bawah — `serialize`, `deserialize`, `normalizeLanes`,
 * `restoreProject`, `assetsInUse` — adalah bahan untuk jalur itu dan sengaja
 * dipertahankan; yang dibuang adalah SUMBERNYA, bukan bentuk datanya.
 * `restoreProject` karena itu menerima JSON dan byte dari pemanggil alih-alih
 * membacanya sendiri: dari mana byte itu datang bukan urusan modul ini.
 * Konsekuensi yang harus disebut terang-terangan: sampai jalur simpan itu ada,
 * project TIDAK bertahan melewati refresh.
 *
 * Bentuk yang disimpan sengaja hanya berisi hal yang MERUPAKAN PROJECT.
 * State transien (sedang play, sedang drag, clipboard, progress export, status
 * engine) tidak ikut: memulihkan "sedang playing" setelah refresh akan membuat
 * audio berbunyi tanpa user menekan apa pun, dan memulihkan "sedang drag"
 * membuat UI macet menunggu pointer yang tidak pernah dilepas.
 */

import { DEFAULT_LANE_HEIGHT, type StudioLane, type StudioState } from '../model';
import {
  DEFAULT_PANEL_ORDER,
  DEFAULT_RAIL_ORDER,
  studioActions,
  type StudioAppState,
} from '../store';
import { normalizeClipLoop } from '../timeline/clip-loop';
import { normalizeClipFade } from '../timeline/fade';
import { normalizeClipStem } from '../timeline/stem';
import { collectAssetRoots } from './asset-roots';

/** Naikkan kalau bentuk data berubah dan yang lama tidak bisa dibaca lagi. */
const SCHEMA_VERSION = 1;

/**
 * Clip sebagaimana ia DISIMPAN: `StudioClip` + `contentHash`.
 *
 * `assetId` tetap ditulis, dan itu bukan kelebihan: ia yang membuat project
 * yang ditulis SEBELUM L1 tetap terbuka, dan ia yang dipakai kalau hash-nya
 * tidak ketemu di kepustakaan. Yang dipakai lebih dulu saat memulihkan adalah
 * hash — nomor sesi tidak berarti apa-apa di sesi berikutnya (docs/16 §2).
 */
type PersistedClip = StudioLane['clips'][number] & { readonly contentHash?: string };
type PersistedLane = Omit<StudioLane, 'clips'> & { readonly clips: PersistedClip[] };

interface PersistedProject {
  readonly version: number;
  readonly projectName: string;
  readonly sampleRate: number;
  readonly lanes: PersistedLane[];
  readonly playhead: number;
  readonly speed: number;
  readonly loop: boolean;
  readonly minDurationSec: number;
  readonly maxDurationSec: number | null;
  readonly eqMode: StudioAppState['eqMode'];
  readonly laneHeight?: StudioAppState['laneHeight'];
  readonly panelOrder: StudioAppState['panelOrder'];
  readonly railOrder: StudioAppState['railOrder'];
  readonly masterGainDb: number;
  /**
   * Insert chain master. Opsional dan TIDAK menaikkan `SCHEMA_VERSION` —
   * dibaca dengan `?? []`, jadi project yang tersimpan sebelum FX ada tetap
   * terbuka. Menaikkan versi berarti membuang project user demi satu array
   * yang kosong di semuanya.
   */
  readonly masterChain?: StudioState['masterChain'];
  readonly renderSpeed: number;
  readonly exportFileName: string;
  readonly selectedLaneId: string | null;
  readonly selectedClipId: string | null;
  /**
   * Koreksi beat grid per asset. OPSIONAL dan bukan bagian dari `assets`:
   * asset sendiri (envelope, tempo hasil deteksi) memang sengaja TIDAK disimpan
   * dan dibangun ulang tiap boot (docs/10). Yang tidak bisa dibangun ulang
   * adalah keputusan user — BPM yang ia ketik dan downbeat yang ia geser — dan
   * hanya itu yang ikut ke sini.
   *
   * Ditambahkan tanpa menaikkan `SCHEMA_VERSION`: field baru yang opsional
   * dibaca dengan `?? {}`, jadi project lama tetap terbuka. Menaikkan versi
   * berarti membuang project yang sudah ada demi satu peta kecil.
   */
  readonly assetGrids?: Record<number, PersistedGrid>;
  /**
   * Koreksi grid ber-kunci HASH — kembaran `assetGrids` yang bertahan melewati
   * sesi.
   *
   * Keduanya ditulis, dan yang lama tidak dibuang: project yang disimpan
   * sebelum L1 hanya punya `assetGrids`, dan membuangnya berarti membuang
   * koreksi BPM yang sudah diketik user demi kerapian bentuk data.
   */
  readonly assetGridsByHash?: Record<string, PersistedGrid>;
}

interface PersistedGrid {
  readonly bpm: number | null;
  readonly offsetSec: number | null;
  /** Opsional: project lama tidak punya field ini dan dibaca sebagai `false`. */
  readonly lock?: boolean;
  /**
   * Anchor ruas (`[Dynamic]`). Opsional dengan alasan yang sama: project yang
   * ditulis sebelum fitur ini ada membacanya sebagai "tidak ada ruas tambahan",
   * yang memang keadaan mereka.
   */
  readonly anchors?: readonly { readonly atSec: number; readonly bpm: number }[];
}

/**
 * Hanya asset yang BENAR-BENAR dikoreksi yang ikut disimpan.
 *
 * Kunci analisis ikut jadi syarat, bukan hanya ikut jadi field: lagu yang
 * dikunci TANPA koreksi grid — sah, artinya "hasil deteksinya sudah benar,
 * jangan disentuh lagi" — akan kehilangan kuncinya tiap refresh kalau
 * syaratnya hanya melihat kedua override.
 */
function collectAssetGrids(s: StudioAppState): Record<number, PersistedGrid> {
  const out: Record<number, PersistedGrid> = {};
  for (const a of Object.values(s.assets)) {
    const anchors = a.beatAnchors ?? null;
    if (
      a.bpmOverride === null &&
      a.beatOffsetOverride === null &&
      anchors === null &&
      !a.analysisLock
    ) {
      continue;
    }
    out[a.id] = {
      bpm: a.bpmOverride,
      offsetSec: a.beatOffsetOverride,
      lock: a.analysisLock,
      // Dihilangkan kalau kosong, supaya project lama dan project baru tanpa
      // ruas tambahan menghasilkan JSON yang identik.
      ...(anchors === null ? null : { anchors }),
    };
  }
  return out;
}

/**
 * Sematkan `contentHash` ke tiap clip.
 *
 * Ini inti L1: yang tersimpan harus menunjuk lagu yang SAMA saat dibuka lagi
 * besok. `assetId` numerik adalah penghitung sesi — nomor 3 hari ini dan nomor
 * 3 besok adalah lagu yang berbeda, dan project yang menyimpannya menunjuk
 * lagu yang SALAH tanpa satu pun tanda (docs/16 §2).
 *
 * Asset tanpa hash (hasil bake) tetap tersimpan dengan `assetId` saja — ia
 * memang tidak punya identitas yang bertahan, dan §8e belum memutuskan
 * nasibnya. Yang tidak boleh terjadi adalah ia hilang diam-diam dari project.
 */
function laneWithHashes(s: StudioAppState): PersistedLane[] {
  return s.lanes.map((lane) => ({
    ...lane,
    clips: lane.clips.map((clip) => {
      const hash = s.assets[clip.assetId]?.contentHash ?? '';
      return hash === '' ? clip : { ...clip, contentHash: hash };
    }),
  }));
}

/** `collectAssetGrids`, tapi ber-kunci hash. Asset tanpa hash dilewati. */
function collectAssetGridsByHash(s: StudioAppState): Record<string, PersistedGrid> {
  const byId = collectAssetGrids(s);
  const out: Record<string, PersistedGrid> = {};
  for (const [id, grid] of Object.entries(byId)) {
    const hash = s.assets[Number(id)]?.contentHash ?? '';
    if (hash !== '') out[hash] = grid;
  }
  return out;
}

export function serialize(s: StudioAppState): string {
  const data: PersistedProject = {
    version: SCHEMA_VERSION,
    projectName: s.projectName,
    sampleRate: s.sampleRate,
    lanes: laneWithHashes(s),
    playhead: s.playhead,
    speed: s.speed,
    loop: s.loop,
    minDurationSec: s.minDurationSec,
    maxDurationSec: s.maxDurationSec,
    eqMode: s.eqMode,
    laneHeight: s.laneHeight,
    panelOrder: s.panelOrder,
    railOrder: s.railOrder,
    masterGainDb: s.masterGainDb,
    masterChain: s.masterChain,
    renderSpeed: s.renderSpeed,
    exportFileName: s.exportFileName,
    selectedLaneId: s.selectedLaneId,
    selectedClipId: s.selectedClipId,
    assetGrids: collectAssetGrids(s),
    assetGridsByHash: collectAssetGridsByHash(s),
  };
  return JSON.stringify(data);
}

/** null kalau tidak ada / tidak bisa dibaca — bukan alasan untuk gagal boot. */
export function deserialize(json: string): PersistedProject | null {
  try {
    const d = JSON.parse(json) as Partial<PersistedProject>;
    if (d.version !== SCHEMA_VERSION) return null;
    if (!Array.isArray(d.lanes) || d.lanes.length === 0) return null;
    if (typeof d.sampleRate !== 'number' || d.sampleRate <= 0) return null;
    return d as PersistedProject;
  } catch {
    return null;
  }
}

/**
 * Isi field clip yang belum ada di project versi lama.
 *
 * Beda dengan `panelOrder`/`railOrder` yang cukup diberi default sekali di
 * pemanggilan `hydrate`: clip ada di dalam ARRAY di dalam lane, jadi
 * `data.clipField ?? default` tidak punya tempat untuk ditulis. Normalisasi
 * harus turun sampai ke tiap clip, sekali, di pintu masuk.
 */
export function normalizeLanes(lanes: StudioLane[]): StudioLane[] {
  return lanes.map((l) => ({
    ...l,
    // Project yang tersimpan sebelum FX ada tidak punya field ini. Default
    // WAJIB diberikan di sini, bukan dibiarkan `undefined`: `lane.chain.map`
    // di payload akan melempar, dan gejalanya muncul saat export — jauh dari
    // penyebabnya.
    chain: l.chain ?? [],
    clips: (l.clips ?? []).map((c) => {
      const n = normalizeClipLoop(normalizeClipStem(normalizeClipFade(c)));
      // Default diberikan SETELAH normalisasi: fungsi-fungsi itu mengembalikan
      // clip aslinya apa adanya kalau tidak ada yang perlu diperbaiki, jadi
      // memberi default sebelumnya akan tertimpa lagi.
      return { ...n, chain: n.chain ?? [] };
    }),
  }));
}

export interface RestoreResult {
  readonly restored: boolean;
  /** Asset yang gagal di-decode ulang — clip-nya ada tapi bisu. */
  readonly missingAssets: number;
}

/** Satu asset sebagaimana ia disimpan: byte file ASLI, bukan PCM. */
export interface StoredAssetBytes {
  /** Id yang akan dipakai asset ini DI SESI INI. */
  readonly id: number;
  readonly name: string;
  readonly bytes: ArrayBuffer;
  /**
   * SHA-256 berkasnya, kalau pemanggil mengetahuinya (kepustakaan selalu tahu).
   *
   * Inilah yang menyambungkan clip tersimpan ke asset sesi ini. Tanpa hash,
   * pemulihan jatuh ke `assetId` lama — cukup untuk project yang ditulis
   * sebelum L1, dan salah untuk yang mana pun sesudahnya.
   */
  readonly contentHash?: string;
}

/**
 * Tulis ulang `assetId` tiap clip memakai peta hash → id sesi ini.
 *
 * Clip yang hash-nya tidak dikenal DIBIARKAN memakai `assetId` lamanya. Itu
 * bukan kelalaian: project lama tidak punya hash sama sekali, dan clip yang
 * asetnya memang hilang harus tetap ada di timeline sebagai clip bisu — bukan
 * lenyap. Yang hilang tanpa jejak tidak bisa diperbaiki user; yang bisu bisa.
 */
export function relinkLanes(
  lanes: readonly PersistedLane[],
  byHash: ReadonlyMap<string, number>,
): StudioLane[] {
  return lanes.map((lane) => ({
    ...lane,
    clips: lane.clips.map((clip) => {
      const hash = clip.contentHash;
      if (hash === undefined || hash === '') return stripHash(clip);
      const id = byHash.get(hash);
      return id === undefined ? stripHash(clip) : { ...stripHash(clip), assetId: id };
    }),
  })) as StudioLane[];
}

/** `contentHash` tidak ikut masuk state runtime — di sana yang berlaku `assetId`. */
function stripHash(clip: PersistedClip): StudioLane['clips'][number] {
  if (clip.contentHash === undefined) return clip;
  const { contentHash: _buang, ...rest } = clip;
  return rest;
}

/**
 * Pulihkan project + decode ulang audionya.
 *
 * `json` dan `assets` datang DARI PEMANGGIL, bukan dibaca sendiri. Modul ini
 * tidak boleh punya pendapat tentang tempat penyimpanan: yang dulu IndexedDB
 * akan menjadi backend, dan satu-satunya hal yang tetap benar di kedua dunia
 * adalah bentuk datanya.
 *
 * `decodeAsset` juga disuntikkan (bukan diimpor langsung) supaya modul ini bisa
 * dites tanpa Web Audio.
 */
export async function restoreProject(
  json: string,
  assets: readonly StoredAssetBytes[],
  decodeAsset: (id: number, name: string, bytes: ArrayBuffer) => Promise<boolean>,
): Promise<RestoreResult> {
  const data = deserialize(json);
  if (data === null) return { restored: false, missingAssets: 0 };

  // Audio dipulihkan LEBIH DULU, baru state. Kalau urutannya dibalik, UI
  // sempat menggambar clip yang asetnya belum ada dan waveform-nya berkedip
  // dari mock ke bentuk asli.
  let missing = 0;
  /** hash → id sesi ini. Inilah peta yang docs/16 §2 sebut dibangun tiap sesi. */
  const byHash = new Map<string, number>();
  for (const a of assets) {
    const ok = await decodeAsset(a.id, a.name, a.bytes);
    if (!ok) {
      missing += 1;
      continue;
    }
    // Hanya yang BERHASIL di-decode yang masuk peta: clip yang menunjuk asset
    // gagal-decode lebih baik tetap menunjuk id lamanya dan jadi bisu daripada
    // menunjuk asset yang tidak pernah terdaftar.
    if (a.contentHash !== undefined && a.contentHash !== '') byHash.set(a.contentHash, a.id);
  }

  studioActions.hydrate({
    projectName: data.projectName,
    sampleRate: data.sampleRate,
    lanes: normalizeLanes(relinkLanes(data.lanes, byHash)),
    playhead: data.playhead,
    speed: data.speed as StudioState['speed'],
    loop: data.loop,
    minDurationSec: data.minDurationSec,
    maxDurationSec: data.maxDurationSec,
    eqMode: data.eqMode,
    laneHeight: data.laneHeight ?? DEFAULT_LANE_HEIGHT,
    // Data lama (sebelum panel bisa diurutkan) tidak punya field ini —
    // WAJIB memberi default, bukan `undefined`: menulis key dengan undefined
    // tetap menimpa nilai yang sudah ada di store.
    panelOrder: data.panelOrder ?? DEFAULT_PANEL_ORDER,
    railOrder: data.railOrder ?? DEFAULT_RAIL_ORDER,
    // Project lama tidak punya field ini — WAJIB di-default, bukan undefined.
    masterGainDb: data.masterGainDb ?? 0,
    masterChain: data.masterChain ?? [],
    renderSpeed: data.renderSpeed ?? 1,
    exportFileName: data.exportFileName ?? '',
    selectedLaneId: data.selectedLaneId,
    selectedClipId: data.selectedClipId,
  });

  /*
   * Grid ber-HASH dipakai lebih dulu, dan yang ber-id numerik jadi cadangan
   * untuk project yang ditulis sebelum L1.
   *
   * Urutannya penting: yang ber-hash ditulis belakangan supaya ia menang kalau
   * keduanya menyebut asset yang sama. Kalau dibalik, koreksi BPM user
   * ditimpa oleh nomor sesi yang kebetulan bertabrakan.
   */
  // SETELAH hydrate, bukan sebelum: `setAssetBeatGrid` menolak asset yang belum
  // terdaftar, dan pendaftarannya baru terjadi lewat `decodeAsset` di atas.
  for (const [id, grid] of Object.entries(data.assetGrids ?? {})) {
    // Grid DULU, kunci belakangan. `setAssetBeatGrid` menolak asset yang
    // terkunci, jadi urutan terbalik akan memulihkan kuncinya dan membuang
    // justru koreksi yang dikunci itu.
    studioActions.setAssetBeatGrid(Number(id), { bpm: grid.bpm, offsetSec: grid.offsetSec });
    studioActions.setAssetBeatAnchors(Number(id), grid.anchors ?? null);
    if (grid.lock === true) studioActions.setAnalysisLock(Number(id), true);
  }

  for (const [hash, grid] of Object.entries(data.assetGridsByHash ?? {})) {
    const id = byHash.get(hash);
    if (id === undefined) continue;
    studioActions.setAssetBeatGrid(id, { bpm: grid.bpm, offsetSec: grid.offsetSec });
    studioActions.setAssetBeatAnchors(id, grid.anchors ?? null);
    if (grid.lock === true) studioActions.setAnalysisLock(id, true);
  }

  return { restored: true, missingAssets: missing };
}

/**
 * Himpunan asset yang MASIH DIPAKAI: clip di lane ∪ semua akar terdaftar.
 *
 * Fungsi terpisah dan diekspor supaya bisa dites tanpa penyimpanan apa pun.
 * Yang bisa salah diam-diam di sini adalah HIMPUNANNYA — dan bug-nya berbentuk
 * data user yang hilang, yaitu kelas bug yang paling mahal untuk ditemukan dari
 * layar. Ia menjawab "apa yang perlu ikut disimpan/di-upload", bukan lagi "apa
 * yang boleh dipangkas".
 *
 * Akar didaftarkan lewat `asset-roots.ts`; halaman `/dj` memakainya untuk
 * lagu yang duduk di deck tanpa satu pun clip.
 */
export function assetsInUse(s: StudioAppState): Set<number> {
  const used = collectAssetRoots();
  for (const lane of s.lanes) {
    for (const clip of lane.clips) used.add(clip.assetId);
  }
  return used;
}
