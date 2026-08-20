/**
 * AKAR RETENSI ASSET — daftar sumber referensi asset DI LUAR clip lane.
 *
 * ## Kenapa ini ada
 *
 * `assetsInUse` perlu menjawab satu pertanyaan: "asset ini masih dipakai?".
 * Jawaban naifnya dibaca dari `lanes` saja, dan itu benar selama satu-satunya
 * yang bisa memegang asset adalah clip.
 *
 * Sejak halaman `/dj` ada, itu tidak lagi benar: deck DJ memegang lagu **tanpa
 * satu pun clip**. Tanpa daftar ini, pemangkas mana pun yang memakai jawaban
 * naif itu akan menghapus data user tanpa satu pun pesan — import lagu di
 * `/dj` → byte-nya dipangkas dari IndexedDB → refresh → deck kosong tanpa
 * penjelasan. (Pemangkas otomatisnya sendiri sudah dibuang bersama autosave;
 * daftar ini tetap ada karena jalur simpan eksplisit yang menggantikannya
 * menanyakan hal yang persis sama.)
 *
 * ## Kenapa pendaftarannya di lingkup MODUL, bukan di `useEffect`
 *
 * Kalau akar hidup mengikuti komponen React, ia mati begitu user meninggalkan
 * `/dj` — dan itu PERSIS momen ketika perlindungannya paling dibutuhkan, karena
 * Studio baru menanyakan himpunan ini setelah user pindah ke sana.
 */

export type AssetRoot = () => Iterable<number>;

const roots = new Set<AssetRoot>();

/** Daftarkan sumber referensi. Kembaliannya melepas pendaftaran itu. */
export function registerAssetRoot(root: AssetRoot): () => void {
  roots.add(root);
  return () => {
    roots.delete(root);
  };
}

/**
 * Gabungan seluruh akar.
 *
 * Akar yang melempar DIABAIKAN, bukan dibiarkan menggagalkan perhitungan: satu
 * akar rusak tidak boleh membuat seluruh keep-set kosong, karena keep-set
 * kosong berarti MENGHAPUS SEMUANYA. Gagal ke arah menyimpan terlalu banyak
 * adalah satu-satunya arah gagal yang bisa dimaafkan di sini.
 */
export function collectAssetRoots(): Set<number> {
  const out = new Set<number>();
  for (const root of roots) {
    try {
      for (const id of root()) out.add(id);
    } catch {
      // sengaja diabaikan — lihat catatan di atas
    }
  }
  return out;
}

export function __clearAssetRootsForTest(): void {
  roots.clear();
}
