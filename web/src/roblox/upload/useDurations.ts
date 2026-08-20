/**
 * Mengukur durasi setiap baris yang belum punya angka.
 *
 * ## Kenapa `<audio>` dan bukan `decodeAudioData`
 *
 * Yang dibutuhkan halaman ini cuma SATU angka, dan `decodeAudioData`
 * membayarnya dengan mendekode seluruh lagu jadi PCM di memori — puluhan MB
 * per berkas, dikali panjang antrean, untuk sesuatu yang sudah tertulis di
 * header berkasnya. `<audio>` dengan `preload="metadata"` membaca header itu
 * saja. Sebagai bonus ia tidak butuh `AudioContext`, jadi halaman ini tidak
 * perlu menunggu gestur user seperti Studio dan DJ.
 *
 * ## Satu probe per baris, SEUMUR HIDUP baris itu
 *
 * Probe yang selesai memanggil `setDuration`, yang mengubah `items`, yang
 * menjalankan efek ini lagi. Kalau daftar "yang perlu diukur" dihitung ulang
 * dari state setiap kali, berkas ke-2 dibatalkan dan dimulai ulang setiap kali
 * berkas ke-1 selesai — 30 berkas berarti ratusan probe yang saling membunuh,
 * dan yang paling lambat mungkin tidak pernah selesai sama sekali. Karena itu
 * baris yang sudah pernah dimulai dicatat di `started` dan tidak pernah
 * disentuh lagi.
 *
 * ## Kegagalan bukan kesalahan
 *
 * Berkas rusak, codec yang tidak dikenal browser, atau `duration` yang
 * `Infinity` (MP3 VBR tanpa header Xing) semuanya berakhir sebagai `null` —
 * sama artinya dengan "belum terukur". Halaman menampilkannya `—`, dan
 * `violationsOf` TIDAK menuduhnya melewati batas 7 menit. Menebak nol berarti
 * berkas 9 menit lolos lalu ditolak Roblox; menuduhnya melanggar berarti
 * berkas sah tertahan gara-gara browser tidak bisa membaca headernya.
 */

import { useEffect, useRef } from 'react';

import { fileOf, robloxActions, useRoblox } from '../store';

export function useDurations(): void {
  // Yang dilanggan hanya `items`, bukan seluruh state: pengukuran tidak ada
  // hubungannya dengan API key yang sedang diketik.
  const items = useRoblox((s) => s.items);
  const started = useRef(new Set<number>());
  const cleanups = useRef(new Map<number, () => void>());

  useEffect(() => {
    if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') return;

    for (const item of items) {
      if (item.seconds !== null || started.current.has(item.id)) continue;
      const file = fileOf(item.id);
      if (file === undefined) continue;

      started.current.add(item.id);

      const url = URL.createObjectURL(file);
      const el = new Audio();
      el.preload = 'metadata';

      const release = (): void => {
        el.removeEventListener('loadedmetadata', onLoaded);
        el.removeEventListener('error', onError);
        // Kosongkan `src` lebih dulu: melepas object URL sementara elemen
        // masih memuatnya membuat sebagian browser melempar error jaringan.
        el.src = '';
        URL.revokeObjectURL(url);
        cleanups.current.delete(item.id);
      };

      function onLoaded(): void {
        robloxActions.setDuration(
          item.id,
          Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
        );
        release();
      }
      function onError(): void {
        robloxActions.setDuration(item.id, null);
        release();
      }

      el.addEventListener('loadedmetadata', onLoaded);
      el.addEventListener('error', onError);
      el.src = url;
      cleanups.current.set(item.id, release);
    }

    // Baris yang dihapus user tidak boleh meninggalkan object URL yang menahan
    // byte berkasnya di memori sampai tab ditutup.
    const live = new Set(items.map((it) => it.id));
    for (const [id, release] of [...cleanups.current]) {
      if (!live.has(id)) release();
    }
    for (const id of [...started.current]) {
      if (!live.has(id)) started.current.delete(id);
    }
  }, [items]);

  // Lepas semua yang masih menggantung saat halaman ditinggalkan.
  useEffect(() => {
    const pending = cleanups.current;
    return () => {
      for (const release of [...pending.values()]) release();
    };
  }, []);
}
