/**
 * Barrel halaman DJ. Hanya `DjPage` yang keluar — sisanya milik halaman ini.
 *
 * `model.ts` dan `store.ts` sengaja TIDAK di-re-export: satu-satunya yang boleh
 * memakainya dari luar adalah `studio/persist/asset-roots`, dan ia meng-import
 * `djAssetIds` secara langsung supaya ketergantungan itu terlihat di berkasnya
 * sendiri, bukan tersembunyi di balik barrel.
 */

export { DjPage, type DjPageProps } from './DjPage';
