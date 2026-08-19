# GRID EDIT — merapikan beat grid dengan tangan

Riset + rencana untuk panel `[GRID EDIT]` rekordbox di halaman `/dj`.

Dokumen ini melunasi bagian pertama **Utang 3** di `recordbox/00-plan.md`:
grid ber-BPM konstan yang meleset 0.01 BPM akan merayap keluar dari transiennya
dalam enam menit, dan sampai detektornya diperbaiki **satu-satunya jalan keluar
adalah tangan user**. Grid Edit bukan fitur kenyamanan di sini — ia adalah
katup pengaman untuk seluruh loop, quantize, beat jump, dan SYNC yang menumpang
grid yang sama.

---

## 1. Apa yang sebenarnya ada di rekordbox

Sumbernya `recordbox/01a-riset-mentah.md` §6.2, ditulis ulang di sini sebagai
daftar kontrol supaya bisa dicentang satu per satu.

| # | Kontrol rekordbox | Artinya secara matematis |
|---|---|---|
| 1 | Jadikan posisi playhead **ketukan pertama sebuah bar** | set anchor = posisi playhead |
| 2 | Jarak grid ditampilkan **sebagai BPM**, bisa diketik | set `bpm`, anchor tetap |
| 3 | **`[TAP]`** | BPM dari rata-rata interval ketukan tangan |
| 4 | Geser grid **kiri/kanan 1 ms** | `anchor += ±0.001` |
| 5 | **Rapatkan/renggangkan** 1 ms (3 ms saat `[fine]`) | ubah panjang ketukan ±1 ms, anchor tetap |
| 6 | **×2 / ÷2** BPM | `bpm *= 2` / `/= 2`, anchor tetap |
| 7 | Cakupan **seluruh lagu** vs **dari posisi ini** | satu anchor vs banyak anchor (Dynamic) |
| 8 | **Set ulang grid dari posisi sekarang** | anchor pindah ke playhead, BPM dihitung ulang |
| 9 | **Undo / redo** | riwayat suntingan grid |
| 10 | **Metronom** on/off + 3 tingkat volume | klik yang dijadwalkan dari grid |
| 11 | **`[Analysis Lock]`** | kunci: analisis ulang & grid edit ditolak |

Dua batasan yang rekordbox umumkan dan **wajib ikut ditiru**, karena keduanya
janji ke user:

- **Analisis ulang menimpa koreksi grid manual.** (Kita menyimpang — lihat §7.)
- **Grid tidak bisa disunting saat tersambung PRO DJ LINK.** Tidak berlaku di
  sini; analog terdekatnya dibahas di §6.

Dan satu perbedaan mode yang menentukan seluruh bentuk rencana ini:
**`[Normal]` menulis SATU tempo + satu anchor untuk seluruh lagu; `[Dynamic]`
menaruh banyak beat marker di tiap titik pergeseran tempo.**

---

## 2. Apa yang sudah ada di repo ini

Lebih banyak dari yang terlihat. Yang belum ada bukan matematikanya, melainkan
**permukaannya di halaman `/dj`** — di sana grid sama sekali tidak bisa disentuh.

| Bahan | Berkas | Isi |
|---|---|---|
| Model grid | `web/src/studio/analysis/beat-grid.ts` | `BeatGrid { bpm, offsetSec, beatsPerBar, manual }`, `resolveBeatGrid`, `beatLinesIn`, `beatIndexAt`, `sourceAtBeat`, `snapSourceToGrid` |
| Penyimpanan koreksi | `web/src/studio/store.ts` | `StudioAsset.bpmOverride`, `.beatOffsetOverride`, `.tempoOctave` |
| Aksi | `studioActions` | `setAssetBeatGrid({ bpm?, offsetSec? })`, `resetAssetBeatGrid`, `shiftAssetTempoOctave` |
| Gambar grid | `web/src/studio/timeline/beat-draw.ts` | `drawBeatGrid`, `drawPlayhead` — satu penggambar, dipakai Studio DAN deck DJ |
| Waveform geser | `web/src/studio/timeline/ScrollingWave.tsx` | pemetaan px→SOURCE sudah benar lewat `onScrub` |
| Deck DJ | `web/src/dj/wave/DeckScrollingWave.tsx` | `clipStart=0`, `speedRatio=1` — koordinatnya identitas |
| Retensi | `web/src/studio/persist/persistence.ts` | `assetGrids: { [id]: { bpm, offsetSec } }` sudah ikut tersimpan |
| Sebagian UI | `web/src/studio/timeline/BeatSection.tsx` | ketik BPM, ×2/÷2, AUTO, nudge offset ±10 ms/±1 ms |

Jadi dari 11 kontrol rekordbox, yang **sudah ada** (hanya di `/studio`, hanya di
Clip Detail): #2, #4, #6, dan sebagian #11 lewat tombol AUTO. Yang belum ada di
mana pun: **#1, #3, #5, #7, #8, #9, #10**, dan **nol** di antaranya bisa diraih
dari `/dj`.

### Satu sifat model yang membuat rencana ini murah

`resolveBeatGrid` menormalkan `offsetSec` ke `[0, satu bar)` **saat dibaca**,
tapi `setAssetBeatGrid` menyimpan angka **mentah**. Akibatnya, kalau anchor
disimpan sebagai `180.0` (detik ke-180), grid tetap melewati detik ke-180 itu
**berapa pun BPM-nya nanti diubah** — karena `180 ≡ offset (mod bar)` menurut
definisi.

Artinya: **"pivot" yang dicari kontrol #5 dan #8 sudah terbangun di dalam model,
gratis.** Yang perlu dijaga hanya satu hal, dan ia halus:

> Fungsi yang mem-*pivot* harus membaca `asset.beatOffsetOverride` **mentah**,
> bukan `grid.offsetSec` yang sudah dinormalkan. Kalau salah, tiap perubahan BPM
> diam-diam mem-pivot di awal lagu, dan user akan melihat downbeat yang baru saja
> ia setel di menit ketiga melompat sendiri.

Ini jebakan pertama yang harus ditulis di kepala berkas `grid-edit.ts`.

---

## 3. Keputusan besar: SATU anchor dulu, marker belakangan

`[Dynamic]` (kontrol #7) menuntut `BeatGrid` berubah dari satu objek menjadi
**daftar segmen**. Yang ikut berubah: `beatLinesIn` harus berjalan lintas
segmen, `snapSourceToGrid` harus tahu ia sedang di segmen mana, `effectiveBpm`
dan SYNC harus bertanya "BPM di posisi mana", dan `fx-insert.ts` harus mengirim
`frames_per_beat` yang berubah di tengah lagu.

Untuk materi yang jadi sasaran halaman ini — lagu elektronik ber-tempo tetap —
imbalannya nyaris nol. **Fase A memakai satu anchor** dan mengerjakan 10 dari 11
kontrol. Fase B (§8) menyimpan pintunya tetap terbuka.

Dan ada penggantinya yang lebih baik untuk masalah yang sebenarnya:

### Kunci-dua-titik — lebih presisi daripada rekordbox, dan lebih murah

`00-plan.md` §Utang 3a menghitung anggarannya: pada 128 BPM, agar grid tetap di
dalam 25 ms sepanjang 6 menit, BPM harus benar dalam **±0.0089 BPM**.

Kontrol #5 rekordbox (renggangkan 1 ms) tidak bisa mencapainya: pada 128 BPM
satu ketukan 468.75 ms, jadi satu langkah 1 ms ≈ **0.273 BPM** — 30× lebih kasar
dari yang dibutuhkan. Menyetel grid enam menit dengan alat itu adalah pekerjaan
mendengarkan berulang, dan itulah kenapa orang mengeluh soal grid drift.

Gantinya, satu fungsi murni:

1. User menaruh downbeat di bar 1 dengan mata (anchor `t₁`).
2. User melompat ke drop terakhir, menaruh playhead di transien, tekan **`PAS DI SINI`**.
3. BPM diselesaikan supaya garis bar terdekat mendarat **persis** di `t₂`.

```
beats = round((t₂ − t₁) / secPerBeat_lama / beatsPerBar) × beatsPerBar
bpm   = beats × 60 / (t₂ − t₁)
```

Ketelitiannya: menaruh `t₂` dalam ±10 ms pada jarak 300 detik memberi galat BPM
`128 × 0.01 / 300 = 0.0043 BPM` — **di bawah anggaran ±0.0089**. Satu gestur,
sekali, dan grid berhenti merayap. Ini bukan penyimpangan dari rekordbox demi
gaya; ini menyelesaikan hal yang panelnya sendiri tidak bisa selesaikan.

---

## 4. Bentuknya di layar

### Di mana panelnya duduk

`DjLayout` adalah grid 100vh **lima baris yang tidak menggulir** — menambah
baris keenam berarti mencuri tinggi dari deck, dan `useViewportBand` sudah
kehabisan ruang di band `compact`.

**Baris 4 (Beat FX) berubah jadi slot.** Saat GRID EDIT menyala untuk sebuah
deck, baris itu menampilkan `GridEditBar`; selebihnya tetap `BeatFxBar`.

Bukan kompromi tata letak — itu pernyataan yang jujur: menyetel grid adalah
**pekerjaan persiapan**, bukan pertunjukan. Orang tidak menyetel downbeat sambil
memutar Beat FX, dan menyediakan keduanya sekaligus hanya menghabiskan tinggi
yang dibutuhkan pad.

### Apa yang berubah di waveform

Baris 2 (`WaveRow`) sudah menggambar grid lewat `drawBeatGrid`. Saat mode grid
menyala untuk deck tertentu, **tiga** hal berubah pada deck itu saja:

1. **Zoom bisa diatur.** `DECK_WINDOW_SEC` sekarang 8 detik mati. Menaruh
   downbeat di transien butuh 1–2 bar terlihat. Ikuti preset yang sudah ada di
   Studio (`ZOOM_BAR_PRESETS = 1, 2, 4, 8` bar) — jangan mengarang skala kedua.
2. **Arti menarik berubah: menggeser GRID, bukan mencari posisi.** Playhead
   diam; garis grid yang berjalan di bawah tangan.
3. **Anchor digambar berbeda dari garis bar biasa** — segitiga merah, mengikuti
   rekordbox (`01a` §5: *"red triangle = first beat of bar"*). Tanpa penanda ini
   user tidak punya cara tahu di mana pivot-nya, dan ×2/÷2 akan terasa acak.

Untuk #2 **jangan menulis pemetaan px→source kedua.** `ScrollingWave.onScrub`
sudah melaporkan posisi SOURCE yang berada di tengah jendela, dengan matematika
yang sama persis dengan yang dipakai menggambar. Deck DJ cukup menukar
*handler*-nya:

```ts
// mode normal: geser posisi
onScrub: (phase, sourceAt) => djActions.seek(deck.id, sourceAt)

// mode grid: geser ANCHOR sebanyak selisihnya, posisi tidak bergerak
onScrub: (phase, sourceAt) => {
  if (phase === 'start') dragBase.current = { center, anchorSec };
  const deltaSec = (sourceAt - dragBase.current.center) / sampleRate;
  gridActions.setAnchor(assetId, dragBase.current.anchorSec - deltaSec);
}
```

Tanda minusnya **wajib** dan wajib dikunci tes: `onScrub` melaporkan materi mana
yang harus berada di bawah playhead, jadi menarik ke kiri memberi `sourceAt`
yang lebih besar — sementara yang diinginkan user adalah gridnya ikut ke kiri.
Salah tanda menghasilkan kontrol yang bergerak terbalik, dan itu jenis cacat
yang membuat orang menyalahkan trackpad-nya.

### Isi `GridEditBar`

```
GRID ⟨A⟩   128.037 BPM  [−][+]   ×2 ÷2   TAP        ← spasi grid
ANCHOR  01:52.418  [◀1ms][1ms▶]  SET DI SINI  PAS DI SINI
ZOOM 1 2 4 8 bar   fine □   METRO ▁▃█ □   UNDO REDO   AUTO   🔒
```

Pemetaan ke §1: spasi=#2, [−][+]=#5, ×2÷2=#6, TAP=#3, [◀1ms][1ms▶]=#4,
SET DI SINI=#1, PAS DI SINI=pengganti #8 (§3), METRO=#10, UNDO/REDO=#9,
AUTO=`resetAssetBeatGrid`, 🔒=#11.

`fine` mengubah langkah 1 ms → 3 ms untuk [−][+] (persis rekordbox: `[fine]`
membesarkan langkah renggang/rapat) dan 1 ms → 0.1 ms untuk `[◀▶]`. Ya, arahnya
berlawanan antara dua kontrol itu — begitu juga di rekordbox, dan alasannya:
yang satu mengejar drift (butuh langkah besar), yang satu mengejar fase (butuh
langkah kecil).

---

## 5. Berkas dan urutan pengerjaan

Semua matematika masuk `studio/analysis/` — **bukan** `dj/` — karena grid milik
asset, dan Studio memakainya juga. Itu aturan yang sama yang sudah dipatuhi
`beat-grid.ts` dan `beat-draw.ts`.

```
BARU   web/src/studio/analysis/grid-edit.ts        matematika murni
BARU   web/src/studio/analysis/grid-edit.test.ts
BARU   web/src/studio/analysis/tap-tempo.ts        TAP, murni + berjustifikasi
BARU   web/src/studio/analysis/tap-tempo.test.ts
BARU   web/src/dj/grid/grid-history.ts             undo/redo per asset
BARU   web/src/dj/grid/GridEditBar.tsx             panel baris 4
BARU   web/src/dj/grid/grid-edit.test.tsx          tes UI + integrasi
UBAH   web/src/dj/store.ts                         state `gridEdit`
UBAH   web/src/dj/wave/DeckScrollingWave.tsx       zoom + semantik tarik
UBAH   web/src/dj/DjPage.tsx                       slot baris 4
UBAH   web/src/dj/commands.ts                      command `grid.*`
UBAH   web/src/studio/store.ts                     `analysisLock`
UBAH   web/src/studio/persist/persistence.ts       simpan `analysisLock`
UBAH   web/src/studio/timeline/beat-draw.ts        gambar anchor (segitiga)
```

### G1 — Matematika murni (tanpa satu piksel pun)

`grid-edit.ts`. Semua fungsi menerima **anchor mentah dalam detik** (dari
`asset.beatOffsetOverride ?? asset.tempo?.beatOffsetSec ?? 0`) dan mengembalikan
patch `{ bpm?, offsetSec? }` yang langsung bisa diberikan ke `setAssetBeatGrid`.

```ts
setDownbeatAt(atSec)                          → { offsetSec: atSec }
nudgeAnchor(anchorSec, deltaSec)              → { offsetSec }
setBpm(bpm, anchorSec)                        → { bpm, offsetSec }   // anchor dipertahankan
widenBeat(bpm, deltaSec, anchorSec)           → { bpm, offsetSec }   // #5, ±1/3 ms per KETUKAN
shiftOctave(bpm, delta, anchorSec)            → { bpm, offsetSec }   // ×2 / ÷2
fitBpmToPoint(anchorSec, bpm, atSec, bpb)     → { bpm, offsetSec } | null   // kunci-dua-titik
nearestBarSec(anchorSec, bpm, atSec, bpb)     → number               // untuk SET DI SINI + snap
```

Empat hal yang harus dijaga di sini dan tidak boleh diserahkan ke UI:

1. `clampGridBpm` dipanggil di **setiap** jalan keluar. `widenBeat` pada BPM
   tinggi bisa membalik tanda panjang ketukan kalau tidak dibatasi.
2. `fitBpmToPoint` mengembalikan `null` kalau `t₂ − t₁` lebih pendek dari
   **8 bar**. Di jarak yang lebih pendek, galat penempatan tangan lebih besar
   daripada perbaikannya, dan alat itu justru merusak grid yang tadinya benar.
3. `shiftOctave` **tidak** memakai `shiftAssetTempoOctave` yang sudah ada.
   Yang itu mengubah `tempoOctave` (koreksi atas hasil DETEKSI); di panel grid,
   ×2 adalah keputusan manual yang harus mendarat di `bpmOverride` supaya AUTO
   bisa mengembalikan **semuanya** sekaligus. Dua jalur untuk hal yang terlihat
   sama adalah cacat model; §7 menutupnya.
4. Semua fungsi bekerja dalam **detik**, bukan sample. `offsetSec` memang detik,
   dan mengonversi bolak-balik hanya menambah pembulatan pada besaran yang
   presisinya justru sedang diperjuangkan.

`tap-tempo.ts`: `tapTempo(timesMs: readonly number[])`. **Median** interval,
bukan rata-rata (satu ketukan meleset merusak rata-rata, median tahan); butuh
minimal 4 ketukan; deretan direset kalau jeda > 2 detik; hasil dikunci ke
oktaf terdekat dari BPM yang sedang berlaku kalau ada (orang menepuk 1/2 tempo
tanpa sadar sepanjang waktu).

**Bukti G1 selesai:** `pnpm vitest run studio/analysis` hijau, dengan tes:
anchor tetap diam saat BPM diubah; `fitBpmToPoint` memulihkan 128.0 dari grid
yang sengaja dirusak jadi 128.3 dalam galat < 0.005 BPM; nudge yang melewati
nol tetap menghasilkan grid yang sama; TAP menolak 3 ketukan.

### G2 — Panel + mode, tanpa audio

State di `djStore` (bukan state lokal komponen) karena command keyboard harus
bisa menyentuhnya:

```ts
readonly gridEdit: {
  readonly deck: DeckId | null;   // null = mode mati
  readonly zoomBars: 1 | 2 | 4 | 8;
  readonly fine: boolean;
  readonly taps: readonly number[];
};
```

`GridEditBar` menulis lewat `studioActions.setAssetBeatGrid` — **tidak** ada
salinan grid di `djStore`. Aturan `deck-view.ts` berlaku penuh: *kalau sebuah
nilai bisa berubah dari luar deck, turunkan, jangan simpan.* Grid yang disunting
di `/dj` harus langsung terlihat di `/studio` tanpa satu baris sinkronisasi.

Undo/redo (`grid-history.ts`) adalah tumpukan kecil per `assetId` berisi
snapshot `{ bpmOverride, beatOffsetOverride }`, dibatasi 32 entri, **bukan**
sistem undo global — repo ini belum punya satu pun, dan grid edit bukan tempat
yang tepat untuk memulainya. Satu entri per *gestur*, bukan per pointermove;
pola `useDragFraction`/`drag.ts` (docs/08 §8a) sudah menetapkan itu.

**Bukti G2 selesai:** menyalakan GRID di deck A → baris 4 berganti; menarik
waveform menggeser garis bar dan **tidak** menggeser playhead; UNDO
mengembalikannya persis; membuka `/studio` menampilkan grid yang sama.

### G3 — Keselamatan saat lagunya sedang berbunyi

Satu hal yang harus diperiksa sebelum panel ini dianggap selesai, karena
`/dj` berbeda dari `/studio` justru di sini: **menyunting grid saat lagu sedang
mengudara tidak boleh membuat suara melompat.**

Untungnya modelnya sudah benar dan hanya perlu dikunci tes: `loop.inAt`/`outAt`
disimpan sebagai **sample**, bukan sebagai indeks ketukan, jadi mengubah BPM
tidak memindahkan loop yang sedang berputar. Yang berubah hanya angka
`loop.beats` yang ditampilkan.

Yang **memang** berubah dan harus disebut di UI: SYNC dan quantize memakai grid
baru mulai aksi berikutnya. Kalau deck ini sedang jadi MASTER dan SYNC menyala
di deck lain, panel menulis satu baris peringatan — bukan menolak. Menolak akan
membuat alat ini mustahil dipakai justru pada saat orang paling membutuhkannya.

### G4 — Metronom (butuh audio)

Terakhir karena satu-satunya yang menyentuh graf Web Audio. Klik pendek
dijadwalkan dari grid lewat jam deck (`deck-clock.ts`), tiga tingkat volume
seperti rekordbox.

**Satu aturan yang tidak bisa ditawar: klik masuk ke bus CUE saja, tidak pernah
ke MASTER.** Metronom yang bocor ke keluaran utama adalah kesalahan yang
terdengar oleh seluruh ruangan. `dj-graph.ts` sudah punya percabangan cue/master
(`cue-output.ts`); klik disambungkan **hanya** ke cabang cue, dan itu ditulis
sebagai tes graf di `dj-graph.test.ts` — bukan sebagai catatan.

---

## 6. Analysis Lock, dan di mana kita menyimpang dari rekordbox

rekordbox: *"analisis ulang menimpa koreksi grid manual"*, dan `[Analysis Lock]`
ada untuk mencegahnya.

Di sini **koreksi manual sudah kebal**: `resolveBeatGrid` membaca
`bpmOverride ?? detected`, jadi analisis ulang menulis `asset.tempo` dan
override user tetap menang. Model kita lebih baik, dan `01-fitur-rekordbox.md`
sudah menyatakan sikapnya: *"kalau kita menyimpan koreksi user di tempat yang
bisa tertimpa diam-diam, itu bug — bukan kesetiaan."*

Jadi `analysisLock` di sini punya tugas yang lebih sempit dan tetap layak ada:

- memblokir tombol **AUTO** (`resetAssetBeatGrid`) — satu klik salah membuang
  kerja sepuluh menit, dan itu satu-satunya jalan hilangnya koreksi manual;
- memblokir `markAssetTempoPending` supaya lagu terkunci dilewati analisis batch;
- ikon gembok di kolom Collection (`CollectionBrowser.tsx`).

Satu field `readonly analysisLock: boolean` di `StudioAsset`, dan satu field
opsional di `PersistedGrid`. Opsional berarti **tidak perlu menaikkan
`SCHEMA_VERSION`** — pola yang sama sudah dipakai `persistence.ts` untuk field
mixer yang datang belakangan.

Catatan retensi: `collectAssetGrids` sekarang melewati asset yang kedua
override-nya `null`. Asset yang terkunci **tanpa** koreksi grid akan kehilangan
kuncinya saat refresh. Syaratnya karena itu jadi
`bpmOverride !== null || beatOffsetOverride !== null || analysisLock`.

---

## 7. Utang yang ikut dilunasi, dan satu yang sengaja tidak

**Lunas — `tempoOctave` vs `bpmOverride` yang tumpang tindih.** Sekarang ada dua
jalur berbeda menuju "BPM-nya separuh": `shiftAssetTempoOctave` dan mengetik
angka di `bpmOverride`. Keduanya tampak sama di layar, dan AUTO hanya
membersihkan salah satunya (`resetAssetBeatGrid` tidak menyentuh `tempoOctave`)
— jadi ada keadaan di mana user menekan AUTO dan BPM-nya tetap salah oktaf,
tanpa kontrol apa pun yang terlihat menjelaskan kenapa. Fase G1 #3 dan tombol
AUTO di panel menutupnya: ×2/÷2 di panel grid menulis ke `bpmOverride`, dan AUTO
membersihkan **ketiga** field.

**Sengaja tidak: presisi detektor (Utang 3a).** Grid Edit adalah katup pengaman
untuk masalah itu, bukan perbaikannya. Penguncian BPM ke pecahan sederhana di
`crates/analysis` tetap pekerjaan tersendiri. Yang berubah setelah dokumen ini:
kegagalan detektor tidak lagi buntu.

**Sengaja tidak: fase grid yang bergantung browser (Utang 3b).** `beatOffsetOverride`
memang tempat yang benar untuk menyerapnya, dan panel ini membuatnya bisa
disetel dengan tangan — tapi perbaikan sesungguhnya ada di jalur decode
(`import-worker.ts` yang belum pernah dipanggil), bukan di sini.

---

## 8. Fase B — `[Dynamic]`, kalau memang dibutuhkan

Jangan dikerjakan sampai ada lagu nyata di kepustakaan yang gagal digrid dengan
satu anchor. Bentuk yang tidak memaksa penulisan ulang, kalau saatnya tiba:

```ts
// StudioAsset
readonly beatAnchors?: readonly { readonly atSec: number; readonly bpm: number }[];
```

`resolveBeatGrid(asset)` tetap ada dan mengembalikan segmen **pertama**, jadi
semua pemanggil lama tetap benar untuk lagu ber-tempo tetap. Yang baru:
`resolveBeatGridAt(asset, atSec)` untuk pemanggil yang butuh grid lokal, dan
`beatLinesIn` berjalan lintas segmen.

Ongkos sebenarnya bukan di dua fungsi itu, melainkan di empat pemanggil yang
harus berhenti menganggap "BPM lagu" adalah satu angka: SYNC (`faderForBpm`),
`fx-insert.ts` (`frames_per_beat` yang harus dikirim ulang di tiap batas
segmen), beat jump, dan tampilan BPM di deck. Perkirakan pekerjaan segmen itu
**lebih besar** daripada seluruh Fase A.

---

## 9. Verifikasi manual (setelah G1–G4)

1. Muat lagu yang grid-nya meleset. GRID ⟨A⟩ → zoom 1 bar → tarik waveform:
   garis bar bergerak di bawah tangan, playhead tidak bergeser sedikit pun.
2. Taruh playhead di kick pertama → **SET DI SINI** → segitiga merah mendarat
   tepat di transien.
3. Lompat ke drop terakhir (menit ke-5), taruh playhead di kick → **PAS DI SINI**
   → BPM berubah beberapa perseribu, dan garis bar di **kedua** ujung lagu kini
   duduk di transiennya. Ini tes yang paling menentukan; kalau yang ini lulus,
   drift selesai.
4. **TAP** 8 kali mengikuti lagu → BPM mendarat dalam ±1 dari nilai sebelumnya,
   bukan setengah atau dua kalinya.
5. **UNDO** empat kali → kembali persis ke keadaan awal. **AUTO** → kembali ke
   hasil deteksi, termasuk oktafnya.
6. Nyalakan loop 8 bar, biarkan berputar, lalu ubah BPM. **Suara tidak melompat**;
   angka `loop.beats` di layar berubah.
7. Nyalakan METRO dengan headphone tersambung → klik terdengar di cue.
   **Cabut cue, dengarkan master: senyap.**
8. Refresh. Grid, kunci, dan zoom bertahan. Buka `/studio`, Clip Detail lagu
   yang sama: grid-nya identik.

---

## 10. Yang benar-benar dibangun (G1–G4 selesai)

Dokumen di atas adalah rencananya; bagian ini mencatat hasilnya, termasuk yang
menyimpang dari rencana dan alasannya. Semuanya lulus `tsc --noEmit`,
`vitest run` (991 tes, 90 berkas), dan `vite build`.

### Berkas

| Berkas | Isi |
|---|---|
| `studio/analysis/grid-edit.ts` | matematika murni: `rawAnchorSec`, `setDownbeatAt`, `nudgeAnchor`, `setBpm`, `widenBeat`, `shiftOctave`, `fitBpmToPoint`, `barsBetween`, `nearestBarSec`, `currentBpm` |
| `studio/analysis/tap-tempo.ts` | `tapTempo` (median + kunci oktaf), `trimTapRun` |
| `dj/grid/grid-ops.ts` | lapisan keputusan: satu pintu untuk panel, keyboard, dan tes |
| `dj/grid/grid-history.ts` | undo/redo per asset, 32 entri, langganan sendiri |
| `dj/grid/GridEditBar.tsx` | panel baris 4 |
| `dj/audio/metronome.ts` | penjadwal klik dengan jam audio |
| + 4 berkas tes | 29 + 14 + 17 + 10 tes |

### Semua 11 kontrol rekordbox, dan di mana

| # | Kontrol | Di sini |
|---|---|---|
| 1 | downbeat di posisi ini | `SET DI SINI` · `shift+G` — menempel ke garis bar terdekat dalam 30 ms |
| 2 | ketik BPM | kotak BPM, **tiga angka di belakang koma** |
| 3 | TAP | `TAP` · `shift+T` |
| 4 | geser grid ±1 ms | `◀ ▶` (0.1 ms saat `FINE`) |
| 5 | renggang/rapat ±1 ms | `− +` (3 ms saat `FINE`) |
| 6 | ×2 / ÷2 | `×2 ÷2` — menulis ke `bpmOverride`, bukan `tempoOctave` |
| 7 | cakupan seluruh-lagu vs dari-sini | **tidak** — `[Dynamic]` ditunda (§3, §8) |
| 8 | set ulang grid dari posisi ini | diganti **`PAS DI SINI`** · `shift+F` (§3) |
| 9 | undo / redo | `UNDO REDO`, per asset |
| 10 | metronom + 3 volume | `METRO ✕ ▁ ▃ █` |
| 11 | Analysis Lock | `🔒`, menjaga tiga aksi store |

Plus yang tidak ada di panel rekordbox: **menarik waveform menggeser grid**, dan
**zoom 1/2/4/8 bar** pada deck yang sedang disunting.

### Enam penyimpangan dari rencana

1. **Tombol GRID duduk di `DeckReadout`, bersebelahan dengan angka BPM** — bukan
   di header. Panelnya sendiri tidak bisa jadi tempat menyalakannya, dan BPM
   adalah angka yang salah saat seseorang merasa perlu membukanya. Ia memakai
   gaya tombol kecil `DeckReadout`, bukan `Button` 32 px, supaya baris itu tidak
   tumbuh di layar yang tidak menggulir.
2. **Klik metronom masuk ke `cueLevel`, bukan ke `cueSide`.** Lewat `cueSide` ia
   ikut hilang saat `[MIX]` digeser penuh ke MASTER — padahal ia bukan bagian
   dari lagu yang dimonitor, melainkan alat ukur di atasnya. Aturan "tidak pernah
   ke master" tetap dijamin TOPOLOGI: `cueLevel` hanya tersambung ke `cueOut`,
   dan `dj-graph.test.ts` mengunci ketiadaan jalan itu.
3. **`MIN_FIT_BARS = 8`.** Di bawah itu `PAS DI SINI` menolak dengan kalimat yang
   menyebut jaraknya sekarang. Delapan bar belum masuk anggaran ±0.0089 BPM —
   yang masuk adalah jarak beberapa menit — tapi setidaknya ia perbaikan, bukan
   kerusakan.
4. **`resetAssetBeatGrid` sekarang ikut membuang `tempoOctave`.** Ini utang §7
   yang dilunasi, dan ia mengubah perilaku tombol AUTO di Studio juga — memang
   itu maksudnya.
5. **Kunci analisis menjaga TIGA aksi store** (`setAssetBeatGrid`,
   `resetAssetBeatGrid`, `markAssetTempoPending`), bukan hanya AUTO. Penjagaan
   di store adalah CADANGAN; UI mematikan kontrolnya lebih dulu, karena setter
   yang diam-diam mengabaikan tulisan adalah kegagalan yang paling sulit dilacak.
6. **Hanya empat chord keyboard** — `G`, `shift+G`, `shift+F`, `shift+T`. Sisanya
   lewat command palette. Registry keymap tidak punya konsep MODE, jadi chord
   apa pun berlaku sama saja apakah panelnya terbuka atau tidak; mengikat lebih
   banyak berarti merampas tombol transport demi pekerjaan yang dilakukan sekali
   per lagu. `AUTO` sengaja tanpa chord, alasan yang sama dengan
   `dj.browse.remove`.

### Yang dijaga tes, dan tidak bisa dilihat dari kode

- **Tanda tarikan** — menarik ke kiri menggeser grid ke kiri, dan playhead tidak
  bergerak sepiksel pun (`dj/grid/grid-edit.test.tsx`).
- **Anggaran presisi** — `fitBpmToPoint` dengan galat tangan 10 ms pada jarak
  300 detik menghasilkan < 0.0089 BPM, sedangkan satu langkah renggang 1 ms
  menggerakkan BPM 0.27. Keduanya dikunci angka.
- **Loop yang berputar tidak melompat** saat BPM diubah — janji yang dibaca user
  sebagai kalimat peringatan di layar.
- **Satu entri undo per gestur**, bukan per `pointermove`.
- **Metronom tidak punya jalan apa pun** ke `destination`, `master`, maupun
  `masterFxIn`.
- **rAF 60×/detik tidak menghasilkan 60 klik per ketukan.**

### Yang masih terbuka

- `[Dynamic]` / multi-marker (§8) — belum, dan sengaja.
- Presisi detektor (Utang 3a) — Grid Edit adalah katup pengamannya, bukan
  perbaikannya. `PAS DI SINI` membuat kegagalan detektor tidak lagi buntu.
- Fase grid yang bergantung browser (Utang 3b) — `beatOffsetOverride` menyerapnya
  dengan tangan; perbaikan sesungguhnya ada di jalur decode.
