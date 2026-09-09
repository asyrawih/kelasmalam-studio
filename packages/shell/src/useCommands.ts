/**
 * Daftarkan command selama komponen hidup.
 *
 * `list` sengaja dibaca lewat ref dan pendaftarannya TIDAK bergantung pada
 * identitas array: daftar command dibangun ulang tiap render (fungsinya
 * menutup atas props), dan menjadikannya dependensi berarti mendaftar-ulang
 * enam puluh kali per detik — yang juga akan memicu langganan palette
 * sebanyak itu.
 *
 * Yang menentukan kapan mendaftar ulang adalah `deps`, dan pemanggil yang
 * memutuskannya. Untuk halaman DJ jawabannya `[]`: daftar command-nya tetap,
 * yang berubah hanya apa yang dilakukan `run()` saat dipanggil — dan itu
 * dibaca dari store, bukan dari closure.
 */

import { useEffect, useRef } from 'react';

import { registerCommands, type Command } from './command';

export function useCommands(list: readonly Command[], deps: readonly unknown[] = []): void {
  const latest = useRef(list);
  latest.current = list;

  useEffect(() => {
    // Bungkus tiap command supaya `run` selalu memakai daftar TERBARU, bukan
    // yang tertangkap saat pendaftaran.
    const wrapped: Command[] = latest.current.map((c) => ({
      ...c,
      run: () => latest.current.find((x) => x.id === c.id)?.run(),
      enabled: () => {
        const live = latest.current.find((x) => x.id === c.id);
        return live?.enabled === undefined ? true : live.enabled();
      },
    }));
    return registerCommands(wrapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
