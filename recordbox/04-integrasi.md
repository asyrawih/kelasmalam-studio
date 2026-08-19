# 04 — Yang disentuh di luar `web/src/dj/`

Halaman DJ berdiri sendiri, kecuali enam titik. Tiap titik di sini punya alasan
kenapa ia TIDAK bisa diselesaikan di dalam folder `dj/` saja.

---

## 1. `web/src/Root.tsx` — routing jadi tabel

`routeOf` dulu satu perbandingan kesetaraan (`=== '/studio'`). Sekarang tabel
`path → route`, sehingga halaman keempat cukup menambah satu baris dan tidak
menyentuh logikanya.

Deep link ke `/dj` **tidak butuh perubahan hosting**: `deploy/nginx.conf`
(`try_files … /index.html`) dan `deploy/vercel-config.json` (rewrite terakhir)
sudah menangani path apa pun.

Tesnya (`landing/__tests__/landing.test.tsx`) tidak hanya memeriksa path, tapi
juga bahwa **`App` TIDAK ter-mount di `/dj`** — `App` memasang interval playhead,
autosave, dan mencoba membangun `AudioContext` begitu ia mount, jadi itu bagian
dari kontrak router, bukan detail kosmetik.

---

## 2. `studio/timeline/ScrollingWave.tsx` — satu baris yang berarti

```diff
-  const heardSec = previewPositionSec();
+  const heardSec = (p.positionSourceSec ?? previewPositionSec)();
```

Seluruh kopling ada di `centerOf`. Yang perlu diganti ternyata hanya jam-nya,
karena `clipStart = 0` + `speedRatio = 1` membuat sisa pemetaannya jadi
identitas (lihat `02-model-store.md` keputusan 1).

Prop-nya **fungsi, bukan angka**: ia dipanggil di dalam loop rAF, jadi posisi
boleh bergerak 60×/detik tanpa satu render React pun. Prop `center` yang sudah
ada tidak bisa dipakai — ia dibaca dari `latest.current`, yang hanya segar saat
React me-render.

Tiga prop kosmetik menyusul (`regionTint`, `regionStroke`, `title`) supaya
adaptor DJ tidak perlu menyalin komponennya demi warna sorotan loop.

Perilaku Studio **tidak bergeser**, dan itu dibuktikan `scrolling-wave.test.tsx`:
tanpa prop, `previewPositionSec` tetap yang dipanggil; dengan prop, ia **tidak**
dipanggil sama sekali.

---

## 3. `studio/timeline/audio-import.ts` — ekstraksi `importBytesToAsset`

`importBytesToLane` dulu mengerjakan sniff → gunzip → decode → envelope →
`registerAsset` → `requestAssetTempo` → `registerBuffer` → `saveAsset` **dan**
membuat clip. Deck butuh semuanya kecuali clip.

Sekarang `importBytesToAsset` mengerjakan jalur decode, dan `importBytesToLane`
memanggilnya lalu menambah satu clip. `importFileToLane` dan `url-to-lane.ts`
tidak berubah sama sekali — `DropResult` tetap bentuknya.

Kenapa tidak digandakan saja: kalau ada dua jalur decode, sniffing, envelope, dan
penyimpanan byte bisa menyimpang antar halaman, dan gejalanya adalah **waveform
yang berubah bentuk hanya karena file-nya diimpor dari tempat lain** — persis
cacat yang `assetFromBuffer` sendiri sudah ada untuk mencegahnya.

Tipe kegagalan `importBytesToAsset` **mewajibkan** `reason` (beda dari
`DropResult` yang membuatnya opsional), supaya tidak ada pemanggil baru yang bisa
gagal bisu.

---

## 4. `studio/persist/asset-roots.ts` (baru) + `persistence.ts` — jebakan retensi

**Bug yang diperbaiki, dieja lengkap:** `startAutosave` menghitung
`used = lanes.flatMap(clips → assetId)` lalu `pruneAssets(used)`. Lagu yang
diimpor di `/dj` tidak duduk di lane mana pun. Urutan yang membunuhnya:

```
import di /dj → buka /studio → autosave pertama memangkas byte-nya
              → refresh → deck kosong, tanpa satu pun pesan
```

Penghapusannya terjadi **di halaman yang bahkan tidak sedang menampilkan
datanya**, dan baru terlihat setelah refresh. Itu kelas bug yang paling mahal
untuk ditemukan dari layar.

Perbaikannya bukan menambal `/dj` ke dalam rumus itu, tapi memindahkan definisi
"terpakai" keluar dari satu halaman:

```ts
export type AssetRoot = () => Iterable<number>;
export function registerAssetRoot(root: AssetRoot): () => void;
export function assetsInUse(s: StudioAppState): Set<number>;  // clip ∪ akar
```

Dua hal yang disengaja:

- **Pendaftarannya di lingkup MODUL**, bukan di `useEffect`. Kalau akar hidup
  mengikuti komponen React, ia mati begitu user meninggalkan `/dj` — yaitu
  persis momen autosave Studio berjalan.
- **Akar yang melempar diabaikan.** Satu akar rusak tidak boleh mengosongkan
  keep-set, karena keep-set kosong berarti MENGHAPUS SEMUANYA. Gagal ke arah
  menyimpan terlalu banyak adalah satu-satunya arah gagal yang bisa dimaafkan.

Diuji murni (tanpa IndexedDB, tanpa timer) di `asset-roots.test.ts`.

---

## 5. `studio/persist/decode-asset.ts` (baru) — kepustakaan tanpa project

`/dj` butuh daftar lagu tapi **tidak boleh** memanggil `restoreProject`: fungsi
itu meng-hydrate seluruh state Studio termasuk lane, dan memanggilnya dari
halaman yang tidak menampilkan timeline berarti menimpa pekerjaan user dengan
apa pun yang kebetulan tersimpan.

`decodeStoredAsset` diekstrak dari `usePersistence.ts` (yang sekarang
memanggilnya), dan `loadLibraryIntoStore` memuat seluruh kepustakaan tanpa
menyentuh lane. Satu jalur decode pemulihan untuk kedua halaman — envelope hasil
pemulihan wajib identik dari halaman mana pun.

---

## 6. Entry point

`LandingPage` mendapat tombol **MODE DJ** di nav (prop `onOpenDj` opsional, jadi
pemanggil lama tidak perlu berubah), dan `StudioHeader` mendapat tombol yang sama
supaya berpindah antar dua alat tidak perlu lewat landing.

---

## Yang TIDAK disentuh

`graph-builder.ts`, `audio-preview.ts`, `fx-node.ts`, worklet, dan seluruh
`crates/` tidak berubah satu baris pun di iterasi ini — konsekuensi langsung dari
keputusan "UI dulu, audio menyusul". Perubahan pertama di sana adalah
`fxchain_set_tempo` (Utang 4), dan itu masuk fase D8.
