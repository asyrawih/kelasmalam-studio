/**
 * PEMAKAIAN ASET — siapa yang masih memegang sebuah aset, dijawab oleh yang
 * memegangnya.
 *
 * Core tidak tahu apa itu clip atau lane (docs/25 P4), tapi penghapusan aset
 * dari kepustakaan (`dj/browser/dj-remove.ts`) HARUS bisa menolak dengan
 * alasan: clip yang menunjuk asset hantu tidak melempar apa pun — ia hanya
 * menggambar placeholder dan diam saat diputar, dan penyebabnya terjadi di
 * halaman lain beberapa menit sebelumnya. Maka jawabannya didaftarkan oleh
 * lapisan yang tahu: `studio/store.ts` mendaftarkan penghitung berbasis lane
 * saat modulnya dimuat, `studio-fl` (docs/24) akan mendaftarkan miliknya.
 *
 * Pendaftaran di lingkup MODUL, bukan `useEffect`, dengan alasan yang sama
 * dengan `persist/asset-roots.ts`: perlindungan ini justru paling dibutuhkan
 * saat user sedang TIDAK berada di halaman Studio.
 */

export interface AssetUsage {
  /** Berapa pemakai (clip) yang menunjuk aset ini. */
  readonly count: number;
  /** Nama tempat pemakainya (nama lane), untuk kalimat penolakan. */
  readonly where: readonly string[];
}

export type AssetUsageProvider = (assetId: number) => AssetUsage;

const providers = new Set<AssetUsageProvider>();

/** Daftarkan satu sumber jawaban. Kembaliannya melepas pendaftaran itu. */
export function registerAssetUsage(provider: AssetUsageProvider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/**
 * Gabungan jawaban seluruh penyedia.
 *
 * Penyedia yang melempar DIABAIKAN, bukan dibiarkan menggagalkan hitungan —
 * dan arah gagalnya adalah "tidak dipakai", yang berarti aset BISA terhapus.
 * Itu disengaja, dan berbeda dari `collectAssetRoots` yang gagal ke arah
 * menyimpan: di sini yang dipertaruhkan bukan data user (byte-nya tetap ada di
 * kepustakaan), melainkan satu baris yang hilang dari Collection. Membekukan
 * tombol hapus karena satu penyedia rusak lebih membingungkan daripada itu.
 */
export function assetUsage(assetId: number): AssetUsage {
  let count = 0;
  const where: string[] = [];
  for (const provider of providers) {
    try {
      const u = provider(assetId);
      count += u.count;
      where.push(...u.where);
    } catch {
      // sengaja diabaikan — lihat catatan di atas
    }
  }
  return { count, where };
}

export function __clearAssetUsageForTest(): void {
  providers.clear();
}
