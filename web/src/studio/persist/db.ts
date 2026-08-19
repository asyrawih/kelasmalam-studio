/**
 * Penyimpanan lokal project — IndexedDB, tanpa pustaka tambahan.
 *
 * KENAPA IndexedDB, bukan localStorage: localStorage hanya menyimpan string
 * dan kuotanya ~5 MB. Satu lagu saja sudah melebihi itu. IndexedDB menyimpan
 * `ArrayBuffer` apa adanya dan kuotanya ratusan MB.
 *
 * APA YANG DISIMPAN, dan kenapa justru itu:
 *   - metadata project (lane, clip, EQ, gain…) → kecil, JSON biasa
 *   - BYTE FILE ASLI tiap asset (.ogg/.wav/.mp3 seperti saat di-drop)
 *
 * Yang TIDAK disimpan: PCM hasil decode dan peak pyramid. PCM berukuran
 * puluhan kali lipat file aslinya (1 menit stereo 48k f32 ≈ 23 MB, sementara
 * ogg-nya ~1 MB), dan keduanya bisa dihasilkan ulang dengan cepat saat boot.
 * Menyimpan hasil turunan berarti membayar ruang untuk sesuatu yang bisa
 * dihitung — dan menambah satu bentuk data lagi yang bisa basi.
 */

const DB_NAME = 'daw-studio';
const DB_VERSION = 1;
const STORE_PROJECT = 'project';
const STORE_ASSETS = 'assets';
const PROJECT_KEY = 'current';
/**
 * Sesi halaman `/dj`, di object store `project` yang SUDAH ADA.
 *
 * Bukan store baru, dan itu keputusan: store baru menuntut `DB_VERSION` 1→2,
 * sementara `openDb` di bawah sudah memutuskan `onblocked` → `resolve(null)`.
 * Artinya satu tab lama yang masih terbuka akan mematikan persistensi SECARA
 * SENYAP di tab baru — kegagalan tanpa gejala, demi satu kunci yang sama saja
 * bisa hidup di store yang sudah ada.
 */
const DJ_KEY = 'dj';

export interface StoredAsset {
  readonly id: number;
  readonly name: string;
  /** Byte file ASLI (terenkode), bukan PCM. */
  readonly bytes: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null); // mode privat / storage diblokir
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECT)) db.createObjectStore(STORE_PROJECT);
      if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS);
    };
    req.onsuccess = () => resolve(req.result);
    // Kegagalan penyimpanan TIDAK BOLEH menghentikan aplikasi: user tetap bisa
    // bekerja, hanya tanpa persistensi.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (db === null) {
          resolve(null);
          return;
        }
        let req: IDBRequest<T>;
        try {
          req = run(db.transaction(store, mode).objectStore(store));
        } catch {
          db.close();
          resolve(null);
          return;
        }
        req.onsuccess = () => {
          resolve(req.result);
          db.close();
        };
        req.onerror = () => {
          resolve(null);
          db.close();
        };
      }),
  );
}

export function isPersistenceAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export async function saveProjectJson(json: string): Promise<boolean> {
  const r = await tx<IDBValidKey>(STORE_PROJECT, 'readwrite', (s) => s.put(json, PROJECT_KEY));
  return r !== null;
}

export async function loadProjectJson(): Promise<string | null> {
  const r = await tx<string>(STORE_PROJECT, 'readonly', (s) => s.get(PROJECT_KEY));
  return typeof r === 'string' ? r : null;
}

export async function saveDjSession(json: string): Promise<boolean> {
  const r = await tx<IDBValidKey>(STORE_PROJECT, 'readwrite', (s) => s.put(json, DJ_KEY));
  return r !== null;
}

export async function loadDjSession(): Promise<string | null> {
  const r = await tx<string>(STORE_PROJECT, 'readonly', (s) => s.get(DJ_KEY));
  return typeof r === 'string' ? r : null;
}

export async function saveAsset(asset: StoredAsset): Promise<boolean> {
  const r = await tx<IDBValidKey>(STORE_ASSETS, 'readwrite', (s) => s.put(asset, asset.id));
  return r !== null;
}

export async function loadAllAssets(): Promise<StoredAsset[]> {
  const r = await tx<StoredAsset[]>(STORE_ASSETS, 'readonly', (s) => s.getAll());
  return Array.isArray(r) ? r : [];
}

/** Buang asset yang tidak lagi dirujuk clip mana pun. */
export async function pruneAssets(keep: ReadonlySet<number>): Promise<void> {
  const all = await loadAllAssets();
  for (const a of all) {
    if (!keep.has(a.id)) {
      await tx<undefined>(STORE_ASSETS, 'readwrite', (s) => s.delete(a.id));
    }
  }
}

export async function clearAll(): Promise<void> {
  await tx<undefined>(STORE_PROJECT, 'readwrite', (s) => s.clear());
  await tx<undefined>(STORE_ASSETS, 'readwrite', (s) => s.clear());
}
