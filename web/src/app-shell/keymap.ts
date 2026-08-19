/**
 * KEYMAP — pemetaan chord → command, dengan override milik user.
 *
 * ## Bentuk: chord → id, bukan id → chord
 *
 * Yang ditanyakan dispatcher enam puluh kali per detik adalah "chord ini milik
 * siapa", bukan "command ini pakai tombol apa". Menyimpannya terbalik berarti
 * menyisir seluruh daftar tiap ketukan tombol.
 *
 * Lebih penting: bentuk ini membuat **satu chord tidak bisa dimiliki dua
 * command** secara struktural. Kalau disimpan `id → chord`, bentrokan hanya
 * ketahuan saat dua binding kebetulan diadu — dan sampai saat itu salah satunya
 * diam-diam kalah.
 *
 * ## Kenapa localStorage, bukan IndexedDB
 *
 * Sisa aplikasi memakai IndexedDB, dan itu benar untuk audio dan project. Tapi
 * keymap dibaca **sebelum render pertama** supaya daftar shortcut tidak
 * berkedip dari bawaan ke milik user. IndexedDB asinkron; localStorage sinkron
 * dan cukup untuk beberapa ratus byte preferensi.
 */

import { getCommand, listCommands } from './command';
import { isReservedChord, type Chord } from './keys';
import type { CommandId } from './command';

const STORAGE_KEY = 'daw-keymap-v1';

/**
 * Penyimpanan yang BENAR-BENAR bisa dipakai, atau `null`.
 *
 * `typeof localStorage === 'undefined'` TIDAK cukup sebagai penjaga, dan itu
 * ditemukan oleh tes: Node 22 mendefinisikan `localStorage` sebagai global yang
 * ADA tapi bernilai undefined kecuali dijalankan dengan `--localstorage-file`.
 * Safari dalam mode privat punya bentuk kegagalan yang sebelah lagi — propertinya
 * ada dan bertipe objek, tapi `setItem` melempar QuotaExceededError.
 *
 * Jadi yang diperiksa bukan keberadaannya melainkan APA YANG BISA DILAKUKAN
 * padanya, sekali, lewat satu tulis-hapus percobaan.
 */
function storage(): Storage | null {
  try {
    const s = globalThis.localStorage as Storage | undefined;
    if (s === undefined || s === null) return null;
    const probe = `${STORAGE_KEY}:probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** Override milik user: chord → id. Kosong berarti "pakai bawaan". */
let overrides: Record<Chord, CommandId> = load();
/** Command yang SENGAJA dilepas binding-nya oleh user. */
let unbound = new Set<CommandId>();

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) fn();
}

export function subscribeKeymap(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

interface Stored {
  readonly overrides?: Record<Chord, CommandId>;
  readonly unbound?: readonly CommandId[];
}

function load(): Record<Chord, CommandId> {
  const store = storage();
  if (store === null) return {};
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const data = JSON.parse(raw) as Stored;
    unbound = new Set(data.unbound ?? []);
    return data.overrides ?? {};
  } catch {
    // Keymap rusak bukan alasan untuk menolak menjalankan aplikasi.
    return {};
  }
}

function save(): void {
  const store = storage();
  if (store === null) return;
  try {
    const data: Stored = { overrides, unbound: [...unbound] };
    store.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Kuota penuh: keymap tetap berlaku untuk sesi ini, hanya tidak bertahan.
  }
}

/**
 * Peta chord → id yang BERLAKU: bawaan tiap command, ditimpa override user.
 *
 * Dihitung ulang tiap dipanggil dan tidak di-cache, karena daftar command
 * berubah saat halaman berpindah — cache di sini akan menahan binding milik
 * halaman yang sudah ditinggalkan.
 */
export function activeKeymap(): ReadonlyMap<Chord, CommandId> {
  const map = new Map<Chord, CommandId>();
  // Command yang chord-nya sudah dipilih user tidak lagi memakai bawaan —
  // TERMASUK aliasnya. Pilihan user MENGGANTIKAN, bukan menumpuk: kalau alias
  // tetap hidup, user yang memindahkan sebuah pintasan akan mendapati tombol
  // lamanya masih bekerja, dan tidak ada layar yang menjelaskan kenapa.
  const overridden = new Set(Object.values(overrides));

  for (const c of listCommands()) {
    if (unbound.has(c.id) || overridden.has(c.id)) continue;
    // Alias dipasang LEBIH DULU supaya chord utama menang kalau keduanya
    // kebetulan sama.
    for (const alias of c.defaultAliases ?? []) map.set(alias, c.id);
    if (c.defaultChord !== null) map.set(c.defaultChord, c.id);
  }
  // Override menang, DAN membuang binding bawaan command yang direbut
  // chord-nya — kalau tidak, satu command bisa punya dua chord yang salah
  // satunya tidak pernah dipilih user.
  for (const [chord, id] of Object.entries(overrides)) {
    if (getCommand(id) === undefined) continue;
    for (const [existing, owner] of [...map]) {
      if (owner === id && existing !== chord) map.delete(existing);
    }
    map.set(chord, id);
  }
  return map;
}

/**
 * Chord yang DITAMPILKAN untuk satu command, atau `null` kalau tidak terikat.
 *
 * Override user menang; kalau tidak ada, chord utama; alias tidak pernah
 * ditampilkan — daftar pintasan yang memajang dua tombol untuk satu aksi
 * membuat user mengira ia harus memilih.
 */
export function chordFor(id: CommandId): Chord | null {
  for (const [chord, owner] of Object.entries(overrides)) if (owner === id) return chord;
  if (unbound.has(id)) return null;
  return getCommand(id)?.defaultChord ?? null;
}

export interface BindResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Ikat `chord` ke `id`.
 *
 * Chord yang sudah dipakai command lain DIREBUT, dan command lama jadi tidak
 * terikat. Itu pilihan yang disengaja: menolak dengan "sudah dipakai" memaksa
 * user melepas dulu binding lama di layar lain sebelum bisa memasang yang baru —
 * dua langkah untuk satu maksud. Yang direbut dilaporkan lewat `reason` supaya
 * kejadiannya tetap terlihat, bukan senyap.
 */
export function bindChord(id: CommandId, chord: Chord): BindResult {
  if (getCommand(id) === undefined) return { ok: false, reason: 'command tidak dikenal' };
  if (isReservedChord(chord)) {
    return { ok: false, reason: 'tombol ini milik browser dan tidak bisa diambil alih' };
  }
  const previous = activeKeymap().get(chord);
  const stolen = previous !== undefined && previous !== id ? getCommand(previous) : undefined;

  // Chord lama command ini dilepas — termasuk aliasnya — supaya pilihan user
  // MENGGANTIKAN bawaan, bukan menumpuk di atasnya.
  for (const [c, owner] of Object.entries(overrides)) {
    if (owner === id) delete overrides[c];
  }
  if (stolen !== undefined) unbound.add(stolen.id);
  unbound.delete(id);
  overrides[chord] = id;
  save();
  emit();
  return stolen === undefined
    ? { ok: true }
    : { ok: true, reason: `diambil dari "${stolen.title}"` };
}

/** Lepas binding satu command. Ia tetap bisa dipanggil lewat palette. */
export function unbindCommand(id: CommandId): void {
  for (const [chord, owner] of Object.entries(overrides)) {
    if (owner === id) delete overrides[chord];
  }
  unbound.add(id);
  save();
  emit();
}

/** Kembalikan SEMUA binding ke bawaan. */
export function resetKeymap(): void {
  overrides = {};
  unbound = new Set();
  save();
  emit();
}

/** True kalau binding command ini bukan bawaannya. */
export function isCustomized(id: CommandId): boolean {
  if (unbound.has(id)) return true;
  return Object.values(overrides).includes(id);
}

/** Hanya untuk tes. */
export function __resetKeymapForTest(): void {
  overrides = {};
  unbound = new Set();
  emit();
}
