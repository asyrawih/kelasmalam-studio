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

import {
  createMemory,
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
