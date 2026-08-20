/**
 * @vitest-environment node
 *
 * Negosiasi plafon linear memory.
 *
 * Kenapa ini punya tes sendiri: `createMemory` adalah satu-satunya tempat di
 * mana menaikkan plafon bisa berbalik jadi kegagalan yang JAUH lebih buruk dari
 * masalah yang diperbaikinya. Varian `mt` meng-IMPORT memory-nya, jadi objek
 * `WebAssembly.Memory` dibuat SEBELUM instantiate — kalau pembuatannya melempar
 * dan tidak ada yang menangkapnya, yang gagal bukan export melainkan boot.
 * Aplikasinya tidak muncul sama sekali.
 *
 * Jadi yang di-assert di sini bukan "dapat 4 GiB", tapi "tidak pernah menyerah
 * selama masih ada tingkat di bawahnya", dan "melaporkan plafon yang BENAR-BENAR
 * didapat" — angka itu yang dipakai penjaga export, dan penjaga yang memakai
 * angka salah lebih buruk daripada tidak ada penjaga.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createMemory,
  declaredMemoryMaximumPages,
  MEMORY_FALLBACK_PAGES,
  MEMORY_MAXIMUM_PAGES,
  WASM_PAGE_BYTES,
} from './wasm-loader';

const RealMemory = WebAssembly.Memory;

afterEach(() => {
  WebAssembly.Memory = RealMemory;
  vi.restoreAllMocks();
});

/** Ganti `WebAssembly.Memory` dengan yang menolak apa pun di atas `capPages`. */
function capMemoryAt(capPages: number): { seen: number[] } {
  const seen: number[] = [];
  WebAssembly.Memory = function (descriptor: WebAssembly.MemoryDescriptor) {
    seen.push(descriptor.maximum ?? 0);
    if ((descriptor.maximum ?? 0) > capPages) {
      throw new RangeError('WebAssembly.Memory(): could not allocate memory');
    }
    return new RealMemory(descriptor);
  } as unknown as typeof WebAssembly.Memory;
  return { seen };
}

describe('negosiasi plafon linear memory', () => {
  it('4 GiB adalah batas MUTLAK wasm32, bukan pilihan', () => {
    // Linear memory dialamati pointer 32 bit. wasm-ld menolak `--max-memory`
    // di atas angka ini ("maximum memory too large"), jadi 8/16 GiB tidak bisa
    // dicapai lewat konfigurasi apa pun — hanya lewat memory64.
    expect(MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES).toBe(4 * 1024 ** 3);
    expect(MEMORY_FALLBACK_PAGES * WASM_PAGE_BYTES).toBe(2 * 1024 ** 3);
  });

  it('meminta 4 GiB lebih dulu dan melaporkannya kalau dapat', () => {
    const { seen } = capMemoryAt(MEMORY_MAXIMUM_PAGES);
    const r = createMemory('mt');
    expect(seen).toEqual([MEMORY_MAXIMUM_PAGES]);
    expect(r.maximumBytes).toBe(MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES);
  });

  it('turun ke 2 GiB — bukan gagal boot — kalau mesin menolak 4 GiB', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { seen } = capMemoryAt(MEMORY_FALLBACK_PAGES);

    const r = createMemory('mt');

    expect(seen).toEqual([MEMORY_MAXIMUM_PAGES, MEMORY_FALLBACK_PAGES]);
    // Yang PALING penting: plafon yang dilaporkan adalah yang sungguhan didapat.
    // Melaporkan 4 GiB di sini akan meloloskan export yang pasti kehabisan
    // memori di tengah render — persis bug yang penjaganya dibuat untuk cegah.
    expect(r.maximumBytes).toBe(MEMORY_FALLBACK_PAGES * WASM_PAGE_BYTES);
    // Penurunan diam-diam menyembunyikan kenapa project panjang tiba-tiba
    // ditolak di satu browser tapi tidak di browser lain.
    expect(warn).toHaveBeenCalled();
  });

  it('kalau 2 GiB pun ditolak, errornya naik apa adanya', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    capMemoryAt(0);
    // Ini bukan lagi soal ukuran, dan menelannya berarti menukar pesan mesin
    // yang spesifik dengan kegagalan yang tidak bisa didiagnosis.
    expect(() => createMemory('mt')).toThrow(/could not allocate memory/);
  });

  it('varian st tidak meminta shared memory', () => {
    const seenShared: (boolean | undefined)[] = [];
    WebAssembly.Memory = function (d: WebAssembly.MemoryDescriptor & { shared?: boolean }) {
      seenShared.push(d.shared);
      return new RealMemory(d);
    } as unknown as typeof WebAssembly.Memory;

    createMemory('st');
    createMemory('mt');
    expect(seenShared).toEqual([undefined, true]);
  });
});


/**
 * Plafon yang DIDEKLARASIKAN artefak.
 *
 * Ini kelas kegagalan yang benar-benar terjadi: sesudah plafon naik ke 4 GiB,
 * siapa pun yang belum menjalankan `pnpm build:wasm` masih memegang artefak
 * yang di-link 2 GiB. Loader meminta memory 4 GiB, instantiate menolaknya
 * dengan "imported Memory with incompatible maximum size", dan seluruh engine
 * mati — pesannya tidak menyebut artefak sama sekali. Artefak tidak dilacak
 * git, jadi `git pull` tidak akan pernah memperbaikinya sendiri.
 */
describe('declaredMemoryMaximumPages', () => {
  const leb = (n: number): number[] => {
    const out: number[] = [];
    do {
      const byte = n & 0x7f;
      n >>>= 7;
      out.push(n !== 0 ? byte | 0x80 : byte);
    } while (n !== 0);
    return out;
  };

  /** Binary wasm minimal: header + satu section import. */
  const wasmWithImports = (entries: number[][]): Uint8Array => {
    const payload = [...leb(entries.length), ...entries.flat()];
    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x02, ...leb(payload.length), ...payload,
    ]);
  };

  const name = (t: string): number[] => [t.length, ...[...t].map((c) => c.charCodeAt(0))];
  /** flags 0x03 = shared + punya maximum. */
  const memImport = (min: number, max: number | null): number[] => [
    ...name('env'),
    ...name('memory'),
    0x02,
    max === null ? 0x02 : 0x03,
    ...leb(min),
    ...(max === null ? [] : leb(max)),
  ];
  const funcImport = (): number[] => [...name('env'), ...name('f'), 0x00, ...leb(0)];

  it('membaca maximum dari import memory', () => {
    expect(declaredMemoryMaximumPages(wasmWithImports([memImport(18, 32768)]))).toBe(32768);
    expect(declaredMemoryMaximumPages(wasmWithImports([memImport(256, 65536)]))).toBe(65536);
  });

  it('melewati import lain sebelum memory-nya', () => {
    const bytes = wasmWithImports([funcImport(), funcImport(), memImport(18, 32768)]);
    expect(declaredMemoryMaximumPages(bytes)).toBe(32768);
  });

  /**
   * `null` berarti "jangan membatasi", bukan "nol". Ketiga kasus di bawah harus
   * mengembalikan perilaku ke sebelum fungsi ini ada — menebak angka di sini
   * akan menurunkan plafon untuk semua orang.
   */
  it('mengembalikan null kalau tidak bisa ditentukan', () => {
    expect(declaredMemoryMaximumPages(wasmWithImports([memImport(18, null)]))).toBeNull();
    expect(declaredMemoryMaximumPages(wasmWithImports([funcImport()]))).toBeNull();
    expect(declaredMemoryMaximumPages(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(declaredMemoryMaximumPages(new Uint8Array(0))).toBeNull();
  });

  it('tidak melempar untuk binary yang terpotong di tengah', () => {
    const full = wasmWithImports([memImport(18, 32768)]);
    for (let cut = 8; cut < full.length; cut++) {
      expect(() => declaredMemoryMaximumPages(full.subarray(0, cut))).not.toThrow();
    }
  });

  /**
   * Dan yang paling penting: artefak SUNGGUHAN di pohon ini harus sepakat
   * dengan angka yang diminta loader. Kalau tes ini merah, artefaknya basi —
   * jalankan `pnpm build:wasm`. Itu bukan kegagalan palsu: aplikasinya memang
   * tidak akan boot dalam keadaan itu.
   */
  it('artefak mt di pohon ini cocok dengan plafon yang diminta loader', () => {
    const url = new URL('../wasm/mt/engine_bg.wasm', import.meta.url);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(fileURLToPath(url));
    } catch {
      return; // artefak belum dibangun — tes lain sudah menutupi kasus itu
    }
    expect(declaredMemoryMaximumPages(bytes)).toBe(MEMORY_MAXIMUM_PAGES);
  });
});

/**
 * Negosiasi tidak boleh MEMINTA lebih dari yang dideklarasikan artefak. Ini
 * bukan optimisasi: `maximum` yang melebihi milik modul membuat instantiate
 * gagal, dan gagalnya di tempat yang tidak dijaga fallback mana pun.
 */
describe('createMemory dibatasi deklarasi artefak', () => {
  it('meminta persis plafon artefak, tidak pernah di atasnya', () => {
    const cap = capMemoryAt(MEMORY_MAXIMUM_PAGES);
    const { maximumBytes } = createMemory('mt', MEMORY_FALLBACK_PAGES);
    expect(cap.seen).toEqual([MEMORY_FALLBACK_PAGES]);
    expect(maximumBytes).toBe(MEMORY_FALLBACK_PAGES * WASM_PAGE_BYTES);
  });

  it('null = tanpa batas dari artefak: perilaku lama, 4 GiB dulu', () => {
    const cap = capMemoryAt(MEMORY_MAXIMUM_PAGES);
    const { maximumBytes } = createMemory('mt', null);
    expect(cap.seen).toEqual([MEMORY_MAXIMUM_PAGES]);
    expect(maximumBytes).toBe(MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES);
  });

  /** Dua batas sekaligus: artefak mengizinkan 4 GiB, mesinnya tidak. */
  it('tetap turun ke fallback kalau mesin yang menolak', () => {
    const cap = capMemoryAt(MEMORY_FALLBACK_PAGES);
    const { maximumBytes } = createMemory('mt', MEMORY_MAXIMUM_PAGES);
    expect(cap.seen).toEqual([MEMORY_MAXIMUM_PAGES, MEMORY_FALLBACK_PAGES]);
    expect(maximumBytes).toBe(MEMORY_FALLBACK_PAGES * WASM_PAGE_BYTES);
  });
});
