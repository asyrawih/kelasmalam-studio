/**
 * Pembungkus `invoke` BERTIPE untuk kontrak `local-commands.ts` (docs/21 §2a).
 *
 * `invoke` mentah menerima nama string apa pun dan mengembalikan `unknown` —
 * salah ketik nama command atau salah bentuk argumen baru ketahuan saat app
 * desktop dijalankan. Di sini nama, argumen, dan hasil diikat ke peta
 * `LocalCommands`, jadi `callLocal('library_tracks', {})` sudah bertipe
 * `readonly LocalTrack[]` dan `callLocal('library_traks', {})` tidak lolos
 * kompilasi. Tes bentuk di `local-invoke.test.ts` memastikan setiap nama di
 * `LOCAL_COMMAND_NAMES` bisa lewat sini, supaya kontrak dan pembungkusnya
 * tidak diam-diam melenceng.
 *
 * ## Dua jalur biner
 *
 * Byte lagu TIDAK boleh lewat JSON (docs/21 §1c): lagu 25 MB sebagai array
 * angka adalah 100 MB teks yang di-parse di main thread. Maka:
 *   - `library_blob` → Rust menjawab `tauri::ipc::Response`, `invoke`
 *     memberi `ArrayBuffer`. Dinormalkan di sini karena versi Tauri tertentu
 *     memberi `Uint8Array` (dan tes boleh memberi `number[]`).
 *   - `library_put_bytes` → badan mentah `Uint8Array` + metadata di header
 *     `x-hash`/`x-ext`. Ia TIDAK bisa lewat `callLocal` — tipe `callLocal`
 *     mengecualikannya, dan `putLocalBytes` adalah satu-satunya pintunya.
 *
 * ## Galat
 *
 * Rust menolak dengan `LocalError` (`{ code, message, … }`) yang diserialisasi
 * serde. Di sisi ini penolakan dibungkus jadi `LocalCommandError` — sebuah
 * `Error` sungguhan (punya stack, bisa `throw`) yang MEMENUHI `LocalError`,
 * jadi `isLocalError(e)` mengenalinya tanpa `instanceof` lintas modul.
 * Penolakan yang bukan `LocalError` (string dari command yang belum
 * terstruktur, galat plugin) tetap dibungkus dengan kode `IO`: pemanggil cukup
 * menangani satu bentuk.
 */

import { invoke } from '@tauri-apps/api/core';
import type { LocalCommandName, LocalCommands, LocalError } from './local-commands';

const LOCAL_ERROR_CODES: ReadonlySet<string> = new Set<LocalError['code']>([
  'NOT_FOUND',
  'IN_USE',
  'VERSION_CONFLICT',
  'DISK_FULL',
  'INVALID',
  'SECRET_UNAVAILABLE',
  'HTTP',
  'YOUTUBE',
  'IO',
]);

/** `{ code, message }` dengan kode yang terdaftar di kontrak — dari Rust atau dari kelas di bawah. */
export function isLocalError(value: unknown): value is LocalError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { code?: unknown; message?: unknown };
  return typeof v.code === 'string' && LOCAL_ERROR_CODES.has(v.code) && typeof v.message === 'string';
}

export class LocalCommandError extends Error implements LocalError {
  readonly code: LocalError['code'];
  readonly count?: number;
  readonly currentVersion?: number;
  readonly status?: number;

  constructor(err: LocalError) {
    super(err.message);
    this.name = 'LocalCommandError';
    this.code = err.code;
    if (err.count !== undefined) this.count = err.count;
    if (err.currentVersion !== undefined) this.currentVersion = err.currentVersion;
    if (err.status !== undefined) this.status = err.status;
  }
}

/** Apa pun yang keluar dari `invoke` yang ditolak → satu bentuk. */
export function toLocalError(reason: unknown): LocalCommandError {
  if (reason instanceof LocalCommandError) return reason;
  if (isLocalError(reason)) return new LocalCommandError(reason);
  // Command yang mengembalikan `Result<_, String>`, lemparan plugin, atau
  // `{ code, message }` dengan kode di luar kontrak: tidak ada kode yang bisa
  // dibaca, tapi pesannya tetap milik user — jangan diganti kalimat umum.
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : typeof (reason as { message?: unknown } | null)?.message === 'string'
          ? (reason as { message: string }).message
          : 'perintah lokal gagal tanpa pesan';
  return new LocalCommandError({ code: 'IO', message });
}

/** Command yang argumen dan hasilnya JSON — semuanya kecuali jalur unggah biner. */
export type JsonLocalCommandName = Exclude<LocalCommandName, 'library_put_bytes'>;

/** Byte biner boleh datang sebagai `ArrayBuffer`, `Uint8Array`, atau `number[]` (tes). */
export function toArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  if (raw instanceof Uint8Array) {
    // Salin kalau view-nya tidak menutupi seluruh buffer — pemanggil menerima
    // ArrayBuffer utuh, bukan potongan yang kebetulan lebih besar.
    return raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
      ? (raw.buffer as ArrayBuffer)
      : raw.slice().buffer;
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]).buffer;
  throw new LocalCommandError({ code: 'IO', message: 'jawaban biner dari Rust tidak dikenali' });
}

/**
 * Panggil satu command JSON. Penolakan selalu keluar sebagai `LocalCommandError`.
 *
 * `library_blob` ikut lewat sini (argumennya JSON; hanya jawabannya yang
 * biner) dan hasilnya dinormalkan ke `ArrayBuffer`.
 */
export async function callLocal<K extends JsonLocalCommandName>(
  cmd: K,
  args: LocalCommands[K]['args'],
): Promise<LocalCommands[K]['result']> {
  let raw: unknown;
  try {
    raw = await invoke<unknown>(cmd, args as Record<string, unknown>);
  } catch (reason: unknown) {
    throw toLocalError(reason);
  }
  if (cmd === 'library_blob' || cmd === 'soundcloud_bytes' || cmd === 'youtube_bytes') {
    return toArrayBuffer(raw) as LocalCommands[K]['result'];
  }
  return raw as LocalCommands[K]['result'];
}

/**
 * `library_put_bytes`: byte lagu sebagai BADAN MENTAH, metadata di header.
 *
 * Bentuk `invoke(cmd, Uint8Array, { headers })` adalah cara Tauri 2 mengirim
 * `tauri::ipc::Request` dengan badan biner; Rust membaca `x-hash` dan `x-ext`
 * dari `request.headers()`. Argumen JSON tidak ada — hash dan ext tidak
 * dikirim dua kali.
 */
export async function putLocalBytes(hash: string, ext: string, bytes: ArrayBuffer | Uint8Array): Promise<void> {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    await invoke<null>('library_put_bytes', body, { headers: { 'x-hash': hash, 'x-ext': ext } });
  } catch (reason: unknown) {
    throw toLocalError(reason);
  }
}
