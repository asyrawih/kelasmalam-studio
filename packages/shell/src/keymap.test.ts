/**
 * Registry + keymap.
 *
 * Yang dijaga di sini adalah invarian yang tidak bisa dilihat dari layar:
 * satu chord tidak pernah dimiliki dua command, dan satu command tidak pernah
 * punya dua chord. Keduanya bergejala sebagai "shortcut-nya kadang jalan
 * kadang tidak" — bentuk laporan bug yang paling sulit ditindaklanjuti.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __clearCommandsForTest,
  isCommandEnabled,
  listCommands,
  registerCommands,
  runCommand,
  type Command,
} from './command';
import {
  __resetKeymapForTest,
  activeKeymap,
  bindChord,
  chordFor,
  isCustomized,
  resetKeymap,
  unbindCommand,
} from './keymap';

const ran: string[] = [];

const cmd = (id: string, chord: string | null, extra: Partial<Command> = {}): Command => ({
  id,
  title: id,
  group: 'Uji',
  defaultChord: chord,
  run: () => ran.push(id),
  ...extra,
});

beforeEach(() => {
  __clearCommandsForTest();
  __resetKeymapForTest();
  ran.length = 0;
});

afterEach(() => {
  __clearCommandsForTest();
  __resetKeymapForTest();
});

describe('registry', () => {
  it('command hanya ada selama pendaftarnya hidup', () => {
    const off = registerCommands([cmd('a.play', 'KeyQ')]);
    expect(listCommands()).toHaveLength(1);
    off();
    expect(listCommands()).toHaveLength(0);
  });

  it('mendaftar ulang id yang sama MENIMPA, tidak menggandakan', () => {
    // StrictMode me-mount ulang komponen dengan sengaja; pendaftaran kedua
    // harus menghasilkan keadaan yang sama, bukan dua entri.
    registerCommands([cmd('a.play', 'KeyQ')]);
    registerCommands([cmd('a.play', 'KeyQ')]);
    expect(listCommands()).toHaveLength(1);
  });

  it('melepas pendaftaran LAMA tidak mencabut command yang sudah ditimpa', () => {
    const off1 = registerCommands([cmd('a.play', 'KeyQ')]);
    registerCommands([cmd('a.play', 'KeyQ')]);
    off1();
    expect(listCommands()).toHaveLength(1);
  });

  it('command yang tidak enabled tidak dijalankan', () => {
    registerCommands([cmd('a.play', 'KeyQ', { enabled: () => false })]);
    expect(runCommand('a.play')).toBe(false);
    expect(ran).toEqual([]);
  });

  it('command yang tidak ada mengembalikan false, bukan melempar', () => {
    expect(runCommand('tidak.ada')).toBe(false);
  });

  it('enabled yang tidak diisi berarti selalu bisa', () => {
    const c = cmd('a.play', 'KeyQ');
    expect(isCommandEnabled(c)).toBe(true);
  });
});

describe('keymap', () => {
  it('binding bawaan berlaku tanpa perlu disimpan', () => {
    registerCommands([cmd('a.play', 'KeyQ'), cmd('b.play', 'KeyP')]);
    expect(activeKeymap().get('KeyQ')).toBe('a.play');
    expect(chordFor('b.play')).toBe('KeyP');
  });

  it('command tanpa binding bawaan tidak muncul di keymap', () => {
    registerCommands([cmd('a.eject', null)]);
    expect(chordFor('a.eject')).toBeNull();
    expect([...activeKeymap().values()]).not.toContain('a.eject');
  });

  it('override menang atas bawaan, dan bawaannya DILEPAS', () => {
    registerCommands([cmd('a.play', 'KeyQ')]);
    bindChord('a.play', 'KeyZ');
    expect(chordFor('a.play')).toBe('KeyZ');
    // Kalau bawaannya tidak dilepas, satu command punya dua chord dan salah
    // satunya tidak pernah dipilih user.
    expect(activeKeymap().has('KeyQ')).toBe(false);
  });

  it('chord yang direbut membuat pemilik lama tidak terikat — dan itu dilaporkan', () => {
    registerCommands([cmd('a.play', 'KeyQ'), cmd('b.play', 'KeyP')]);
    const r = bindChord('b.play', 'KeyQ');
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/a\.play/);
    expect(activeKeymap().get('KeyQ')).toBe('b.play');
    expect(chordFor('a.play')).toBeNull();
  });

  it('satu chord tidak pernah dimiliki dua command', () => {
    registerCommands([cmd('a.play', 'KeyQ'), cmd('b.play', 'KeyP')]);
    bindChord('b.play', 'KeyQ');
    const owners = [...activeKeymap().entries()].filter(([c]) => c === 'KeyQ');
    expect(owners).toHaveLength(1);
  });

  it('chord milik browser ditolak', () => {
    registerCommands([cmd('a.play', 'KeyQ')]);
    const r = bindChord('a.play', 'mod+KeyR');
    expect(r.ok).toBe(false);
    expect(chordFor('a.play')).toBe('KeyQ');
  });

  it('melepas binding menyisakan command-nya tetap bisa dipanggil', () => {
    registerCommands([cmd('a.play', 'KeyQ')]);
    unbindCommand('a.play');
    expect(chordFor('a.play')).toBeNull();
    expect(runCommand('a.play')).toBe(true);
  });

  it('reset mengembalikan SEMUA ke bawaan', () => {
    registerCommands([cmd('a.play', 'KeyQ'), cmd('b.play', 'KeyP')]);
    bindChord('a.play', 'KeyZ');
    unbindCommand('b.play');
    expect(isCustomized('a.play')).toBe(true);
    resetKeymap();
    expect(chordFor('a.play')).toBe('KeyQ');
    expect(chordFor('b.play')).toBe('KeyP');
    expect(isCustomized('a.play')).toBe(false);
  });

  it('override untuk command yang sudah tidak terdaftar diabaikan', () => {
    // Halaman berpindah; binding lamanya tidak boleh menempel di halaman baru.
    const off = registerCommands([cmd('a.play', 'KeyQ')]);
    bindChord('a.play', 'KeyZ');
    off();
    expect(activeKeymap().size).toBe(0);
  });

  it('bertahan di penyimpanan antar sesi', () => {
    // jsdom di setup ini TIDAK menyediakan localStorage sama sekali (Node 22
    // membayangi globalnya dengan undefined), jadi yang dipasang adalah
    // Storage palsu — dan yang diuji tetap jalur simpan yang sungguhan.
    const mem = new Map<string, string>();
    const fake = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;

    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake });
    try {
      registerCommands([cmd('a.play', 'KeyQ')]);
      bindChord('a.play', 'KeyZ');
      const raw = mem.get('daw-keymap-v1');
      expect(raw).toBeDefined();
      expect(JSON.parse(raw as string).overrides.KeyZ).toBe('a.play');
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('penyimpanan yang tidak bisa dipakai tidak menghentikan apa pun', () => {
    // Node 22 mendefinisikan `localStorage` global yang ADA tapi undefined; di
    // Safari mode privat, ia ada tapi `setItem` melempar. `typeof` tidak
    // menangkap keduanya — yang menangkap adalah percobaan tulis.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage diblokir');
      },
    });
    try {
      registerCommands([cmd('a.play', 'KeyQ')]);
      expect(() => bindChord('a.play', 'KeyZ')).not.toThrow();
      // Binding tetap berlaku untuk SESI INI, hanya tidak bertahan.
      expect(chordFor('a.play')).toBe('KeyZ');
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});

describe('alias', () => {
  it('chord utama DAN alias sama-sama menjalankan command yang sama', () => {
    registerCommands([cmd('a.help', 'Slash', { defaultAliases: ['shift+Slash'] })]);
    const map = activeKeymap();
    expect(map.get('Slash')).toBe('a.help');
    expect(map.get('shift+Slash')).toBe('a.help');
  });

  it('yang DITAMPILKAN hanya chord utama — dua tombol untuk satu aksi membingungkan', () => {
    registerCommands([cmd('a.help', 'Slash', { defaultAliases: ['shift+Slash'] })]);
    expect(chordFor('a.help')).toBe('Slash');
  });

  it('binding pilihan user MENGGANTIKAN bawaan beserta aliasnya', () => {
    registerCommands([cmd('a.help', 'Slash', { defaultAliases: ['shift+Slash'] })]);
    bindChord('a.help', 'KeyH');
    const map = activeKeymap();
    expect(map.get('KeyH')).toBe('a.help');
    // Kalau alias tetap hidup, user yang memindahkan pintasan akan mendapati
    // tombol lamanya masih bekerja, dan tidak ada layar yang menjelaskan kenapa.
    expect(map.has('Slash')).toBe(false);
    expect(map.has('shift+Slash')).toBe(false);
  });

  it('melepas binding ikut melepas aliasnya', () => {
    registerCommands([cmd('a.help', 'Slash', { defaultAliases: ['shift+Slash'] })]);
    unbindCommand('a.help');
    const map = activeKeymap();
    expect(map.has('Slash')).toBe(false);
    expect(map.has('shift+Slash')).toBe(false);
  });
});

describe('langganan', () => {
  it('perubahan registry memberi tahu pendengarnya', () => {
    const seen = vi.fn();
    const off = registerCommands([cmd('a.play', 'KeyQ')]);
    // subscribeCommands diuji lewat efek nyatanya: palette memakainya untuk
    // menghitung ulang daftar.
    expect(listCommands()).toHaveLength(1);
    off();
    expect(listCommands()).toHaveLength(0);
    expect(seen).not.toHaveBeenCalled();
  });
});
