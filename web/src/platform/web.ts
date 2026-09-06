/**
 * Adapter platform: WEB.
 *
 * Ini KODE LAMA YANG DIPINDAH, bukan ditulis ulang: `pickSaveLocation`,
 * `downloadBlob`, dan `ObjectUrlRegistry` dari `encoders/index.ts`;
 * `loadModelBytes` (cache OPFS + fetch) dari `proof-stem/scnet-model.ts`;
 * `location.href = loginUrl` dari `LibraryDock`; `window.open` dari landing.
 * Perilakunya identik — yang berubah hanya alamat tempat ia tinggal, supaya
 * `desktop.ts` bisa menggantikannya tanpa satu pun `if (isTauri)` di komponen.
 *
 * Konsekuensinya: file ini SATU-SATUNYA tempat di luar tes yang boleh menulis
 * `location.href`, memanggil `showSaveFilePicker`, atau `window.open`.
 * `guard.test.ts` menjaga itu.
 */

import { createLibraryApi, type LibraryApi } from '../library/api';
import { assertModelSize, SCNET_MODELS, type ScnetModelDefinition, type ScnetModelDownloadProgress } from '../proof-stem/scnet-catalog';
import { FileSystemSink } from '../studio/export/sinks';
import type { ModelBytes, PlatformHost, SaveTarget } from './host';

// ── File delivery (dipindah dari encoders/index.ts) ─────────────────────────

/**
 * Object URL menahan Blob di memori/disk sampai di-revoke ATAU dokumen
 * dibongkar. Untuk export 170 MB yang diulang, lupa revoke = kebocoran nyata.
 *
 * Aturan di kode ini (docs/03 §3d): setiap `createObjectURL` didaftarkan di
 * sini, di-revoke setelah 60 detik dan pada `beforeunload`. 60 detik, bukan
 * segera: Safari membutuhkan URL tetap hidup saat unduhan dimulai.
 */
export class ObjectUrlRegistry {
  private static readonly urls = new Set<string>();
  private static installed = false;

  static create(blob: Blob, ttlMs = 60_000): string {
    ObjectUrlRegistry.install();
    const url = URL.createObjectURL(blob);
    ObjectUrlRegistry.urls.add(url);
    setTimeout(() => ObjectUrlRegistry.revoke(url), ttlMs);
    return url;
  }

  static revoke(url: string): void {
    if (ObjectUrlRegistry.urls.delete(url)) URL.revokeObjectURL(url);
  }

  static revokeAll(): void {
    for (const u of ObjectUrlRegistry.urls) URL.revokeObjectURL(u);
    ObjectUrlRegistry.urls.clear();
  }

  private static install(): void {
    if (ObjectUrlRegistry.installed || typeof window === 'undefined') return;
    ObjectUrlRegistry.installed = true;
    window.addEventListener('beforeunload', () => ObjectUrlRegistry.revokeAll());
  }
}

/** Apakah jalur streaming-ke-disk tersedia (Chromium; Firefox/Safari belum). */
export function canStreamToDisk(): boolean {
  return typeof globalThis !== 'undefined' && 'showSaveFilePicker' in globalThis;
}

/**
 * Minta lokasi simpan. **Harus dipanggil dari handler klik**, sebelum render
 * mulai — picker butuh user gesture (docs/03 §3d). Mengembalikan `null` kalau
 * tidak didukung atau user membatalkan.
 */
export async function pickSaveLocation(
  fileName: string,
  mime: string,
  ext: string,
): Promise<FileSystemFileHandle | null> {
  if (!canStreamToDisk()) return null;
  try {
    const picker = (
      globalThis as unknown as {
        showSaveFilePicker(o: unknown): Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    return await picker({
      suggestedName: fileName,
      types: [{ description: 'Audio', accept: { [mime]: ['.' + ext] } }],
    });
  } catch {
    // AbortError (user batal) maupun error lain → fallback ke jalur Blob.
    return null;
  }
}

/** Unduh Blob lewat anchor. Jalur baseline yang jalan di mana saja. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = ObjectUrlRegistry.create(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke ditangani ObjectUrlRegistry (60 s) — JANGAN revoke di sini.
}

// ── Model ONNX (dipindah dari proof-stem/scnet-model.ts) ────────────────────

/**
 * Cache di OPFS kalau ada, supaya 44–170 MB tidak diunduh ulang tiap kunjungan.
 * Tanpa OPFS (Safari lama, konteks tertentu) jalurnya fetch langsung ke memori
 * — tetap jalan, hanya tidak diingat.
 */
async function loadModelBytes(
  model: ScnetModelDefinition,
  onProgress: (progress: ScnetModelDownloadProgress) => void,
): Promise<ModelBytes> {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    const response = await fetchModel(model);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertModelSize(model, bytes.byteLength);
    onProgress({ loaded: bytes.byteLength, total: model.bytes, cacheHit: false });
    return { bytes, cacheHit: false };
  }

  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('scnet-models', { create: true });
  const fileName = `scnet-${model.id}-${model.sha256.slice(0, 12)}.onnx`;
  try {
    const existing = await directory.getFileHandle(fileName);
    const file = await existing.getFile();
    if (file.size === model.bytes) {
      onProgress({ loaded: file.size, total: model.bytes, cacheHit: true });
      return { bytes: new Uint8Array(await file.arrayBuffer()), cacheHit: true };
    }
    await directory.removeEntry(fileName);
  } catch {
    // Cache miss normal.
  }

  void navigator.storage.persist?.();
  const response = await fetchModel(model);
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  const reader = response.body?.getReader();
  let loaded = 0;
  try {
    if (reader === undefined) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writable.write(bytes);
      loaded = bytes.byteLength;
      onProgress({ loaded, total: model.bytes, cacheHit: false });
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        loaded += value.byteLength;
        onProgress({ loaded, total: model.bytes, cacheHit: false });
      }
    }
    await writable.close();
  } catch (reason) {
    await writable.abort(reason).catch(() => {});
    await directory.removeEntry(fileName).catch(() => {});
    throw reason;
  }

  assertModelSize(model, loaded);
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), cacheHit: false };
}

async function fetchModel(model: ScnetModelDefinition): Promise<Response> {
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`Download ${model.label} gagal: HTTP ${response.status}`);
  return response;
}

// ── Host ────────────────────────────────────────────────────────────────────

/**
 * Basis Worker kepustakaan dari env build. Kosong = build tanpa backend, dan
 * itu keadaan yang sah (docs/16 §6) — bukan galat.
 */
export function libraryApiBaseFromEnv(): string {
  return (import.meta.env.VITE_LIBRARY_API ?? '').trim();
}

export function createWebHost(opts: { readonly libraryApiBase?: string } = {}): PlatformHost {
  // Dibuat SEKALI per host, malas: dok memakai objek ini sebagai kunci
  // effect-nya, dan klien baru tiap panggilan berarti boot ulang tiap render.
  let library: LibraryApi | null | undefined;

  return {
    kind: 'web',

    libraryApi(): LibraryApi | null {
      if (library === undefined) {
        const base = (opts.libraryApiBase ?? libraryApiBaseFromEnv()).trim();
        library = base === '' ? null : createLibraryApi(base);
      }
      return library;
    },

    async pickSaveTarget(fileName, mime, ext): Promise<SaveTarget> {
      // Picker DULU, sebelum render: ia butuh user gesture, dan gesture-nya
      // hilang begitu kita menunggu batch pertama. `null` = browser tanpa File
      // System Access API (atau user batal) → jalur anchor+Blob.
      const handle = await pickSaveLocation(fileName, mime, ext);
      if (handle === null) {
        return { kind: 'blob', deliver: (blob) => downloadBlob(blob, fileName) };
      }
      return { kind: 'stream', sink: await FileSystemSink.create(handle) };
    },

    async openExternal(url): Promise<void> {
      window.open(url, '_blank', 'noopener');
    },

    login({ apiBase, nextPath }): Promise<void> {
      /*
       * NAVIGASI, bukan fetch: `/auth/google` membalas 302 ke layar consent
       * Google, dan mengambilnya lewat fetch tidak pernah bisa berhasil. Path
       * sekarang dititipkan supaya user kembali ke tempat ia menekan tombol.
       * Bentuk URL-nya sama persis dengan `LibraryApi.loginUrl`.
       */
      window.location.href = `${apiBase}/auth/google?next=${encodeURIComponent(nextPath)}`;
      // Halaman ini sedang dibongkar; tidak ada "sesudah" yang bisa dijanjikan.
      return new Promise<void>(() => {});
    },

    async authHeaders(): Promise<Record<string, string>> {
      // Sesi web adalah cookie `__Host-lib_session`; `credentials: 'include'`
      // di `library/api.ts` yang membawanya. Tidak ada header tambahan.
      return {};
    },

    modelBytes(id, onProgress): Promise<ModelBytes> {
      return loadModelBytes(SCNET_MODELS[id], onProgress);
    },
  };
}
