# Bagian 6 — Timeline, Clip Model & Non-Destructive Editing

Kode: [`crates/timeline-core/`](../crates/timeline-core/) ·
Schema: [`schema/project.schema.json`](../schema/project.schema.json)

---

## 6a. Clip data model

### Prinsipnya satu kalimat

**Clip tidak memiliki sample.** Ia memiliki *referensi* + *jendela* + *transform*.
Non-destructive editing bukan fitur yang ditambahkan di atas; ia adalah
konsekuensi otomatis dari struktur data ini. Tidak ada satu pun jalur kode di
repo ini yang bisa memutasi PCM asset — bukan karena disiplin, tapi karena
`&mut` ke asset pool tidak pernah diberikan ke modul editing.

```rust
// crates/timeline-core/src/model.rs (disingkat)
pub struct Clip {
    pub id: ClipId,                 // stabil seumur project
    pub track: TrackId,             // denormalisasi (lihat tabel di bawah)
    pub asset_id: AssetId,

    pub source_start: SourceSample, // offset trim-in DI SOURCE
    pub source_len: u64,            // panjang region DI SOURCE, selalu > 0
    pub timeline_pos: TimelineSample,

    pub gain_db: f32,               // kanonik dB, bukan linear
    pub fade_in: FadeSpec,          // panjang di TIMELINE space
    pub fade_out: FadeSpec,

    pub speed_ratio: f64,           // Bagian 8
    pub warp: bool,                 // varispeed vs time-stretch

    pub mute: bool,
    pub loop_count: u32,
    pub insert_chain: Vec<FxId>,    // kosong di MVP
    pub name: String,
    pub color: u8,
}
```

### Kenapa field-field yang tidak ada di sketsa awal

| Field | Alasan ia harus ada |
|---|---|
| `id` | Undo menyimpan referensi ke clip. Index array bergeser saat delete, jadi undo yang menyimpan index akan menyentuh clip yang salah. ID monoton, tidak pernah dipakai ulang — termasuk untuk clip yang sudah dihapus, supaya undo yang menghidupkannya kembali tidak bentrok dengan clip baru. |
| `track` | Denormalisasi yang sengaja. Hit-test dan `restore_clip` butuh tahu pemiliknya tanpa men-scan 32 track. Konsistensinya dijaga `edit::move_clip`. |
| `gain_db` bukan `gain` | dB adalah nilai kanonik: UI menampilkan dB, otomasi meng-interpolasi dB, file menyimpan dB. Linear adalah *turunan* ([`Clip::gain_linear`]). Menyimpan keduanya = dua sumber kebenaran yang bisa desinkron. Menyimpan hanya linear = `-inf dB` tidak representable dan round-trip dB→linear→dB kehilangan digit di UI. |
| `warp` | Toggle per-clip varispeed vs time-stretch (§8a). Harus ada di v1 supaya `speed_ratio` punya arti yang tidak ambigu. |
| `mute` | Comping take butuh mute per-clip. Bukan `gain_db = -inf`: kalau di-mute lewat gain, nilai gain lama hilang dan unmute mengembalikannya ke 0 dB, bukan ke nilai user. |
| `loop_count` | Clip loop = 1 clip, bukan N clip duplikat. Menghemat model dan membuat "ubah panjang loop" jadi satu edit. |
| `insert_chain` | Kosong di MVP (§6e), tapi field-nya ada sejak v1 — menambah field ke enum/struct yang sudah tersebar di file project user berarti migrasi, dan migrasi untuk field yang selalu kosong adalah kerja sia-sia. |

### `FadeSpec.len_timeline` diukur di timeline space — ini keputusan, bukan detail

User menggambar handle fade **di layar**, dan layar adalah timeline space. Kalau
fade disimpan di source space, mengubah `speed_ratio` dari 1.0 ke 2.0 akan
memotong durasi fade yang terlihat jadi setengah. Tidak ada seorang pun yang
mengharapkan "clip ini saya percepat" berarti "fade-in saya jadi lebih pendek".

Konsekuensinya di engine: fade dievaluasi terhadap posisi timeline voice, bukan
terhadap posisi baca source. Itu satu perkalian tambahan per blok, dan itu murah.

### Trim kiri/kanan

Kode: [`edit::trim_left`](../crates/timeline-core/src/edit.rs) / `trim_right`.

```
        source asset ─────────────────────────────────────────────
                       ↑ source_start        ↑ source_start+len

sebelum   timeline    ├──────── clip ────────┤
trim kiri              ══>
sesudah   timeline         ├───── clip ──────┤
```

- **Trim kiri** memutasi tiga field: `source_start`, `source_len`, `timeline_pos`.
- **Trim kanan** memutasi satu: `source_len`. `timeline_pos` tidak bergerak.
- Konversi posisi handle (timeline) ke `source_start` (source) **wajib** lewat
  `coords::timeline_to_source` — lihat §"Dua koordinat space" di bawah.

Edge case, dan apa yang dilakukan kode:

| Kasus | Kebijakan |
|---|---|
| Trim kiri melewati awal asset | `EditError::OutOfSource`. UI seharusnya sudah meng-clamp handle, tapi command harus aman dipanggil dari mana pun (undo, script, kolaborasi nanti). |
| Trim kanan melewati akhir asset | Di-clamp ke `asset.frames - source_start`. Memperpanjang ke kanan melewati akhir asset tidak menghasilkan audio, jadi menolaknya cuma bikin handle "macet" tanpa alasan yang terlihat. |
| Hasilnya 0 sample | `EditError::ZeroLength`. Clip nol-panjang adalah bug generator: ia lolos hit-test, tidak terlihat, dan tidak bisa dihapus user. |
| **Trim melewati fade** | Fade "menempel di kepala/ekor clip", jadi setelah trim ia tetap mulai di kepala yang baru; `Clip::clamp_fades()` mengecilkannya kalau tidak muat. Alternatifnya (fade tetap di posisi absolut lalu terpotong) berarti clip mulai di tengah kurva fade pada gain ≠ 0 — itu diskontinuitas, alias klik. |
| Kedua fade tabrakan setelah trim | Dikecilkan **proporsional** sampai totalnya = panjang clip. Menolak edit lebih menyebalkan daripada fade yang mengecil sendiri, dan hasilnya tetap terdengar benar. |

`apply` yang gagal **tidak mengubah project sama sekali** — semua validasi
dilakukan sebelum mutasi pertama. Ini di-tes (`failed_apply_leaves_project_untouched`).

### Split

```
sebelum:  [═════════ A ═════════]     A: src_start=100 len=800
split di tengah ↓
sesudah:  [═══ A ═══][═══ B ═══]      A: src_start=100 len=400
                                      B: src_start=500 len=400   (asset_id SAMA)
```

Tidak ada sample yang disalin. `p.asset_refcount(asset)` naik dari 1 ke 2, itu saja.

**Edge case yang biasanya salah: split di tengah fade.** Yang kami lakukan:

1. Fade-in asli menempel di kepala A. Kalau titik split jatuh **di dalam**
   fade-in, A jadi lebih pendek dari fade-in-nya → `clamp_fades` memotongnya.
2. B **tidak** mewarisi sisa fade-in. Ini disengaja: `FadeSpec` tidak punya
   "offset di dalam kurva", jadi melanjutkan fade di B mustahil direpresentasikan;
   meng-approx-nya (mis. memberi B fade-in yang lebih pendek) menghasilkan
   **lompatan gain di titik split** — persis klik yang mau dihindari.
3. Tepi baru di titik split **tidak diberi fade eksplisit sama sekali**. Engine
   menerapkan micro-fade 3 ms di setiap boundary (§6d), jadi sambungan A→B
   null-test bersih terhadap clip aslinya kecuali di 3 ms itu. Memberi fade
   eksplisit di sini justru terdengar sebagai lubang volume.
4. `loop_count` dibekukan jadi 1 di kedua sisi: "split di dalam pengulangan
   ke-3" tidak punya arti yang bisa dipertahankan.

Split tepat di tepi ditolak (`SplitOutOfRange`). Property test
`split_conserves_source` memverifikasi `left.source_len + right.source_len ==
original.source_len` untuk sembarang titik split dan sembarang `speed_ratio`.

### Dua koordinat space — pertahanan terhadap off-by-one

Ini bagian yang paling mudah diremehkan dan paling mahal kalau salah. Begitu
sebuah clip punya `speed_ratio != 1.0`, ada **dua** sumbu waktu yang sama-sama
diukur dalam "sample" dan sama-sama `u64`. Kalau keduanya bertipe `u64` polos,
`clip.source_start + drag_delta` compile dengan sempurna dan salah secara halus —
hanya terdengar saat ratio bukan 1.0, yang berarti bug-nya lolos semua tes
ratio-1.0.

```rust
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)] pub struct SourceSample(pub u64);
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)] pub struct TimelineSample(pub u64);
```

Yang **sengaja tidak disediakan**, dan alasannya:

| Tidak ada | Kenapa |
|---|---|
| `From<u64>` / `Into` | `let x: SourceSample = n.into()` menyembunyikan niat. Kamu harus mengetik `SourceSample::new(n)` supaya reviewer melihat space-nya. |
| `Deref<Target = u64>` | Akan membuat semua operator `u64` bekerja diam-diam lintas space. |
| `Add`/`Sub` antar-space | Tidak masuk akal secara dimensi. |
| `Sub` sesama space | Hasilnya *durasi*, bukan *posisi* — tipenya beda. Namanya `distance_from`, eksplisit. |

Konversi hanya lewat dua fungsi yang **wajib** menerima `ClipGeometry`, karena
konversinya memang mustahil tanpa tahu clip mana:

```rust
pub fn timeline_to_source(clip: &ClipGeometry, t: TimelineSample) -> SourceSample;
pub fn source_to_timeline(clip: &ClipGeometry, s: SourceSample) -> TimelineSample;
pub fn timeline_to_source_frac(clip: &ClipGeometry, t: TimelineSample) -> f64; // jalur render
```

Rumus kuncinya: `timeline_len = source_len / ratio`.

Jujur soal batasnya: konversi ini **tidak bijektif** dan tidak bisa dibuat
bijektif — itu sifat resampling. Batas error round-trip adalah satu source
sample dinyatakan dalam timeline unit, yaitu `ceil(1/ratio) + 1`. Konsekuensi
praktisnya satu aturan: **jangan pernah menyimpan hasil round-trip kembali ke
clip.** Kalau UI melakukan round-trip per gerakan mouse, clip akan "melayang"
beberapa sample per detik. `edit::trim_left` karena itu hanya menyimpan hasil
konversi satu arah.

### Asset pool: refcount, eviction, OPFS

PCM f32 **planar** disimpan di WASM linear memory (shared), read-only bagi audio
thread. Yang tersimpan di file project hanyalah `AssetRef` (nama, hash isi,
jumlah frame, sample rate asli) — bukan sample-nya.

**Refcount dihitung, tidak disimpan.**

```rust
pub fn asset_refcount(&self, asset: AssetId) -> usize   // scan clip
```

Counter tersimpan adalah sumber bug yang klasik: satu jalur undo/redo yang lupa
decrement = asset yang tidak pernah dibebaskan, dan bug itu tidak pernah
terlihat sampai user kehabisan memori setelah 40 menit. Menghitung ulang saat GC
berjalan (bukan per-edit) selalu benar, dan biayanya — men-scan beberapa ribu
clip — nol dibanding decode.

**Kapan evict.** Aturannya tiga lapis, dan lapis kedua yang paling sering
dilupakan orang:

1. `refcount == 0`, **dan**
2. asset tidak muncul di history undo/redo (`History::pinned_assets()`). Clip
   yang dihapus masih hidup di dalam `EditCmd::Insert` di stack undo; membebaskan
   asset-nya berarti undo menghasilkan clip yang menunjuk ke asset yang hilang.
   Ini alasan sebenarnya kenapa `History` punya `limit`: bukan memori command
   (kecil), tapi **asset pinning**.
3. budget memori terlampaui.

**Dan "evict" tidak berarti "hapus".** Berarti: tulis PCM ke OPFS, bebaskan
region di linear memory, tandai `AssetRef` sebagai `Evicted`. Kalau user undo
sampai clip itu hidup lagi, asset di-*page in* kembali dari OPFS — cepat (tanpa
decode, tanpa resample; ini raw f32) dan tanpa dialog "file hilang".

**OPFS sebagai backing store.** Angka yang menentukan:

| | Nilai |
|---|---|
| Lagu 5 menit stereo f32 @48k | 115 MB |
| WASM memory maksimum (`--max-memory` di `.cargo/config.toml`) | 2 GiB |
| Budget aman untuk asset pool | ~1.2 GiB (sisanya untuk graph, pyramid, scratch, fragmentasi) |
| Muat berapa lagu 5 menit | ~10 |

Sepuluh asset terdengar banyak sampai kamu ingat bahwa project multitrack punya
24 stem. Jadi OPFS bukan fitur "nanti" — ia jalur normal:

```
import → decode (worker) → resample → tulis OPFS assets/<hash>.pcm
                                    → page in ke WASM memory saat dipakai
                                    → page out (LRU) saat budget terlampaui
```

OPFS dipilih daripada IndexedDB karena: akses `FileSystemSyncAccessHandle` di
Worker bersifat **sinkron**, sehingga page-in bisa dilakukan dalam satu panggilan
tanpa rantai promise; tidak ada overhead structured-clone; dan tidak ada batas
ukuran per-value seperti di beberapa implementasi IDB. Yang harus diterima:
OPFS tidak terlihat user (tidak bisa "buka folder project"), jadi *Save As*
harus menulis file `.zip` berisi `project.json` + asset — dan itu memang yang
kita mau, karena portabilitas project tidak boleh bergantung pada storage browser.

Deduplikasi lewat `content_hash` (BLAKE3 dipotong 8 byte): drop file yang sama
dua kali menghasilkan satu asset. Ini bukan optimasi mikro — user memang sering
men-drag ulang file yang sama.

### Undo/redo: command + inverse vs immutable snapshot

Ini keputusan yang mengikat seluruh arsitektur editing, jadi dibandingkan jujur.

| | **Command + inverse (DIPILIH)** | Immutable snapshot (persistent DS) |
|---|---|---|
| Memori per langkah undo | O(ukuran edit); satu `Clip` ≈ 120 B | O(node yang di-*path-copy*): `Vec<Track>` + `Vec<Clip>` yang tersentuh |
| **Alokasi saat drag** | **Nol setelah command dibuat** | **Satu path-copy per gerakan mouse (60/detik)** |
| Kompatibel `no_std` + WASM | Ya, `Vec` saja | Butuh `im`/`rpds`: `Arc`, refcount atomik, tambahan ukuran binary |
| Mengirim edit ke worker/engine | Command **adalah** delta — langsung serializable | Harus men-diff dua snapshot |
| Kolaborasi / OT nanti | Command = operasi; fondasinya sudah benar | Harus dibangun ulang dari nol |
| Risiko korektnes | Inverse yang salah = korupsi senyap | Praktis nol |
| Kompleksitas awal | Menengah | Rendah |

**Yang menentukan adalah baris "alokasi saat drag".** DAW menghabiskan sebagian
besar hidupnya di dalam drag. Path-copy per frame di WASM berarti heap terus
tumbuh selama user menggeser clip — dan `SharedArrayBuffer` **tidak pernah
menyusut**, jadi puncak alokasi adalah alokasi permanen. Argumen kedua sama
kuat: command yang serializable adalah hal yang **sama** yang kita butuhkan
untuk mengirim edit ke engine dan ke export worker. Satu mekanisme, bukan dua.

Risiko "inverse yang salah" ditangani dua cara, dan cara pertama sedikit
kontroversial jadi dijelaskan terang-terangan:

1. Untuk op yang memutasi tepat satu clip, inverse-nya adalah
   `EditCmd::RestoreClip { state: Box<Clip> }` — **salinan penuh clip sebelum
   edit**, bukan operasi aritmatika terbalik. Ini terlihat seperti curang
   ("bukankah itu snapshot?"), tapi tidak: `Clip` itu **kecil dan tanpa buffer**,
   jadi salinannya O(1) terhadap panjang audio. Yang mahal (PCM) tidak pernah
   disalin. Yang kita hindari dengan snapshot penuh adalah *path-copy struktur
   project*, bukan penyalinan 120 byte. Dan `RestoreClip` yang inverse-nya
   `RestoreClip` adalah involusi yang jelas benar — jauh lebih sulit disalahkan
   daripada "kurangi `source_start` sebanyak delta, kecuali kalau fade
   ter-clamp, kecuali kalau...".
2. Op yang punya **efek samping ke tetangga** (`Push` menggeser clip lain,
   `Crossfade` mengubah fade clip lain) memakai `RestoreTrackClips` — snapshot
   satu track. Ini ditemukan lewat review, bukan lewat tebakan: `Duplicate`
   dengan policy `Crossfade` awalnya mengembalikan `Remove` saja, yang salah.
3. Property test: urutan edit acak sepanjang 1–12 operasi, lalu undo penuh, lalu
   `assert_eq!(project, before)`. Plus redo penuh kembali ke keadaan akhir.

Redo memakai command **asli**, bukan inverse-dari-inverse: menerapkan inverse dua
kali tidak dijamin identik ketika ada op yang lossy (`SetGain` di-clamp).

### Di mana project model hidup

**Single source of truth di Rust.** React memegang mirror read-only.

```
     ┌───────────────── MAIN THREAD ─────────────────┐
     │  React (presentational)                       │
     │      ▲ derived state (immutable, per-versi)   │
     │      │                                        │
     │  ProjectStore (TS) ── mirror read-only        │
     │      ▲ patch                │ EditCmd         │
     │      │                      ▼                 │
     │  WASM instance #1 (non-RT): Project + History │
     └──────────────────────┬────────────────────────┘
                            │ ProcessPlan (double-buffered) + Command ring
                            ▼
                   AudioWorklet: Engine
```

Alurnya: UI mengirim `EditCmd` → Rust menerapkannya dan mengembalikan *patch*
minimal (track mana, clip mana) → store TS memperbarui mirror-nya dan menaikkan
versi → React re-render bagian yang berubah.

**Alternatifnya dan ongkosnya.** Alternatif yang jujur adalah: state canonical di
TypeScript (Zustand/Redux), Rust hanya menerima perintah render. Itu terdengar
lebih "React-native" dan lebih mudah di-debug dengan Redux DevTools. Ongkos yang
harus dibayar:

1. **Logika edit ditulis dua kali.** Trim harus tahu tentang `speed_ratio`,
   clamp fade, batas asset. Kalau canonical-nya di TS, aturan itu ada di TS —
   tapi export worker dan engine tetap butuh aturan yang sama di Rust. Dua
   implementasi dari aturan yang sama akan **selalu** berbeda pada akhirnya, dan
   bedanya muncul sebagai "hasil export tidak sama dengan yang saya dengar".
2. **Dua koordinat space hilang.** TypeScript tidak punya newtype; `number`
   adalah `number`. Semua pertahanan §"Dua koordinat space" lenyap.
3. **Snapshot untuk export jadi konversi, bukan serialisasi.** Objek JS harus
   di-marshal ke bentuk yang dibaca `Engine::from_snapshot` — satu lagi tempat
   yang bisa desinkron.
4. Sebaliknya, ongkos pilihan kami: **state duplication**. Mirror TS bisa basi.
   Ditangani dengan (a) mirror hanya boleh diubah lewat patch dari Rust —
   tidak ada mutasi lokal "optimistic", dan (b) patch membawa nomor versi
   monoton; store yang melihat lompatan versi meminta full resync. Biaya patch
   untuk drag 60 fps: satu objek `{clipId, timeline_pos}`, bukan seluruh project.

Poin 1 adalah yang tidak bisa ditawar, dan itu sejalan dengan aturan emas #3 di
[ARCHITECTURE.md](../ARCHITECTURE.md): satu jalur render untuk realtime dan
offline hanya bermakna kalau modelnya juga satu.

---

## 6b. Drag & drop + import pipeline

### `decodeAudioData` vs Symphonia di Worker

| | `AudioContext.decodeAudioData` | **Symphonia (Rust, di Worker)** |
|---|---|---|
| Format | Apa pun yang browser dukung (MP3/AAC/OGG/WAV/FLAC) | WAV, FLAC, MP3, OGG/Vorbis, AAC(ADTS), CAF |
| Kecepatan | Native, biasanya 2–5× lebih cepat | Pure Rust; MP3 ~1.5–3× lebih lambat |
| Thread | **Hanya main thread** untuk `AudioContext`; `OfflineAudioContext.decodeAudioData` tersedia di Worker tapi dukungannya tidak seragam | Worker, penuh |
| Hasil mendarat di | JS heap (`AudioBuffer`) → **wajib disalin** ke WASM memory | **Langsung** ditulis ke WASM linear memory |
| Progress | Tidak ada. Satu promise, selesai atau tidak | Per-packet, granularitas sebebas kita |
| Determinisme | Berbeda antar browser (resampler internal Safari ≠ Chrome) | Identik di mana pun |
| Ukuran binary | 0 | ~250–400 KB di WASM (fitur dipilih) |
| Sample rate | **Otomatis di-resample ke rate `AudioContext`**, dengan algoritma yang tidak kita kontrol | Apa adanya; kita yang resample |

**Rekomendasi: Symphonia di Worker sebagai jalur utama, `decodeAudioData` sebagai
fallback untuk format yang tidak didukung Symphonia (utamanya AAC dalam MP4/M4A).**

Tiga alasan, berurut kekuatannya:

1. **Determinisme.** Baris "sample rate" di tabel adalah pembunuhnya:
   `decodeAudioData` diam-diam me-resample ke rate `AudioContext` dengan
   resampler yang berbeda per browser. Artinya file yang sama menghasilkan PCM
   yang berbeda di Chrome dan Safari, dan project yang sama tidak bisa
   null-test lintas browser. Untuk DAW yang menjanjikan "export = apa yang kamu
   dengar", ini fatal.
2. **Tidak ada copy.** `AudioBuffer` → `Float32Array` → `wasmMemory.set()`
   berarti satu salinan penuh 115 MB per lagu 5 menit, di main thread, dalam
   satu tick. Itu jank yang terlihat.
3. **Progress.** File 10 menit butuh progress bar. `decodeAudioData` tidak bisa
   memberikannya sama sekali.

Yang harus diterima: MP3 decode lebih lambat, dan ~350 KB tambahan di bundle
worker (bukan di bundle engine — worker di-lazy-load saat drop pertama, jadi
tidak menyentuh time-to-interactive).

### Decode wajib di Worker + progress

```
main: drop event → File → file.arrayBuffer() → transfer ke import-worker
                                                (transferable, zero-copy)
worker: Symphonia probe → format+durasi ────► postMessage {type:'meta'}
        loop packet:
            decode → tulis f32 planar ke SAB region asset
            tiap 500 ms wall-clock ─────────► postMessage {type:'progress', p}
        resample (kalau perlu) ─────────────► progress fase 2
        build_pyramid(pcm) per channel ─────► progress fase 3
        ───────────────────────────────────► postMessage {type:'done', assetRef}
```

Tiga hal yang membuat ini tidak menyakitkan:

- **Throttle progress ke wall-clock, bukan ke jumlah packet.** MP3 punya ~38
  packet per detik audio; file 10 menit = 23.000 postMessage kalau per-packet.
  Sama persis dengan alasan batching di [docs/03 §3a](03-export.md).
- **Progress punya tiga fase dengan bobot berbeda** (decode 60%, resample 25%,
  pyramid 15%). Progress bar yang melompat dari 100% ke "tunggu sebentar lagi"
  lebih buruk daripada progress bar yang lambat.
- **Alokasi region asset dilakukan setelah `meta` diketahui**, sekali. Kalau
  durasi tidak diketahui dari header (MP3 tanpa Xing header), pakai estimasi dari
  bitrate × ukuran file lalu `memory.grow` sekali di akhir kalau meleset — bukan
  tumbuh inkremental.

### Sample-rate mismatch: resample saat import

File 44.1k di project 48k. Dua pilihan, dan ini tidak seimbang:

| | **Import-time (DIPILIH)** | Realtime saat playback |
|---|---|---|
| Kualitas | Windowed-sinc 64-tap, bebas pilih | Terikat budget CPU per blok |
| Biaya CPU playback | **Nol** | Per clip, per blok, selamanya |
| Biaya sekali | ~2 detik untuk lagu 5 menit di worker | 0 |
| Memori | +9% (44.1k→48k) | 0 |
| Interaksi dengan `speed_ratio` | Bersih: cursor varispeed hanya menangani satu ratio | Dua ratio bertumpuk (SRC × speed), kualitas menurun berlipat |
| Determinisme export | Sama persis dengan playback | Sama, tapi hanya kalau resampler-nya sama |

**Rekomendasi: resample saat import, windowed-sinc (Blackman-Harris, 64 tap,
cutoff 0.92×Nyquist tujuan).** Alasan yang menentukan adalah baris terakhir dan
baris "interaksi dengan `speed_ratio`":

- Setelah import, **semua asset di project punya sample rate yang sama**. Itu
  menghapus satu dimensi state dari engine sepenuhnya: voice tidak perlu tahu
  soal sample rate asset, `speed_ratio` adalah satu-satunya ratio yang ada, dan
  fractional cursor (§8b) hanya perlu menangani satu sumber ketidakcocokan.
  Kode yang tidak ada tidak bisa punya bug.
- Kualitas: 64-tap windowed-sinc di worker itu gratis secara persepsi (SNR
  >120 dB). Resampler realtime dengan budget yang masuk akal untuk 32 track
  akan jauh di bawah itu.

Yang harus diterima: import 44.1k jadi sedikit lebih lambat, memori naik 8.8%,
dan **round-trip 44.1k → 48k → export 44.1k tidak bit-perfect**. Untuk kasus
terakhir, UI menawarkan "set project rate = 44100" saat asset pertama di-import
dengan rate berbeda dari default. Itu menyelesaikan 95% kasus nyata (satu
project biasanya satu rate) tanpa menambah kompleksitas engine sama sekali.

### Drag preview / ghost clip

Selama `dragover`, tidak ada satu pun `EditCmd` yang dikirim. Ghost clip adalah
**murni UI state**:

```ts
type Ghost = { assetId?: number; trackId: number; pos: TimelineSample; lenTl: number; valid: boolean };
```

- Posisi ghost = `snap(px_to_sample(e.clientX - laneLeft), grid, tempoMap, sr)`,
  dipanggil per `pointermove` (murah: satu binary search + aritmatika integer).
- `valid` dihitung dengan cek overlap yang sama dengan `edit::first_overlap`,
  supaya ghost merah = drop akan ditolak, dan tidak ada kejutan.
- Ghost digambar di **layer canvas terpisah** di atas timeline. Ini penting:
  layer clip di-cache (§6c), dan ghost yang berubah 60× per detik tidak boleh
  meng-invalidasi cache itu.
- Baru saat `drop`: satu `EditCmd::Duplicate`/`Insert` dikirim, satu entri undo.
  Bukan 200 entri dari 200 `pointermove`.

Untuk drop file dari OS, ghost muncul begitu `dragenter` (durasi belum diketahui
→ lebar placeholder tetap), lalu clip asli menggantikannya saat decode selesai
dengan spinner inline di badan clip.

---

## 6c. Waveform rendering

### Peak pyramid

Kode: [`crates/timeline-core/src/peaks.rs`](../crates/timeline-core/src/peaks.rs).

Angka yang menjelaskan kenapa ini wajib: lagu 5 menit stereo @48k = 28,8 juta
sample per channel. Menggambar 1200 px waveform dari raw sample = 24.000
pembacaan per pixel per clip, **setiap kali user scroll**. Di 32 track itu
ratusan juta pembacaan per frame — bukan lambat, mustahil.

Pyramid memindahkan biaya itu ke waktu import dan membuat biaya render
proporsional terhadap **lebar pixel**, bukan panjang audio.

**DIVERGENSI YANG DIAKUI: pita frekuensi hanya ada di TypeScript.**
`web/src/studio/timeline/envelope.ts` kini menyimpan `low`/`mid`/`high`
(|puncak| per bucket setelah crossover 200 Hz / 2 kHz) supaya waveform DJ bisa
berwarna seperti rekordbox; `peaks.rs` masih murni `MinMax`. Selama import
berjalan lewat `decodeAudioData` di halaman, ini tidak menimbulkan dua sumber
kebenaran — yang Rust belum pernah dipakai untuk menggambar. Begitu import
pindah ke `audio/import-worker` dan pyramid dibangun di Rust, `build_pyramid`
WAJIB ikut memancarkan ketiga pita, atau waveform akan kehilangan warnanya
persis pada hari pipeline-nya "diperbaiki".

**Min/max, bukan RMS atau abs-max.** Satu bucket digambar sebagai satu batang
vertikal; yang benar secara visual adalah rentang yang ditempuh sinyal, `[min,max]`.
`abs_max` menggambar waveform simetris palsu (sinyal asimetris seperti vokal dan
brass terlihat salah). RMS menggambar energi dan menyembunyikan transien —
padahal transien justru yang dicari user saat mengedit.

**Kenapa tiga level ×8 (64/512/4096):**

| Faktor | Jumlah level (28,8 M) | Overhead memori | Kualitas |
|---|---|---|---|
| ×2 dari 64 | ~19 level | ~100% dari level 0 | terbaik |
| **×8 dari 64** | **3 level** | **~14%** | tak terlihat |
| ×64 | 2 level | ~1,6% | lompatan detail terlihat saat zoom |

Dengan faktor 8, satu pixel menggabungkan 1–8 bucket. Menggabungkan min/max itu
**eksak** (`min(min(a),min(b)) == min(a∪b)`), jadi tidak ada degradasi kualitas
sama sekali — hanya sedikit lebih banyak bucket yang dibaca. Sifat asosiatif yang
sama juga berarti level 1 dan 2 bisa dibangun dari level 0, bukan dari PCM:
hasilnya **identik bit-per-bit** dengan satu pass melewati raw alih-alih tiga.
Ini di-property-test terhadap brute force.

Memori: level 0 = `2 × 4 B × (n/64)` = **⅛ byte per sample** ≈ 3,6 MB untuk lagu
5 menit stereo; level 1+2 menambah 14%. PCM-nya sendiri 230 MB.

```rust
pub fn build_pyramid(pcm: &[f32]) -> Pyramid;                                  // import worker
pub fn read_range(&self, from: SourceSample, to: SourceSample, out_px: usize) -> Vec<MinMax>;
pub fn read_range_into(&self, from: SourceSample, to: SourceSample, out: &mut [MinMax]);  // no alloc
pub fn read_clip_range(&self, clip: &ClipGeometry, from_tl, to_tl, out: &mut [MinMax]);
```

**Clip yang di-stretch tidak butuh pyramid baru.** `read_clip_range` hanya
mengubah rentang yang dibaca lewat `timeline_to_source` — efeknya *striding
dengan faktor ratio*. Clip dengan `ratio = 2.0` membaca rentang source dua kali
lebih panjang untuk lebar pixel yang sama, dan pemilihan level otomatis naik.
Biaya mengubah `speed_ratio`: **nol**. Tidak ada regenerasi, tidak ada invalidasi,
tidak ada worker yang dibangunkan. Di-tes: hasilnya identik dengan pembacaan
langsung rentang source penuh.

Batas yang diakui: di bawah 64 samples-per-pixel (zoom sangat dalam), pyramid
level 0 jadi bertangga. Di zoom sedalam itu rentang yang terlihat < 100k sample,
jadi UI **beralih ke jalur "gambar raw sample"** yang terpisah — di situ membaca
raw memang murah. Pyramid bukan alat yang tepat untuk zoom itu dan kita tidak
memaksakannya.

### Canvas2D dengan cache vs WebGL

Target: 32 track × puluhan clip, 60 fps saat scroll/zoom.

| | **Canvas2D + cache per-clip (DIPILIH untuk MVP)** | WebGL instanced |
|---|---|---|
| Draw call | 1 `drawImage` per clip visible (~40–80) | 1 draw call untuk semua clip |
| Biaya redraw penuh | ~2–4 ms untuk 80 clip @1200px | ~0,3 ms |
| Biaya scroll (tanpa perubahan zoom) | **0 — hanya blit offset** | ~0,3 ms |
| Biaya zoom (semua cache invalid) | 2–4 ms, sekali per gerakan zoom | ~0,3 ms |
| Teks (nama clip), rounded corner, seleksi | Gratis, sudah ada API-nya | Harus ditulis sendiri (atlas font, SDF) |
| Integrasi dengan design system | Warna/token langsung dari CSS | Harus di-mirror ke uniform |
| Kehilangan context | Jarang, dan pulih otomatis | `webglcontextlost` harus ditangani, cache GPU hilang |
| Baris kode | ~300 | ~1200 |

**Rekomendasi: Canvas2D dengan cache per-clip untuk MVP.** Baris "biaya scroll"
adalah yang menentukan: dengan cache per-clip, scroll — interaksi yang paling
sering — tidak menggambar waveform sama sekali, hanya memindahkan bitmap. Zoom
memang butuh redraw penuh, tapi zoom adalah gerakan yang jarang dan 3 ms masih
di dalam anggaran 16,7 ms. WebGL memenangkan angka mentah dengan margin besar,
tapi memenangkannya di tempat yang tidak menjadi bottleneck, dengan biaya 4×
baris kode dan kehilangan semua kemudahan teks/styling.

Kapan kita pindah ke WebGL: kalau spektrogram per-clip masuk (butuh ribuan quad
bertekstur), atau kalau jumlah track naik jauh di atas 32. Batas pindahnya
konkret: **kalau redraw penuh melewati 8 ms di mesin target**. Sampai itu
terjadi, Canvas2D adalah pilihan yang benar dan bukan kompromi.

Detail implementasi cache:

- Satu `OffscreenCanvas` per clip visible, dikunci pada `(clipId, source_start,
  source_len, speed_ratio, px_per_sample, height_px, colorToken)`. Perubahan
  `timeline_pos` **tidak** meng-invalidasi cache — clip yang digeser digambar
  ulang di offset lain, itu saja. Ini yang membuat drag jadi gratis.
- Cache di-render pada `devicePixelRatio`, dengan lebar dibatasi 4096 px; clip
  yang lebih lebar dari itu di-tile.
- LRU dengan budget total (mis. 64 MB) — bukan "cache semua yang pernah terlihat".

### Virtualisasi

Dua lapis, keduanya sepele dan keduanya wajib:

1. **Track**: hanya lane yang bersinggungan dengan scroll vertikal yang di-mount
   di React. 32 track × 88 px = 2816 px; layar 900 px → ~11 lane hidup.
2. **Clip**: `Track::clips_in_range(viewport.start, viewport.end())`. Karena
   `clips` dijaga tersortir berdasarkan `timeline_pos`, ini bisa jadi binary
   search + iterasi maju sampai lewat. Untuk jumlah clip realistis (<10.000) scan
   linear pun sudah di bawah 0,1 ms, jadi versi sekarang scan linear dan itu
   bukan hutang teknis yang mendesak.

`Viewport::intersects` sengaja memakai batas setengah terbuka `[start, end)` yang
sama dengan `Clip::contains`, supaya clip yang tepat menyentuh tepi tidak
berkedip masuk-keluar.

3. **Di DALAM satu clip.** Dua lapis di atas tidak cukup, dan ini baru
   ketahuan dari lagu 27 menit. Satu clip bisa jauh lebih lebar dari layar:
   track selebar `durationSec × pxPerSecond`, dengan zoom dibatasi 400 px/detik,
   berarti 1620 detik → **648.000 px**. Canvas waveform clip dulu mengambil
   seluruh lebar itu (`width: 100%`), dan `fitCanvas` masih mengalikannya dengan
   dpr → 1.296.000 px, sementara batas dimensi canvas Chrome/Firefox ~65.535 px.
   Untuk file 27 menit, batas itu sudah terlewat pada zoom **~20 px/detik** —
   dan di atas titik itu waveform tidak melambat, ia hilang.

   Sekarang canvas dipasang hanya selebar irisan yang terlihat
   (`web/src/studio/timeline/wave-window.ts`), pada `left: win.x`. `width` yang
   dikirim ke penggambar TETAP lebar penuh clip, sehingga pemetaan
   sample→pixel tidak berubah saat user menggulir — kalau ikut menyempit,
   waveform akan meregang. Tepi jendela dibulatkan ke kelipatan 256 px supaya
   guliran kecil tidak mengubah ukuran canvas (mengubah `canvas.width` membuang
   isinya, jadi hasilnya berkedip). Canvas terlebar yang mungkin terbentuk jadi
   ≈ lebar viewport + 512 px, berapa pun durasi project.

   Satu efek samping yang perlu disebut: menghitung rentang jendela lewat
   perkalian yang berbeda urutan bisa membuat batas pixel tiba satu ulp di bawah
   batas bucket, dan `floor` lalu memundurkannya satu bucket penuh — 64 sample
   milik kolom sebelumnya ikut terhitung, terukur sampai 2 px beda tinggi.
   `readEnvelope` karena itu memakai toleransi `EPS` saat memetakan pixel ke
   index bucket. Versi Rust (`peaks.rs::read_range_into`) tidak punya masalah
   ini karena aritmetikanya integer.

---

## 6d. Editing interactions

### Hit-testing di JS, bukan Rust

Hit-test = "pointer di x,y itu mengenai apa: badan clip, handle trim kiri/kanan,
atau handle fade?". Ini **murah**: setelah virtualisasi, kandidatnya adalah clip
di satu lane yang terlihat — belasan, bukan ribuan. Satu perbandingan rentang
per kandidat.

Melakukannya di Rust berarti satu panggilan lintas boundary WASM per
`pointermove` (60/detik), plus mengekspos geometri viewport ke Rust, plus
menduplikasi konstanta ukuran handle yang **berasal dari CSS design token**.
Semua itu untuk menghemat pekerjaan yang tidak terukur. Jadi: **JS**.

Batasnya jelas dan disebut di sini supaya tidak diperdebatkan lagi nanti: JS
melakukan hit-test dan menghasilkan *niat*; Rust melakukan *validasi dan mutasi*.
JS tidak pernah menghitung `source_start` sendiri.

```
zona (dalam CSS px, dari design token):
├─8px─┬────────── body ──────────┬─8px─┤
 trim-L                            trim-R
└ fade handle: 12×12 di pojok atas kiri/kanan (prioritas di atas trim)
```

### Pointer capture & modifier

- `setPointerCapture` di `pointerdown` pada elemen lane. Tanpa ini, drag cepat
  keluar dari elemen dan `pointermove` berhenti di tengah gerakan — bug yang
  terlihat sebagai "clip nyangkut".
- Satu `pointerId` aktif; `pointercancel` (gesture browser, jendela kehilangan
  fokus) memicu **rollback lokal**: ghost dibuang, tidak ada `EditCmd` dikirim.
- Modifier:

| Modifier | Efek |
|---|---|
| Alt/Option | Override snap: `Grid::Off` selama tombol ditahan |
| Shift | Kunci sumbu (hanya horizontal atau hanya ganti track) |
| Ctrl/Cmd + drag | Duplicate alih-alih move |
| Ctrl/Cmd + drag pada trim handle | Time-stretch alih-alih trim (§8) |

Snap dievaluasi **saat render ghost**, dari state modifier terkini — bukan
disimpan saat `pointerdown`. Menekan Alt di tengah drag harus langsung terasa.

### Overlap policy

```rust
pub enum OverlapPolicy { Crossfade, Push, Reject }
```

| Policy | Perilaku | Kapan default |
|---|---|---|
| **Crossfade** | Bagian yang tumpang tindih jadi crossfade equal-power: clip kiri dapat fade-out, kanan dapat fade-in, sepanjang overlap | **Default MVP.** Tidak pernah menghilangkan audio dan tidak pernah menolak gerakan user |
| Push | Clip yang tertabrak digeser ke kanan sebanyak overlap, berantai | Menyusun ulang urutan take |
| Reject | `EditError::Overlap`; project tidak berubah | Mode "protective", dan wajib untuk operasi terprogram (import batch) |

Crossfade otomatis memakai **EqualPower**, bukan Linear: dua clip yang
bertabrakan di timeline hampir selalu material yang *tidak berkorelasi* (dua take
atau dua file berbeda), dan di situ kurva linear menghasilkan lubang volume
−3 dB di tengah crossfade.

### Click-free editing: micro-fade di ENGINE, bukan UI

Setiap boundary clip tanpa fade adalah diskontinuitas amplitudo. Diskontinuitas =
energi broadband = **klik**. Ini terjadi di lima tempat, bukan satu:

1. awal clip, 2. akhir clip, 3. titik split, 4. loop jump transport (docs/02 §2c),
5. seek/scrub.

Kebijakan: **micro-fade 3 ms otomatis di setiap tepi**, `MICRO_FADE_MS` di
`timeline-core`, diterapkan oleh engine.

Kenapa engine dan bukan UI (yaitu: kenapa tidak sekadar menyetel `fade_in = 144`
saat clip dibuat):

| Alasan | Penjelasan |
|---|---|
| Kasus 4 dan 5 tidak punya "clip edge" | Loop jump dan seek adalah peristiwa transport. UI tidak bisa memasang fade untuk sesuatu yang tidak ada di model. |
| Fade user tidak boleh tercemar | Kalau micro-fade adalah `FadeSpec`, user melihat handle fade 3 ms yang tidak ia buat, bisa menghapusnya, dan bisa membuatnya 0 — lalu klik-nya kembali. |
| Panjangnya bergantung sample rate | 3 ms = 132 sample @44,1k, 144 @48k, 288 @96k. Model project tidak boleh bergantung sample rate device. |
| Undo | Micro-fade bukan keputusan editorial; ia tidak boleh muncul di history. |
| Determinisme export | Engine yang sama menerapkannya di realtime dan offline — otomatis, tanpa jalur kedua. |

Implementasi di engine: voice punya envelope 3 ms yang **selalu** aktif di awal
dan di 3 ms terakhir sebelum voice mati, dikalikan dengan fade user (kalau ada).
Kurvanya equal-power. Kalau clip lebih pendek dari 6 ms, micro-fade menyusut jadi
setengah panjang clip. Biaya: satu perkalian per sample selama 3 ms per boundary —
tidak terukur.

Konsekuensi jujur: sambungan hasil split **tidak** null-test sempurna terhadap
clip aslinya — ada penurunan −0,0 dB → 0 dB → 0 dB selama 3 ms di titik sambung
karena dua micro-fade equal-power yang berdampingan menjumlah ke unity. Dengan
kurva equal-power (`cos²+sin²=1`) selisihnya di bawah −80 dB. Itu harga yang
benar untuk tidak pernah terdengar klik.

---

## 6e. Effect routing: per-clip vs per-track

> **Status: sudah mendarat.** Bagian ini dulu merekomendasikan "per-track saja"
> untuk MVP dan menyebut per-clip sebagai jalur fase 2. Jalur itu sekarang ada,
> dalam bentuk yang lebih sempit dari yang dibayangkan — dan penyempitannya
> justru yang membuatnya benar. Analisis aslinya dipertahankan di bawah karena
> alasannya masih berlaku dan menjelaskan bentuk yang dipilih.

### Kenapa per-clip sulit (analisis asli, masih berlaku)

| | Per-track insert chain | Per-clip insert |
|---|---|---|
| Jumlah instance FX | ≤ 32 chain, tetap | Sebanyak clip yang **aktif**, berubah-ubah |
| Alokasi | Sekali, saat track dibuat | Saat playhead masuk clip → **alokasi di jalur RT** (dilarang, docs/01 §1c) |
| Tail (reverb/delay) | Tidak ada masalah — chain selalu hidup | Tail terpotong saat playhead keluar clip |
| CPU | Deterministik | Bergantung kepadatan clip |

Anggaran CPU (docs/02 §2d): satu REVERB ~1.6 poin persen. Bagian chorus dengan
32 track × 4 clip aktif berarti sampai 128 chain hidup bersamaan — jauh di luar
anggaran, bahkan dengan pool.

### Bentuk yang dipilih, dan yang ditolak

Rancangan fase 2 yang dibayangkan bagian ini adalah **kolam rak yang
diperebutkan voice**: clip yang berbunyi meminjam rak, melepasnya setelah
ekornya habis, dan mencuri dari yang paling pelan kalau habis.

Rancangan itu ditolak, dan alasannya bukan kerumitan melainkan aturan yang
tidak bisa ditawar: rak harus dibangun **ulang** saat dipinjam, karena clip
berikutnya bisa memakai jenis efek yang berbeda. Membangun node berarti
mengalokasi, di `render_block`. Menyiasatinya menuntut tiap slot pool
menyediakan SEMUA jenis efek sekaligus — biayanya jauh lebih besar daripada
yang dihemat.

Yang dipakai adalah bentuk paling sederhana yang benar: **rak dialokasikan per
CLIP saat project dimuat, sekali, dan tidak pernah dilepas.**

- Batasnya keras: `MAX_CLIP_CHAINS = 8` clip ber-efek per project.
- Yang kelebihan **tetap berbunyi**, tanpa efek, dan `map_project` mengatakannya
  lewat peringatan. Kehilangan efek jauh lebih baik daripada kehilangan audio,
  dan kehilangan diam-diam paling buruk.

Yang didapat sebagai gantinya bukan sedikit:

- **Nol alokasi** di jalur render. Diuji langsung oleh
  `render_block_with_clip_chains_does_not_allocate` di bawah `rt-guard`,
  termasuk jalur ekor keep-alive.
- **Nol pencurian slot dan nol kondisi balapan.**
- **Ekor tidak pernah terpotong** saat playhead keluar clip — yang justru
  keberatan utama tabel di atas. Rak-nya memang tidak pernah dilepas.

### Keep-alive: kenapa BUKAN berbasis energi

Bentuk yang kelihatan benar adalah menahan chain sampai keluarannya turun di
bawah −80 dBFS. Itu **salah**, dan salahnya tidak kelihatan sampai lama.

`peak` dihitung atas slice yang diberikan pemanggil. Pada render 128-frame ia
dievaluasi delapan kali lebih sering daripada 1024-frame, jadi ambangnya
dilewati di **sample yang berbeda**. Chain dibebaskan pada waktu berbeda,
urutan iterasi `render_track` berubah, dan `null_test_block_size_invariance`
gagal — secara **intermiten**, hanya pada project yang punya ekor.

Karena itu `Effect::tail_frames()` wajib **fungsi murni dari parameter dan
sample rate**. ECHO menghitung `ln(1e−4)/ln(fb)`, REVERB dari RT60, FILTER
konstanta 50 ms. Tes konformans menegakkannya:
`tail_frames_does_not_depend_on_what_was_processed`.

### Transport

| kejadian | chain per-clip |
|---|---|
| `stop()` | ekor terus berbunyi |
| `seek()` | **reset keras** — ekor yang selamat dari seek membuat render dari seek berbeda dari bounce yang mulai bersih di posisi sama |
| `load_project` | reset keras |
| track mute / solo-out | ekor jalan terus, `PanAdd` tidak diemit, jadi tidak ikut dijumlah — tanpa kasus khusus |

### Urutan sinyal

```
source PCM → clip gain → clip fade (termasuk micro-fade 3 ms paksa)
           → insert chain CLIP → buffer track
           → EQ track → kompresor track → insert chain TRACK
           → fader → pan → send → bus → chain MASTER → output
```

Chain clip berada **sesudah** fade, jadi ia tidak pernah melihat diskontinuitas
tepi clip — FILTER resonan yang disuapi tepi mentah akan berdenging.

### `Clip::insert_chain`

Bagian ini dulu menyebut `Clip::insert_chain` sudah ada di model v1 "supaya
tidak butuh migrasi nanti". Yang tidak disebut: tipenya `Vec<FxId>`, dan `Fx`
yang ditunjuk id itu **tidak pernah didefinisikan di mana pun**. Sekarang ada
(`FxDef`), dan isinya inline, bukan id ke pool — lihat alasannya di
`crates/timeline-core/src/model.rs`.
