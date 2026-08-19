# Halaman `/dj` — Performance Mixer 2 Deck ala rekordbox

## Context

DawOnWeb punya dua halaman: `/` (landing, `web/src/landing/`) dan `/studio`
(DAW timeline multi-lane, `web/src/App.tsx`). Yang diminta adalah halaman
**ketiga** dengan tujuan berbeda: bukan menyusun secara non-destruktif, tapi
**nge-mix dua track secara live** — dua deck, crossfader, EQ per channel, hot
cue, loop, FX — mengikuti referensi visual layar **PERFORMANCE mode rekordbox**.

Kenapa halaman terpisah dan bukan panel di `/studio`: modelnya beda secara
fundamental. Studio memodelkan **clip di atas timeline** (`StudioClip.start`,
`sourceStart`, `sourceLen`, lane). Deck DJ memodelkan **satu track utuh dengan
satu playhead sendiri** yang jalan independen dari deck lain — tidak ada
timeline bersama, tidak ada transport global. Memaksa keduanya ke satu store
akan merusak kedua-duanya.

Keputusan yang sudah diambil user:

| Keputusan | Pilihan |
|---|---|
| Iterasi pertama | **UI dulu, audio menyusul** |
| Tema | **CyberUI amber** (`--cy-*`), bukan biru rekordbox |
| Sumber track | **Reuse library Studio** (`StudioAsset`, jalur import, IndexedDB, tempo-worker) |
| Route | **`/dj`** |
| Dokumen plan | folder **`recordbox/`** di root repo |

Riset fitur rekordbox dan teknik implementasinya dijalankan paralel oleh agent
terpisah; hasilnya ada di §Matriks fitur dan §Empat utang. Baseline repo sudah
diukur: `npx tsc --noEmit` bersih, `npx vitest run` **67 berkas / 690 tes lulus**.

---

## Yang sudah ada dan WAJIB dipakai ulang

Repo ini ternyata sudah menyimpan hampir semua bahan mentah sebuah deck DJ.
Menulis ulang salah satu dari ini adalah kesalahan, bukan pilihan.

| Kebutuhan deck | Sudah ada di | Catatan |
|---|---|---|
| Waveform scrolling playhead-di-tengah | `web/src/studio/timeline/ScrollingWave.tsx` | Header-nya sendiri menyebut "Rekordbox, Serato". Butuh satu prop baru (lihat §Perubahan) |
| Waveform overview seluruh track | `web/src/studio/timeline/waveform.ts` → `drawAssetWave` | `OverviewStrip.tsx` terikat store Studio; gambar sendiri pakai `drawAssetWave` |
| Peak pyramid multi-resolusi | `web/src/studio/timeline/envelope.ts` (`buildEnvelope`, `readEnvelope`) | bucket 64/512/4096, min/max/rms |
| Beat grid | `web/src/studio/analysis/beat-grid.ts` | `BeatGrid`, `resolveBeatGrid(asset)`, `beatLinesIn`, `snapSourceToBeat`, `secPerBeat` |
| Gambar grid + playhead di canvas | `web/src/studio/timeline/beat-draw.ts` | `drawBeatGrid`, `drawPlayhead` |
| Deteksi BPM | `crates/analysis` → `web/src/audio/tempo-worker.ts` → `web/src/studio/analysis/tempo-client.ts` | `requestAssetTempo(assetId, buffer)` |
| Koreksi oktaf ×2/÷2 + override BPM manual | `studioActions.shiftAssetTempoOctave`, `setAssetBeatGrid` | persis kebutuhan tombol ×2/÷2 rekordbox |
| Import file → asset + IndexedDB | `web/src/studio/timeline/audio-import.ts` | `assetFromBuffer`, `importBytesToLane`; `sniff.ts` untuk format |
| AudioContext + cache `AudioBuffer` | `web/src/studio/preview/audio-preview.ts` | `ensureContext`, `registerBuffer`, `getBuffer`, `bufferLookup` |
| FX unit (FILTER/ECHO/SPIRAL/FLANGER/REVERB/PITCH) | `web/src/studio/preview/fx-node.ts` + `crates/engine/src/fx/registry.rs` | `ensureFxRuntime`, `createFxNode`, `pushFxParams` — nol kode per-efek |
| Katalog FX data-driven + taper knob | `web/src/audio/fx-catalog.ts` | `fromNorm`/`toNorm`/`formatParam` |
| Knob rotary (−135°…+135°, shift=fine, dblclick=reset) | `web/src/ui/panels/PluginKnobs.tsx` | pola-nya disalin, bukan komponennya (file itu terikat store lama `src/state/`) |
| Drag pointer-capture | `web/src/ui/lib/drag.ts` (`useDrag`), `web/src/studio/rail/useDragFraction.ts` | |
| Taper fader → dB | `web/src/studio/rail/fader.ts` (`faderToDb`, `dbToFader`, `formatDb`) | unity di 75% travel |
| Canvas dpr-aware | `web/src/ui/lib/canvas.ts` (`fitCanvas`, `useCanvasDraw`) | |
| Primitives + token | `web/src/ui/cyber/` (`Card`, `Button`, `Badge`) + `theme.css` | |
| Pola store tanpa library | `web/src/ui/shell/shell-store.ts`, `web/src/studio/store.ts` | `useSyncExternalStore` + selector stabil |

---

## Bentuk halaman

Route ketiga di `web/src/Root.tsx`. `routeOf` sekarang perbandingan kesetaraan
tunggal; diubah jadi tabel path → route supaya route keempat nanti tidak perlu
menyentuh logikanya lagi.

Folder baru `web/src/dj/`, sejajar `landing/` dan `studio/`:

```
web/src/dj/
  model.ts                    tipe + matematika murni. TANPA React, store, Web Audio
  store.ts                    useSyncExternalStore + djActions
  deck-view.ts                DeckState × StudioAsset → DeckView (semua turunan)
  index.ts                    barrel
  DjPage.tsx                  pasang tick, muat kepustakaan, daftarkan asset-root
  layout/DjLayout.tsx         grid 100vh 5 baris
  layout/useViewportBand.ts   'compact'|'normal'|'tall' dari innerHeight
  header/DjHeader.tsx         judul, badge UI ONLY, BPM master, tutup
  wave/WaveRow.tsx            baris 2: dua waveform bertumpuk
  wave/DeckScrollingWave.tsx  ADAPTOR — satu-satunya berkas di dj/ yang tahu
                              kosakata "clip"
  wave/DeckOverview.tsx       lagu penuh + penanda cue/loop  ← drawAssetWave
  wave/markers.ts             penggambar penanda (murni)
  deck/Deck.tsx               SATU komponen, dirender DUA kali (props id + side)
  deck/{DeckReadout,DeckTransport,DeckTempo,DeckPads,DeckLoop,Jog}.tsx
  mixer/MixerSection.tsx      dua ChannelStrip + master + crossfader
  mixer/{ChannelStrip,Knob,ChannelFader,Crossfader,CueSection,LevelMeter}.tsx
  fx/BeatFxBar.tsx            pilih efek/target/beat-div/level/ON dari katalog Rust
  browser/CollectionBrowser.tsx  daftar asset dari studioStore + drop zone
  browser/{CollectionRow.tsx,collection.ts,dj-import.ts}
  persist/dj-session.ts       simpan/pulihkan sesi + daftarkan asset-root
```

Beberapa nilai model yang **sengaja berbeda dari Studio**, karena alat yang
ditiru memang berbeda:

| Nilai | Bentuk | Kenapa bukan seperti Studio |
|---|---|---|
| Tempo fader | travel `-1..+1` + `rangePct` terpisah | Mengganti RANGE ±6→±16 **tidak** menggerakkan fader fisik; yang berubah adalah arti posisi yang sama. Kalau yang disimpan persen, ganti range harus menggeser fader — gerakan hantu yang tidak dilakukan alat mana pun |
| Channel fader | travel `0..1`, gain `t²` | Unity di **puncak** dan nol **mutlak** di dasar. `fader.ts` Studio menyimpan dB dengan unity di 75% travel; bolak-balik lewat dB membuat "benar-benar nol" jadi −∞ yang harus dijaga di tiap konversi |
| EQ kill | `-26 dB`, bukan `-inf` | −∞ memaksa cabang khusus di setiap rumus gain, dan telinga tidak bisa membedakan −26 dari −∞ untuk satu band di dalam mix |
| `loop.active` | bit TERPISAH dari `in`/`out` | Itu seluruh guna RELOOP. `loop: {in,out} \| null` membuat keluar loop menghapus batasnya, dan memasangnya lagi dengan tangan di tengah mix tidak mungkin |
| `deck.bend` | pengali terpisah dari `tempo.fader` | Nudge harus kembali ke 1 saat tangan lepas. Kalau ia menulis ke fader, satu nudge mengubah BPM lagu secara permanen |
| `deck.seekEpoch` | ada sejak fase 1, belum dipakai | Sinyal yang persis dipakai `usePreviewPlayback` untuk memisahkan "playhead maju sendiri" dari "user melompat". Menyediakannya sekarang membuat fase audio jadi penyambungan |

### Layout: halaman ini TIDAK menggulir

`StudioLayout` sengaja membiarkan dokumen menggulir supaya toolbar `sticky`
bekerja. Halaman DJ kebalikannya: layar mixer yang menggulir berarti fader yang
sedang ditarik bisa keluar layar di tengah tarikan. `index.css` sudah memberi
`html, body, #root { height: 100% }`, jadi `DjLayout` cukup:

```
100vh, grid-template-rows:
  auto              header (judul, badge status, jam, tombol kembali)
  minmax(96px,14%)  waveform besar dua deck (canvas)
  minmax(0,1fr)     baris utama: DECK 1 · MIXER · DECK 2
  auto              baris FX (Beat FX + Sound Color FX)
  minmax(0,26%)     browser Collection — SATU-SATUNYA yang boleh menggulir
```

Kolom baris utama: `minmax(320px,1fr) minmax(240px,320px) minmax(320px,1fr)`.

Tidak ada media query — styling repo ini objek `CSSProperties` inline, tanpa
CSS-in-JS. Jadi tinggi viewport dibaca lewat `useViewportBand()` yang
mengembalikan **primitif** `'compact' | 'normal' | 'tall'` (<700 / 700–899 /
≥900). Urutan yang dikorbankan:

1. `tall → normal`: overview lagu-penuh menyusut, browser menyusut.
2. `normal → compact`: overview **hilang**, browser runtuh jadi strip 36 px yang
   bisa dibuka sebagai overlay. **Pad, fader, dan jog tidak pernah menyusut** —
   itu sasaran sentuh, dan mengecilkannya membuat alatnya salah sasaran, bukan
   lebih ringkas.
3. Di bawah ~560 px, jawaban yang jujur adalah kalimat *"tinggi layar kurang
   dari 560 px — beberapa kontrol tidak muat"*, bukan tata letak yang bertumpuk
   diam-diam.

Lebar: `minWidth: 1024` + `overflowX: auto`, dan badge `LAYAR SEMPIT` di header
saat `innerWidth < 1024`. **Mobile tidak didukung di iterasi ini**, dan
mengatakannya lebih baik daripada tata letak satu kolom yang membuat crossfader
tidak berguna.

### Tiga keputusan model yang menentukan sisanya

**1. Semua posisi SOURCE-space, tanpa kecuali.** Studio punya dua koordinat
(`docs/07 §8d`): SOURCE di dalam asset, TIMELINE di lane yang diskalakan
`speedRatio`. Deck memutar satu lagu utuh — tidak ada trim-in, tidak ada clip,
tidak ada lane — jadi kedua koordinat itu runtuh jadi satu. Tempo fader
mengubah **laju baca**, bukan geometri. Ini yang membuat `ScrollingWave`
dipakai apa adanya dengan `clipStart = 0`, `speedRatio = 1`.

**2. Kepustakaan asset TIDAK diduplikasi.** `djStore` **tidak** menyimpan
`assets`. Deck hanya memegang `assetId`; envelope, frames, tempo, dan grid
dibaca dari `studioStore.assets`. Satu registry, satu jalur decode, satu
IndexedDB. Track yang diimpor di Studio langsung muncul di Collection DJ dan
sebaliknya.

**3. Fakta asset yang IMMUTABLE boleh disalin; yang MUTABLE tidak.**
`frames`, `sampleRate`, `name` diset sekali di `assetFromBuffer` dan tidak
pernah berubah — menyalinnya ke `DeckState` membuat store bisa meng-clamp
playhead/cue/loop sendiri, di satu tempat (`withDerived`), tanpa membaca store
lain. Sebaliknya `bpmOverride`, `tempoOctave`, `beatOffsetOverride` **bisa**
diubah user di Studio kapan saja; menyalinnya berarti BPM deck basi diam-diam.
BPM karena itu **selalu** diturunkan lewat `resolveBeatGrid(asset)` saat
dipakai.

> Aturan ringkasnya, dan dipakai konsisten: **kalau sebuah nilai bisa berubah
> dari luar deck, turunkan — jangan simpan.**

---

## Perubahan pada kode yang sudah ada (sengaja minimal)

1. **`web/src/Root.tsx`** — `Route` union + tabel path + cabang render. Tambah
   kasus di `web/src/landing/__tests__/landing.test.tsx` (`describe('routeOf')`).

2. **`ScrollingWave.tsx`** — SATU baris yang berarti, plus tiga prop kosmetik.

   Seluruh kopling ada di `centerOf(p, sr)`. Dan yang perlu diganti ternyata
   hanya satu panggilan: `clipStart = 0` + `speedRatio = 1` membuat pemetaan
   di baris terakhir `centerOf` runtuh jadi identitas — bukan kebetulan, tapi
   konsekuensi dari "deck memutar satu lagu utuh, tidak ada TIMELINE-space".

   ```diff
   -  const heardSec = previewPositionSec();
   +  const heardSec = (p.positionSourceSec ?? previewPositionSec)();
   ```

   dengan prop baru `positionSourceSec?: () => number | null` — **fungsi**, bukan
   angka: ia dipanggil di dalam loop rAF, jadi posisi boleh bergerak 60×/detik
   tanpa satu render React pun. Prop `center` yang sudah ada tidak bisa dipakai
   karena ia dibaca dari `latest.current` yang cuma segar saat React me-render.

   Tiga prop kosmetik menyusul supaya adaptor DJ tidak perlu menyalin komponen:
   `regionTint` / `regionStroke` (Studio cyan `#6ee7ff`, DJ amber) dan `title`.
   Nol perubahan di `ClipPanels.tsx`, nol perubahan perilaku Studio — dan itu
   dikunci oleh tes baru `studio/timeline/scrolling-wave.test.tsx`.

3. **`web/src/studio/timeline/audio-import.ts`** — ekstrak `importBytesToAsset`.
   `importBytesToLane` hari ini mengerjakan sniff → gunzip → decode → envelope →
   `registerAsset` → `requestAssetTempo` → `registerBuffer` → `saveAsset` **dan**
   membuat clip. Deck DJ butuh semuanya kecuali clip. Yang lama tinggal
   memanggil yang baru lalu menambah clip, jadi jalur decode tetap **satu**
   (penjaga: `grep -c decodeAudioData web/src` harus tetap 2).

4. **`web/src/studio/persist/persistence.ts`** — jebakan retensi asset.
   `startAutosave` menghitung `used` hanya dari clip di lane, lalu
   `pruneAssets(used)`. Lagu yang di-import di `/dj` tidak duduk di lane mana
   pun. Urutan yang membunuhnya: import di `/dj` → buka `/studio` → autosave
   pertama menghapus byte-nya dari IndexedDB → refresh → deck kosong tanpa
   penjelasan.

   Perbaikannya bukan menambal `/dj` ke dalam rumusnya, tapi **memindahkan
   definisi "terpakai"** keluar dari satu halaman:

   ```ts
   // web/src/studio/persist/asset-roots.ts  (baru)
   export type AssetRoot = () => Iterable<number>;
   export function registerAssetRoot(root: AssetRoot): () => void;
   export function collectAssetRoots(): Set<number>;

   // persistence.ts
   export function assetsInUse(s: StudioAppState): Set<number>;  // clip ∪ akar
   ```

   Pendaftarannya di lingkup **modul**, bukan di `useEffect` — kalau ia hidup
   mengikuti komponen React, ia mati begitu user meninggalkan `/dj`, yaitu
   persis momen perlindungannya paling dibutuhkan. Dua akar didaftarkan: deck
   sesi berjalan, dan deck dari sesi terakhir yang tersimpan.

5. **`web/src/studio/persist/`** — ekstrak `decodeStoredAsset` dari
   `usePersistence.ts` dan tambah `loadLibraryIntoStore(sampleRate)`. `/dj`
   butuh kepustakaan tanpa membuka project Studio; memanggil `restoreProject`
   dari sana akan menimpa lane user.

   Sesi DJ disimpan di object store `project` yang **sudah ada**, dengan kunci
   `'dj'` — bukan store baru. Store baru berarti `DB_VERSION` 1→2, dan
   `openDb` sudah memutuskan `onblocked` → `resolve(null)`: satu tab lama yang
   masih terbuka akan mematikan persistensi **senyap** di tab baru.

6. **Entry point** — tombol/CTA ke `/dj` di `web/src/landing/LandingPage.tsx`
   dan di `web/src/studio/shell/StudioHeader.tsx`.

---

## Inventaris dari screenshot referensi

Dibaca langsung dari gambar yang diberikan user, baris per baris. Catatan
penting: tab yang aktif di screenshot itu **VIDEO**, bukan MIXER — makanya
kolom tengah berisi panel video (SLIDESHOW / TOUCH FX / TRANSITION FX / TEXT),
bukan mixer channel strip. Layar PERFORMANCE yang "normal" menaruh **mixer** di
situ. Halaman `/dj` mengambil susunannya, tapi mengisi kolom tengah dengan
mixer; blok video **tidak dibangun**.

| # | Baris di screenshot | Isi |
|---|---|---|
| 1 | Title bar | mode `PERFORMANCE ▾`, tab `FX · CFX · SAMPLER · MIXER · REC · VIDEO`, logo, layout `2Deck Horizontal ▾`, MASTER level + meter, MIDI, gear, jam |
| 2 | Waveform besar | dua track ditumpuk, penanda fase `112.4Bars` / `79.4Bars`, garis cue merah, penanda `D` |
| 3 | Baris info deck | nomor deck, artwork, judul, artis, waktu `03:40.2`, key `Am`, `SYNC`, `±10`, `MASTER` |
| 4 | Strip hot cue | huruf A–H berwarna di atas waveform mini |
| 5 | Pad | tab `HOT CUE · PAD FX · SLICER · BEAT JUMP`, 8 pad 4×2 berisi huruf + timecode, `MEMORY CUE ◀ CALL ▶` |
| 6 | Kolom tengah deck | `IN/OUT +RELOOP`, `1/4`, `SLIP`, `MT`, platter besar dengan BPM `122.0` dan `0.0%`, `CUE`, `▶/‖`, tempo fader vertikal, `Q` |
| 7 | Blok video | SLIDESHOW, TOUCH FX (KALEIDO/EDGES/BLUR + HOLD/ON), 3 pratinjau, TRANSITION FX GRID, AV SYNC, FAVORITE 1–5, TEXT/IMAGE/CAMERA |
| 8 | Browser bawah | pohon kiri (Playlists/Sampler/Video/Photo), tabel `Collection (1971 Tracks)` kolom Preview·Artwork·Track Title·Artist·Album·Genre·BPM·Rating·Time |

## Lapisan FX ternyata sudah dibangun UNTUK rekordbox

Ini bukan kebetulan yang menyenangkan, ini memang disengaja oleh commit
`feat(fx): enam efek rekordbox`. Buktinya ada di kode:

- `crates/engine/src/fx/filter.rs` baris 1: *"FILTER — sapuan resonan satu knob,
  **gaya rekordbox**. Tengah = lewat, putar kiri = lowpass turun, putar kanan =
  highpass naik."* Itu **persis** knob COLOR per channel di mixer rekordbox,
  sudah lengkap dengan alasan kenapa dua biquad selalu terpasang seri (tidak ada
  klik saat knob melewati tengah).
- `crates/engine/src/fx/desc.rs` `pflag::PRIMARY`: *"Parameter 'besar' **gaya
  rekordbox** — satu knob raksasa di panel FX."* Panel Beat FX bisa dirakit dari
  bendera ini tanpa daftar manual.
- `pflag::BEAT_SYNC` + `ParamCtx::frames_per_beat` + `Unit::Beats` — kerangka
  pembagian beat (1/2, 1/4, 1/1) untuk ECHO/SPIRAL sudah ada di engine.
- ECHO, SPIRAL, FLANGER, REVERB, PITCH menutupi sebagian besar Beat FX
  rekordbox, dan katalognya data-driven: **panel FX halaman DJ tidak butuh satu
  baris pun kode per-efek.**

Delapan efek yang ada beserta parameternya (dibaca dari `crates/engine/src/fx/`):

| Efek | Parameter | Peran di halaman DJ |
|---|---|---|
| `filter` | FILTER (knob), RESO | **knob COLOR per channel** — satu knob, tengah = lewat |
| `echo` | TIME (beat-sync), FB, TONE, P-PONG, LEVEL | Beat FX ECHO / PING PONG |
| `spiral` | TIME (beat-sync, jumps), FB, TONE, GLIDE, LEVEL | Beat FX SPIRAL |
| `flanger` | RATE, DEPTH, DELAY, FB, SHAPE, WIDTH, MIX | Beat FX FLANGER |
| `reverb` | DECAY, SIZE, DAMP, PRE, MOD, WIDTH, MIX | Beat FX REVERB |
| `pitch` | PITCH, FINE, GRAIN, FB, MIX | Beat FX PITCH / Sound Color PITCH |
| `eq` | 4 band × (kind, freq, Q, gain −24…+24 dB, aktif) | **belum cocok** untuk EQ DJ — lihat di bawah |
| `comp` | — | tidak dipakai di halaman DJ |

**EQ DJ bukan EQ studio.** Knob HI/MID/LOW di mixer DJ adalah **isolator**:
ujung kirinya benar-benar membunuh pita itu (−∞, bukan −24 dB), dan itulah yang
membuat trik "buang bass deck A, masukkan bass deck B" bisa dilakukan. EQ4 yang
ada bergerak −24…+24 dB dengan Q yang bisa diatur — bagus untuk mixing, tapi
memutar LOW habis ke kiri masih menyisakan bass yang terdengar. Jadi EQ channel
DJ adalah **komponen baru** (tiga filter dengan taper "kill", bukan `eq4`), dan
itu harus disebut sekarang supaya tidak dikira tinggal memakai yang ada.

Satu lubang nyata di lapisan ini — ABI FX belum bisa dikirimi tempo — jadi
**Utang 4** di bawah.

---

## Utang yang dinyatakan terbuka (satu sudah lunas)

Semuanya punya satu bentuk yang sama: kontrolnya **ada di layar karena
tempatnya memang di sana**, tapi mati dengan alasan yang terbaca. Repo ini punya
budaya keras soal itu — badge "UI ONLY" di `App.tsx`, `drawPlaceholderWave` yang
sengaja tidak menyerupai audio, `PITCH_LOCK_AVAILABLE = false` di
`studio/model.ts`.

### Utang 1 — deteksi KEY belum ada sama sekali

`crates/analysis/src/lib.rs` hanya mengekspor `detect_bpm`. Sel **Key** di header
deck (`Am` di screenshot) dan kolom Key di Collection **tidak punya sumber
data**, jadi isinya `—` — aturan `docs/10`: *"Tidak menebak diam-diam"*.
Konsekuensinya **KEY SYNC dan KEY SHIFT tidak dibangun**; tanpa deteksi key
keduanya hanya tombol yang memutar pitch dengan label yang menyesatkan.

Riset menunjukkan utang ini **lebih murah dari dugaan** dan layak dijadwalkan,
bukan digantung selamanya:

- Krumhansl-Schmuckler (korelasi profil 24 kunci atas chromagram) adalah ~150
  baris di `crates/analysis`, dan `odf.rs` sudah punya filterbank-nya.
- Alternatif tanpa Rust: `@audio/mir-key` (MIT, ~15 kB, JS murni, tanpa WASM).
  `essentia.js` **ditolak**: AGPL-3.0 dan ~2.2 MB payload minimum.
- Ketelitian yang realistis pada materi EDM: ~64–70% tepat. Sebagian besar
  kesalahannya adalah kuint dan minor relatif — yang secara harmonik memang
  **langkah yang sah**, jadi kegunaannya di layar lebih tinggi dari angkanya.

Dua keputusan yang harus diambil **sekarang** supaya tidak jadi migrasi nanti:

1. **Simpan `pitchClass` + `mode`, JANGAN simpan kode wheel.** Kode wheel
   diturunkan saat digambar, **setelah** transpose deck diterapkan. ±1 semitone
   = 7 langkah di roda; membakukan kodenya ke hasil analisis membuat angka di
   layar salah begitu tempo fader digeser.
2. **Pakai notasi Open Key, bukan Camelot.** Ini **menyimpang dari rekordbox
   dengan sengaja**: rekordbox hanya menawarkan `[Classic]` (Am, F#m) dan
   `[Alphanumeric]` — yang alphanumeric itu Camelot (8A, 5B) — dan tidak punya
   Open Key sama sekali. Alasan menyimpang: "Camelot" dan Camelot Wheel adalah
   **merek dagang Mixed In Key LLC**, dan pemegangnya menyatakan seluruh produk
   — termasuk gratisan — butuh lisensi. Notasi 8A/8B de facto standar, tapi
   **namanya** dilindungi; Open Key (notasi Traktor) tidak punya klaim itu.
   Konversinya sepele: `openKey = ((camelot + 4) mod 12) + 1`. `[Classic]`
   (Am / F#m) bebas dan tetap ditampilkan sebagai bentuk utama.

### Utang 2 — MASTER TEMPO (key lock)

`docs/07 §8a` sudah memutuskan **varispeed, bukan time-stretch** — menggeser
tempo ikut menggeser pitch. Untuk DJ itu berarti tombol **MT** rekordbox
(key lock) belum bisa benar-benar bekerja, dan `docs/09` memang menunda
time-stretch.

`docs/07 §8c` sudah memilih jalannya: **WSOLA sendiri di Rust** (~300 baris,
lisensi bersih; Rubber Band ditolak karena GPL v2 menular). Tapi rencana itu
ditulis untuk **pre-render di worker**, dan itu **tidak berlaku untuk deck DJ**:
tempo fader digerakkan SAAT lagunya berbunyi, jadi tidak ada momen tenang untuk
mem-pre-render. MT di halaman DJ menuntut WSOLA **realtime di dalam worklet**,
lengkap dengan masalah beban tidak rata yang §8c sendiri sebut sebagai pembunuh
realtime.

Karena itu: tombol **MT ada di UI sejak fase 1, tapi dinonaktifkan dengan
alasan yang terbaca** ("MASTER TEMPO belum ada — tempo fader = varispeed,
pitch ikut bergeser"), persis pola badge "UI ONLY" di `App.tsx`. Menyalakan
tombol yang tidak melakukan apa-apa adalah bentuk kebohongan yang paling mahal
di perkakas audio.

### Utang 3 — beat grid: dua hal yang baru berbahaya di halaman DJ

Di Studio, grid dipakai untuk memotong dan menempel — meleset 20 ms tidak fatal.
Di halaman DJ, **seluruh** loop, quantize, beat jump, dan SYNC menumpang grid
yang sama, dan lagunya berbunyi selama enam menit. Dua hal karena itu naik
statusnya dari "nanti" jadi "harus disebut".

**(a) Presisi BPM.** Grid di sini ber-BPM konstan (`BeatGrid { bpm, offsetSec }`).
Pada 128 BPM satu ketukan 468.75 ms; untuk tetap di dalam 25 ms (ambang
terdengarnya pergeseran) sepanjang 6 menit — 768 ketukan — BPM harus benar
dalam **±0.0089 BPM**, yaitu 0.0069%. Itu tidak bisa dicapai dengan merata-rata
selisih antar-onset; jalannya adalah interpolasi puncak parabolik pada ACF +
penguncian ke pecahan sederhana (integer, ½, ⅔, ⅓). `crates/analysis` sudah
punya sisir harmonik dan prior-nya; yang belum ada adalah **penguncian**-nya.
Sampai itu ada, loop 32-bar akan terlihat merayap keluar dari transiennya, dan
yang disalahkan akan `ScrollingWave`.

**(b) Fase grid bergantung browser.** `ARCHITECTURE.md` dan `docs/09`
menyebut import lewat **Symphonia di worker**, tapi `web/src/audio/import-worker.ts`
**tidak pernah dipanggil** — jalur yang hidup adalah `ctx.decodeAudioData` di
`studio/timeline/audio-import.ts` (dan file itu sendiri menandainya
`TODO(engine)`). Artinya decoder-nya adalah decoder browser: **FFmpeg di
Chromium, CoreAudio di Safari**, dan keduanya menangani encoder delay/padding
MP3 secara berbeda — selisih 12–50 ms. File yang sama karena itu **mendapat fase
grid yang berbeda di browser yang berbeda**, jauh di atas ambang 25 ms.

Untuk halaman DJ ini bukan detail: dua orang dengan file yang sama akan melihat
downbeat di tempat yang berbeda. Yang dilakukan sekarang, murah: simpan
`gridOffsetMs` per asset (satu angka, sudah sebentuk dengan `beatOffsetOverride`
yang ada), sehingga perbaikan decoder nanti adalah satu nilai — bukan penulisan
ulang seluruh grid yang sudah dikoreksi tangan.

### ~~Utang 4~~ — LUNAS: Beat FX sekarang tahu tempo

Dulu: ABI `fxchain_*` tidak punya jalan untuk mengirim tempo, dan `begin_block`
menulis `sample_rate * 0.5` secara harfiah — 120 BPM, berapa pun tempo
materinya. Label "1/4 beat echo" berbohong pada lagu mana pun yang bukan 120 BPM,
dan gejalanya hanya bisa **didengar**.

Sekarang: `FxRack` menyimpan `frames_per_beat` sendiri dengan
`set_frames_per_beat`, `fxchain_set_tempo(ptr, frames_per_beat)` ada di ABI,
worklet meneruskannya lewat pesan `tempo`, dan `audio/fx-insert.ts` mengirim
panjang ketukan dari BPM **efektif** deck target — jadi ia ikut bergerak saat
tempo fader digeser. Dikunci dua tes Rust di `crates/engine/src/fx/mod.rs`.

---

## Matriks fitur rekordbox

Kolom **Status** hanya punya tiga nilai, dan artinya keras:
**BANGUN** = jalan penuh di iterasi ini · **MATI** = ada di layar (tempatnya
memang di sana) tapi dinonaktifkan dengan alasan yang terbaca ·
**TIDAK** = tidak digambar sama sekali.

### Deck

| Fitur rekordbox | Status | Catatan |
|---|---|---|
| PLAY / PAUSE | BANGUN | |
| CUE (semantik CDJ: tahan = putar dari cue, lepas = balik) | BANGUN | tiga jalur di satu tabel tes |
| Jog wheel — scrub | BANGUN | tarik mendatar = cari posisi |
| Jog wheel — mode VINYL (scratch) | TIDAK | butuh AudioWorklet resampler; varispeed `playbackRate` tidak bisa mundur |
| Pitch bend (◀◀ / ▶▶) | BANGUN | ±4% selama ditahan, menulis ke `deck.bend` — **bukan** ke tempo fader, supaya satu dorongan untuk menutup selisih milidetik tidak mengubah tempo lagu secara permanen |
| Muat / keluarkan lagu dari deck | BANGUN | tombol ⏏ di baris info. Cue TIDAK ikut hilang — ia milik asset |
| Tempo fader ±6 / ±10 / ±16 / WIDE | BANGUN | travel + range terpisah. **WIDE = ±100%**, bukan sekadar "lebih lebar"; di −100% lagu berhenti. Reset = klik-ganda angka % |
| MASTER TEMPO (MT / key lock) | MATI | Utang 2 |
| SYNC (tempo) | BANGUN | **toggle** — menekan lagi mematikannya, dan tempo fader **tetap di tempatnya** (mematikan SYNC berarti mengambil alih tempo yang sudah selaras; mengembalikan fader ke nol akan melempar lagunya keluar dari beat). Menolak dengan kalimat kalau di luar range atau tanpa grid |
| SYNC (fase / downbeat) | TIDAK → D8 | label berbunyi `SYNC · TEMPO`, bukan `SYNC` |
| MASTER deck | BANGUN | hanya satu deck boleh master, ditegakkan `withDerived` |
| Hot cue A–H + warna | BANGUN | milik ASSET, bukan deck. **Pad** (tetikus): kosong = pasang, terisi = lompat ke sana — sekali klik, satu perbuatan. **Keyboard** (angka): tombol ON/OFF — tekan lagi = berhenti dan kembali ke titik cue. Keduanya berbeda dengan sengaja: jari yang menekan angka tidak melihat layar, dan lompatan kedua ke tempat yang sama tidak terdengar melakukan apa pun. Tekanan kedua **tidak pernah menghapus**; hapus lewat SHIFT-klik atau klik kanan |
| Memory cue + CALL ◀ ▶ | BANGUN | daftar terpisah dari hot cue. Tombolnya **toggle**: menekan di posisi yang sama menghapusnya, dan labelnya berubah jadi `HAPUS CUE` supaya gerakannya terbaca sebelum ditekan |
| Loop IN / OUT / EXIT / RELOOP | BANGUN | `active` bit terpisah supaya RELOOP mungkin |
| Auto/beat loop 1/4 … 32, ×2 & ÷2 | BANGUN | jangkar di `inAt`, bukan playhead |
| Active loop (loop tersimpan yang menyala sendiri) | TIDAK | butuh model cue yang lebih kaya; ditunda sampai ada yang memintanya |
| Beat jump | BANGUN | |
| Pad mode HOT CUE / LOOP / BEAT JUMP / ROLL | BANGUN | Pad BEAT LOOP **toggle**: menekan yang menyala mengeluarkan loop (batasnya tetap tersimpan, jadi RELOOP masih mungkin). LOOP ROLL **momentary**: ditahan = loop + SLIP, dilepas = mendarat di posisi seolah roll tidak pernah terjadi — itu satu-satunya yang membedakannya dari BEAT LOOP |
| Pad mode SLICER | TIDAK | butuh delapan voice sekaligus dari satu deck — subsistem sendiri |
| Pad mode PAD FX, KEYBOARD, KEY SHIFT, SAMPLER, SEQ | TIDAK | KEY SHIFT butuh Utang 1 & 2; SAMPLER adalah deck kelima |
| SLIP mode | **BANGUN** | playhead bayangan hidup di `DeckPlayer`, bukan di store — ia bergerak kontinu dari jam audio, dan hanya dibaca pada satu momen: saat slip dilepas |
| Quantize + pembagiannya | BANGUN | bit per deck, pembagian global. Pecahannya **1/16 · 1/8 · 1/4 · 1/2 · 1** — rekordbox satu langkah lebih halus dari CDJ (yang mulai di 1/8), default 1 ketukan |
| ×2 / ÷2 BPM | BANGUN | `shiftAssetTempoOctave` sudah ada |
| REVERSE / CENSOR | TIDAK | browser tidak memutar `AudioBufferSourceNode` dengan `playbackRate` negatif; reverse berarti buffer terbalik kedua per lagu, atau resampler AudioWorklet sendiri |

### Mixer

| Fitur | Status | Catatan |
|---|---|---|
| Channel fader | BANGUN | travel 0..1, gain `t²` |
| Crossfader + kurva (smooth / sharp / cut) | BANGUN | kurva di layar wajib = kurva yang terdengar (D6) |
| TRIM / gain | BANGUN | |
| EQ 3 band HI/MID/LOW dengan KILL | BANGUN | komponen baru, bukan `eq4`. KILL adalah **bit terpisah**, bukan menimpa nilai knob — manual harfiah: *"while they light up, each controller is not activated"*. Knob ikut dinonaktifkan saat band mati, dan menyalakannya lagi mengembalikan setelan semula |
| Knob COLOR / FILTER per channel | BANGUN | `crates/engine/src/fx/filter.rs` memang ditulis "gaya rekordbox" |
| Sound Color FX selain FILTER | TIDAK | rekordbox punya **tepat 9**: FILTER · SPACE · DUB ECHO · SWEEP · NOISE · CRUSH · JET · PITCH · GATE/COMP. Katalog kita baru punya FILTER; menambah sisanya adalah pekerjaan Rust, bukan UI |
| CUE / headphone + CUE MIX + CUE LEVEL | **BANGUN** | bus CUE pre-crossfader → `MediaStreamAudioDestinationNode` → `<audio>.setSinkId`. Butuh user MEMILIH perangkat kedua; selama belum, bus-nya sengaja tidak tersambung ke mana pun (kalau tersambung ke default, CUE malah menggandakan master) dan UI mengatakannya |
| Meter level per channel + master | **BANGUN** | peak dari `AnalyserNode`, naik seketika turun 60 dB/detik, penahan puncak 800 ms. Tetap menulis `NO SIGNAL` sebelum audio dinyalakan — batang yang menari tanpa sinyal tetap dilarang |
| MASTER gain | BANGUN | |
| BOOTH out | TIDAK | tidak ada output ketiga |

### Beat FX

| Fitur | Status | Catatan |
|---|---|---|
| Pilih efek dari katalog | BANGUN | dari `fxCatalog()`; efek ke-9 muncul tanpa satu baris TypeScript |
| Target CH1 / CH2 / MASTER | BANGUN | |
| Pembagian beat | **BANGUN** | Utang 4 lunas: `fxchain_set_tempo` ditambahkan ke ABI dan `FxRack` menyimpan `frames_per_beat`-nya sendiri. Pemilihnya hanya muncul untuk efek ber-`pflag::BEAT_SYNC` — rentangnya memang **tidak seragam** di rekordbox, dan REVERB serta PITCH tidak memakai beat sama sekali |
| LEVEL / DEPTH | BANGUN | insert, bukan send — dikatakan di UI |
| Release FX | TIDAK | butuh buffer tangkapan + pelepasan; subsistem sendiri |

### Browser & analisis

| Fitur | Status | Catatan |
|---|---|---|
| Collection: nama, durasi, BPM | BANGUN | BPM dari `tempo-worker`, `ANALISIS…` selama berjalan |
| Kolom Key | MATI | Utang 1 — isinya `—` |
| Kolom Artist / Album / Genre / Rating | TIDAK | `StudioAsset` tidak punya tag; membaca ID3 adalah pekerjaan tersendiri |
| Sort + search | BANGUN | BPM `null` diurut **ke akhir** |
| Hapus lagu dari Collection | BANGUN | Tombol `✕` per baris, **dua langkah** (`✕` → `HAPUS?`), lebar tetap, batal sendiri setelah 5 detik. Konfirmasinya **tidak** dibatalkan saat pointer keluar — versi pertama begitu, dan karena sasarannya 18 px, tangan yang bergeser sedikit di antara dua klik membuat penghapusan mustahil diselesaikan. Kegagalan dilaporkan **di baris Collection itu sendiri**, bukan hanya di baris status FX yang jauh di atas karena byte aslinya ikut hilang dari IndexedDB dan tidak bisa dibatalkan. **MENOLAK** kalau lagunya dipakai clip di Studio, dengan menyebut jumlah dan nama lane-nya — registry asset dipakai bersama, dan clip yang menunjuk asset hantu hanya diam tanpa error. Deck yang memegangnya dikosongkan lebih dulu, dan cue-nya ikut dilupakan. Command palette punya jalannya juga, **tanpa binding keyboard**: satu ketukan salah tidak boleh membuang berkas untuk selamanya |
| Playlist / My Tag / Related Tracks | TIDAK | butuh model kepustakaan sendiri |
| Preview player di browser | TIDAK | `startAudition` Studio ada, tapi menyambungkannya = audio |
| Beat grid + koreksi downbeat | BANGUN | `resolveBeatGrid` + `setAssetBeatGrid` sudah ada |
| Analisis frase (phrase) | TIDAK | tidak ada analisisnya |

### Yang ada di screenshot tapi sengaja tidak dibangun

Seluruh blok **VIDEO** (SLIDESHOW, TOUCH FX, TRANSITION FX, TEXT/IMAGE/CAMERA,
AV SYNC), **SAMPLER**, **REC**, **MIDI**, dan pemilih layout `2Deck Horizontal`.
Tab yang aktif di screenshot memang VIDEO — itu sebabnya kolom tengahnya berisi
panel video alih-alih mixer. Halaman `/dj` mengambil susunan barisnya dan
mengisi kolom tengah dengan **mixer**, yang memang yang ada di sana pada layar
PERFORMANCE biasa.

---

## Hot cue milik ASSET, bukan milik deck

Ini keputusan model yang paling menentukan, dan `persist/persistence.ts` sudah
menunjukkan jalannya lewat `assetGrids`: *"asset sendiri sengaja TIDAK disimpan
dan dibangun ulang tiap boot; yang tidak bisa dibangun ulang adalah **keputusan
user**, dan hanya itu yang ikut."*

Hot cue, memory cue, dan titik loop tersimpan adalah keputusan user atas
**materi**, bukan atas deck. Di rekordbox pun begitu — muat lagu yang sama ke
deck 2, cue-nya ikut. Jadi:

- `DeckState` menyimpan **apa yang sedang terjadi** (asset mana, playhead di
  mana, sedang play, loop sedang aktif, posisi tempo fader).
- `DjState.cues: Record<assetId, TrackCues>` menyimpan **keputusan user atas
  track** — hot cue A–H, memory cue, loop tersimpan. Ini yang di-persist.
- Bertukar deck atau memuat ulang track tidak kehilangan apa pun, dan tidak
  perlu ada kode penyalinan cue antar deck.

Konkretnya: `DjState.cues: Record<assetId, TrackCues>`, dan aksi pad tetap
ber-parameter `deckId` (menyelesaikannya ke `assetId` di dalam store). Deck
tanpa asset = pad mati. Kalau cue dipasang di `DeckState`, `ejectDeck` lalu
memuat lagu yang sama akan kehilangan sepuluh menit kerja tanpa satu pun
peringatan.

Penyimpanannya di object store `project` yang sudah ada dengan kunci `'dj'`
(lihat §Perubahan nomor 5), dan `/dj` punya autosave sendiri — `startAutosave`
milik Studio hanya hidup selama `App` ter-mount dan ia men-serialize project
Studio, yang tidak boleh ditulis ulang dari halaman yang bahkan tidak memuatnya.

---

## Tiga aturan yang paling mudah dilanggar saat menulis kodenya

**1. Selector harus stabil secara referensi — dan dua deck membuatnya lebih
tajam.** `useDj(s => ({ a: s.decks.A, b: s.decks.B }))` mengarang objek baru
tiap panggilan → render tanpa henti. Begitu juga `useDj(s => crossfaderGains(…))`,
yang terlihat seperti "selector turunan" padahal mengembalikan objek baru.
Aturannya: **fungsi yang mengembalikan objek dipanggil di dalam render, dari
primitif.** Semua mutasi deck lewat satu helper `patchDeck` yang mengembalikan
`null` kalau objeknya tidak berubah, sehingga `tick()` — satu-satunya aksi yang
menyentuh dua deck — tetap mengembalikan objek LAMA untuk deck yang tidak
playing. Dikunci oleh `dj/store-stability.test.tsx`: probe berlangganan deck A,
50 aksi pada deck B + crossfader, `expect(renders).toBe(1)`.

**2. Deck dicerminkan lewat `flexDirection`/`textAlign` + satu CSS var
`--dj-deck-accent`, TIDAK PERNAH lewat `transform: scaleX(-1)`.** `scaleX(-1)`
membalik teks, membalik arah drag (fader tempo jadi terbalik tanpa satu baris
kode yang mengatakannya), dan membuat `getBoundingClientRect` di `useDrag`
menghasilkan fraksi terbalik — bug yang cuma muncul di satu deck dan mustahil
ditebak dari kodenya. Channel strip mixer **tidak** dicerminkan; di alat nyata
pun keduanya identik.

**3. `minmax(0, …)` di setiap baris DAN kolom grid, `minHeight: 0` di setiap
anak.** Alasannya sama dengan komentar di `StudioLayout.tsx`, tapi gejalanya di
halaman `overflow: hidden` lebih buruk: isinya terpotong **tanpa scrollbar**,
jadi tidak ada petunjuk apa pun bahwa ada yang hilang.

## Dokumen yang ditulis ke `recordbox/`

User meminta plan-nya hidup di folder `recordbox/` di root repo. Bentuknya
mengikuti konvensi `docs/` yang sudah ada: bernomor, Bahasa Indonesia, dan
menjelaskan **kenapa**, bukan **apa**.

| Berkas | Isi |
|---|---|
| `recordbox/00-plan.md` | Dokumen ini: context, keputusan, tiga utang, fase D0–D9, verifikasi |
| `recordbox/01-fitur-rekordbox.md` | Riset fitur PERFORMANCE mode + matriks BANGUN/MATI/TIDAK beserta alasan tiap barisnya |
| `recordbox/02-model-store.md` | `model.ts` dan `store.ts` lengkap: tipe, helper murni, `djActions`, tabel disimpan-vs-diturunkan, dan tujuh jebakan stabilitas referensi |
| `recordbox/03-layout-komponen.md` | Pohon komponen + tabel mapping "elemen rekordbox → data model → aksi → state" meniru `docs/08-ui-mapping.md`; grid 100vh dan aturan degradasinya |
| `recordbox/04-integrasi.md` | Diff `ScrollingWave`, ekstraksi `importBytesToAsset`, registry `asset-roots`, `loadLibraryIntoStore` — semua yang menyentuh kode yang sudah ada |
| `recordbox/05-audio.md` | Rencana graf Web Audio D5–D8, `fxchain_set_tempo`, dan syarat MASTER TEMPO |
| `recordbox/06-grid-edit.md` | Panel `[GRID EDIT]`: 11 kontrol rekordbox vs yang sudah ada, kunci-dua-titik sebagai jawaban Utang 3a, fase G1–G4, dan kenapa `[Dynamic]` ditunda |

`ARCHITECTURE.md` mendapat satu baris di tabel index-nya yang menunjuk ke
`recordbox/00-plan.md`, supaya folder ini tidak jadi dokumen yatim.

## Fase

Ditulis dengan definisi "done" yang bisa diuji, mengikuti gaya `docs/09-roadmap.md`.

### D0 — Route + kerangka halaman
`Root.tsx` (tabel path), `web/src/dj/DjPage.tsx`, `DjLayout.tsx`, CTA di landing
& StudioHeader.
**Done:** `/dj` dan `/dj/` membuka halaman; back/forward browser berpindah;
deep-link setelah refresh tetap `/dj` (SPA fallback sudah ada di
`deploy/nginx.conf` + `deploy/vercel-config.json`, tidak perlu diubah); tes
`routeOf` di `web/src/landing/__tests__/landing.test.tsx` bertambah kasusnya;
halaman tidak menggulir pada 1280×800.

### D1 — Model + store
`web/src/dj/model.ts`, `web/src/dj/store.ts`.
**Done:** seluruh state dua deck + mixer bisa diubah lewat `djActions` dan diuji
tanpa React maupun Web Audio; selector mengembalikan nilai yang stabil secara
referensi (tes yang menghitung jumlah render); tidak ada satu pun aksi yang
menyentuh `AudioContext`.

Tambahan: `crossfaderGains(x,'smooth')` memenuhi `a² + b² = 1` dalam 1e-12 untuk
101 nilai x, dan `faderForBpm` mengembalikan **`null`** — bukan nilai ter-clamp —
saat target di luar range. Fader yang mentok di ±16% sambil mengaku SYNC adalah
kebohongan yang hanya ketahuan lewat telinga.

### D2 — Kulit UI penuh, deck masih kosong
Seluruh pohon komponen, tema amber, tata letak.
**Done:**
1. Render di 1440×900 tanpa satu pun `console.error` (smoke test, pola
   `studio-smoke.test.tsx`).
2. **Setiap** kontrol menggerakkan store — crossfader, 2 channel fader, 6 knob
   EQ, 2 filter, 2 trim, 2 tempo fader, 16 pad, 2 jog, master, cue mix, 5
   kontrol FX. Tidak boleh ada aksi tanpa pemanggil, tidak boleh ada kontrol
   tanpa aksi.
3. Header memajang `UI ONLY · TANPA AUDIO`.
4. Deck kosong memakai `drawPlaceholderWave` — garis putus + arsir diagonal,
   **tidak menyerupai audio**.
5. Meter menampilkan skala kosong bertuliskan `NO SIGNAL`. **Tidak ada batang
   yang bergerak.** Meter yang menari tanpa audio adalah kebohongan yang paling
   sering dimaafkan dan paling merusak kepercayaan pada sisa layar.
6. `window.AudioContext` di-spy di tes dan **tidak pernah dipanggil**.

### D3 — Kepustakaan + import + muat ke deck
`importBytesToAsset`, `asset-roots.ts`, `loadLibraryIntoStore`,
`CollectionBrowser`, drop zone, `LOAD A`/`LOAD B`.
**Done:**
1. Drop WAV → muncul dengan `ANALISIS…` di kolom BPM, lalu angka nyata dari
   `tempo-worker`, dengan penanda "tidak yakin" di bawah `TEMPO_UNCERTAIN`.
2. `LOAD A` → overview menggambar **envelope asli**, bukan placeholder.
3. **Regresi jebakan prune:** import di `/dj` → buka `/studio` → tunggu autosave
   (>600 ms) → refresh → kembali ke `/dj` → lagu masih ada. Diuji juga murni
   lewat `assetsInUse` tanpa IndexedDB dan tanpa timer.
4. Buka `/dj` di tab baru tanpa pernah menyentuh Studio → kepustakaan terisi.
5. Drop file bukan-audio → **kalimat**, bukan "gagal".
6. `grep -c decodeAudioData web/src` tetap **2**.

### D4 — Waveform bergerak, grid, loop, pad, jam simulasi
**Done:**
1. PLAY → playhead maju pada laju efektif; geser tempo ke +6% → `remaining`
   berkurang lebih cepat DAN BPM efektif berubah bersamaan (bukti `effectiveRate`
   dipakai di satu tempat).
2. Playhead tepat di tengah; garis bar sejajar transien pada lagu yang grid-nya
   benar.
3. Beat loop 4 ketukan, `1/2×` dua kali → 1 ketukan, dan **`inAt` tidak
   bergeser**.
4. Hot cue melompat ke posisi tersimpan dalam ±1 sample.
5. Dua deck jalan sekaligus pada tempo berbeda, ≥55 fps (kriteria yang sama
   dengan M5 `docs/09`).
6. Badge **masih** `UI ONLY · TANPA AUDIO`.
7. Tombol SYNC menampilkan `SYNC · TEMPO`, bukan `SYNC` polos — penyelarasan
   **fase** belum ada, dan label harus mengatakannya.

### D5–D9 — Audio ✅

Sudah dikerjakan; detailnya di [`05-audio.md`](05-audio.md).

| | Isi | Bukti |
|---|---|---|
| **D5** | dua deck berbunyi, jam audio menggantikan `setInterval`, badge jadi `READY` | `deck-player.test.ts` — posisi tidak hanyut setelah 5 menit |
| **D6** | trim → EQ → COLOR → fader → crossfader → master | `dj-graph.test.ts` — gain crossfader yang MENDARAT sama dengan `crossfaderGains`, tiga kurva × lima posisi |
| **D7** | loop sample-akurat lewat `loopStart`/`loopEnd` node | `deck-player.test.ts` — pelipatan berkali-kali, dan ÷2 di paruh kedua loop |
| **D8** | Beat FX insert + `fxchain_set_tempo` di ABI Rust | dua tes Rust di `crates/engine/src/fx/mod.rs` |
| **D9** | sesi bertahan setelah refresh | `dj-session.test.ts` — termasuk bahwa `playing` **tidak** ikut dipulihkan |

Tiga tambahan di `crates/analysis` yang riset tunjukkan paling tinggi nilainya
per baris kode **belum** dikerjakan, dan urutannya tetap:

1. **Penguncian BPM ke pecahan sederhana** — tanpa ini grid merayap (Utang 3a).
2. **Pelacak ketukan Ellis (program dinamis)** di atas ODF yang sudah ada — ~80
   baris, di bawah 10 ms. Mengubah `beat_offset_sec` dari sekadar **fase** jadi
   **daftar ketukan sungguhan**.
3. **Deteksi downbeat** — hampir gratis: `odf.rs` sudah menyimpan enam envelope
   per pita; batasi ke <200 Hz dan voting atas empat kandidat fase bar.

## Pintasan keyboard

Halaman ini **tidak memasang listener keyboard sendiri**. Ia mendaftarkan
command-nya ke app shell (`docs/15-app-shell.md`), dan shell yang memiliki satu
dispatcher untuk seluruh aplikasi. Itu yang membuat command palette (`⌘K`),
editor pintasan (`?`), dan — nanti — MIDI melihat daftar aksi yang SAMA.

Tata letaknya **tangan kiri = deck A, tangan kanan = deck B**, bercermin:

```
  1 2 3 4                                    7 8 9 0     hot cue A–D
  Q W E                                        I O P     play · loop 4 · exit
  A S D F                                  J K L ;       cue · sync · bend −/+
  Z X                                          , .       loop ÷2 · ×2
```

Angka `1–4` / `7–0` adalah hot cue, dan di keyboard ia **tombol ON/OFF**:
tekan lagi = berhenti dan kembali ke titik cue itu. Pad di layar tidak begitu —
lihat baris Hot cue di matriks.

Global: `Space` putar deck yang **fokus** · `` ` `` pindah fokus · `←`/`→`
crossfader · `↑`/`↓` pilih lagu di Collection · `Enter` muat ke deck fokus ·
`Shift+←`/`Shift+→` muat langsung ke deck A/B · `G` Beat FX.

`Tab` **sengaja tidak dipakai**: ia satu-satunya cara keyboard berpindah antar
kontrol, dan merampasnya membuat halaman berhenti bisa dipakai tanpa tetikus.

Tidak ada "standar" papan ketik DJ — Serato, Traktor, dan Mixxx semuanya
berbeda. Yang dipakai di sini adalah pembagian yang bercermin, karena tangan
menghafal **letak** dan dua deck dengan pola yang sama hanya perlu dihafal
sekali. Semua binding disimpan sebagai **posisi tombol**, jadi tidak bergeser
saat layout keyboard diganti — dan semuanya bisa diubah user lewat `?`.

**Deck fokus** (`DjState.focusedDeck`) ada karena `Space` di halaman dua deck
butuh sasaran yang bisa dijelaskan. Ia berbeda dari `masterDeck`: master adalah
acuan TEMPO (milik audio), fokus adalah sasaran PERINTAH (milik antarmuka).
Menyentuh deck mana pun memindahkan fokus ke sana, jadi keyboard dan tetikus
tidak pernah bercerita berbeda tentang deck mana yang sedang dipakai.

---

## Aturan kontrol dua-keadaan

Ditulis setelah satu bug dilaporkan dan audit menemukan lima lagi sekelas.

> **Kontrol yang punya keadaan MENYALA harus bisa dikembalikan lewat kontrol
> yang sama.**

Kalau tidak, satu-satunya jalan keluar ada di tempat lain — dan kontrol yang
menyala tapi tidak merespons dirinya sendiri terbaca sebagai kerusakan, bukan
sebagai desain. Yang ditemukan audit:

| Kontrol | Dulu | Sekarang |
|---|---|---|
| Pad BEAT LOOP | hanya bisa dinyalakan | toggle; `exitLoop` (batas tetap tersimpan, RELOOP masih mungkin) |
| Pad LOOP ROLL | identik dengan BEAT LOOP — dua pad mode yang melakukan hal yang sama bukan dua fitur | momentary: tahan = loop + SLIP, lepas = mendarat di posisi bayangan |
| SYNC | sekali nyala, tidak bisa mati | toggle; tempo fader tetap di tempatnya |
| KILL EQ | menimpa nilai knob — menyalakan lagi membuang setelan tangan | bit terpisah; knob dinonaktifkan tapi nilainya utuh |
| Memory cue | bisa ditambah, tidak pernah dihapus | toggle di posisi yang sama; label ikut berubah |
| Hot cue | hapus hanya lewat klik-kanan | SHIFT-klik **dan** klik-kanan |
| Deck | bisa diisi, tidak pernah dikosongkan | tombol ⏏ |

Dijaga oleh satu tes yang menyapu KELASNYA, bukan satu tombol:
`dj-smoke.test.tsx` → *"setiap kontrol dua-keadaan bisa dikembalikan lewat
kontrol yang sama"*. Tes itu menunjuk lingkupnya secara eksplisit
(`[data-dj-deck]`, `[data-dj-mixer]`) karena nama seperti `CUE` ada di dua
tempat yang berbeda artinya, dan `getAllByRole(...)[0]` diam-diam memilih yang
salah — tes yang menekan tombol keliru tetap hijau selama tombol itu kebetulan
juga sebuah toggle.

### Audit yang sama, dari arah lain

Setiap aksi di `djActions` yang **tidak punya pemanggil UI** diperiksa. Itu
menemukan tiga fitur yang diklaim matriks tapi tidak bisa dicapai: `ejectDeck`,
`removeMemoryCue`, dan `setCueDb` (knob CUE LEVEL memang tidak pernah dipasang).
Juga `setBend` — matriks mengklaim "jog scrub & bend", padahal `deck.bend`
selalu 1 karena tidak ada yang menulisinya; sekarang ada tombol pitch bend.

Aksi yang tetap tanpa pemanggil UI dan alasannya: `play` (pasangan `pause`,
dipakai lapisan audio), `setCuePoint` (jalur UI-nya lewat `cuePress`),
`toggleKeyLock` (sengaja digerbang `KEY_LOCK_AVAILABLE = false`). Sisanya
dihapus.

## Tes

Konvensi repo: `*.test.ts(x)` **bersebelahan** dengan kodenya, nama `describe`
dan `it` dalam Bahasa Indonesia (lihat `web/src/studio/shell/bpm-cell.test.tsx`).
`web/src/__tests__/setup.ts` sudah men-stub `ResizeObserver` dan Pointer Capture,
jadi tes drag benar-benar menjalankan jalur drag-nya.

| Berkas tes | Yang dijaga |
|---|---|
| `dj/model.test.ts` | Tabel: `crossfaderGains` 3 kurva × 5 posisi + invarian equal-power; `tempoPercent`/`effectiveBpm`/`faderForBpm` bolak-balik; `faderForBpm → null` di luar range; `channelFaderGain(0)===0` dan `(1)===1` **eksak**; `quantized` dengan quantize mati = identitas |
| `dj/store.test.ts` | `loadDeck` menyalin frames/name/sampleRate; `ejectDeck` menghapus cue, loop, DAN sync; `seek` meng-clamp; tabel semantik CUE (diam→tekan, playing→tekan, tahan→lepas); `halveLoop`/`doubleLoop` menjangkar di `inAt`; `tick` menghormati loop, berhenti di ujung, **tidak menyentuh deck yang tidak playing** |
| `dj/store-stability.test.tsx` | Probe deck A tidak render saat deck B / crossfader berubah. Kelas bug: `getSnapshot` tidak stabil → loop render |
| `dj/__tests__/dj-smoke.test.tsx` | Render tanpa `console.error`; **`AudioContext` tidak dibangun saat RENDER** — hanya setelah gestur, karena context di luar handler gestur lahir `suspended` tanpa gejala |
| `dj/audio/deck-player.test.ts` | Jangkar posisi tidak hanyut setelah 5 menit; pelipatan loop; bayangan slip; ÷2 di paruh kedua loop melompatkan deck ke dalam |
| `dj/audio/dj-graph.test.ts` | Topologi: tidak ada kanal yang lolos ke `destination`; tap CUE **pre**-crossfader; bus CUE tidak menyentuh destination; dua biquad COLOR permanen; gain crossfader yang mendarat = `crossfaderGains` |
| `dj/persist/dj-session.test.ts` | Cue/tempo/mixer bertahan; **`playing` tidak**; bank hot cue cacat dinormalkan jadi delapan slot |
| `dj/deck/pads.test.tsx` | Klik pad kosong → terisi di playhead; klik lagi → `seek`; shift-klik → kosong. Lewat jalur pointer sungguhan |
| `dj/mixer/crossfader.test.tsx` | `pointerdown`+`pointermove` dengan rect ter-stub → nilai store 0..1; ganti kurva mengubah pembacaan gain di layar |
| `dj/browser/collection.test.ts` | Urut BPM menaruh yang `null` **di akhir** — lagu tanpa BPM tidak boleh mengambil alih puncak daftar |
| `dj/browser/dj-import.test.ts` | Kegagalan meneruskan `reason` **apa adanya**, tidak pernah bisu |
| `dj/layout/dj-layout.test.tsx` | `innerHeight=640` → browser runtuh, `=1000` → tidak; akar `overflow: hidden` dan tiap baris `minmax(0` |
| `studio/persist/persistence.test.ts` (perluasan) | `assetsInUse`: asset tanpa clip + akar terdaftar → **ada**; tanpa akar → **tidak ada**. Regresi jebakan prune, murni, tanpa IndexedDB |
| `studio/timeline/scrolling-wave.test.tsx` (baru) | `positionSourceSec` yang disuntik dipanggil, `previewPositionSec` **tidak**; tanpa prop, perilaku lama tidak bergeser |
| `landing/__tests__/landing.test.tsx` (perluasan) | `routeOf('/dj')`/`'/dj/'`; di `/dj`, `App` **tidak** ter-mount (ia memasang interval, autosave, dan mencoba membangun AudioContext saat mount) |

Yang **tidak** dites di iterasi 1, dan itu disengaja: tidak ada tes audio, karena
tidak ada audio. Menulis tes yang lulus tanpa audio lalu membiarkannya lulus
setelah audio ada adalah cara paling rapi untuk tidak menguji apa pun.

---

## Risiko & pertanyaan terbuka

1. **Dua `ScrollingWave` sekaligus belum pernah diukur.** Studio menggambar
   satu; halaman ini dua, masing-masing memanggil `readEnvelope` per frame untuk
   ~2800 kolom (1400 px × dpr 2) → ~336k pembacaan kolom/detik. `envelope.ts`
   memang dirancang untuk itu (buffer `scratch` dipakai ulang, nol alokasi), tapi
   angkanya belum diuji berdampingan. **Mitigasi:** kriteria D4 nomor 5
   mensyaratkan ≥55 fps; kalau gagal, jawaban pertama adalah men-clamp dpr
   waveform ke 1 — **bukan** WebGL, konsisten dengan alasan penundaannya di
   `docs/09`.
2. **`sampleRate` mana yang dipakai `ensureContext`?** Studio memakai
   `state.sampleRate` project; `/dj` tidak punya project. Usul:
   `previewSampleRate()` kalau context sudah ada, kalau belum
   `studioStore.getState().sampleRate`. Konsekuensinya — buka `/studio` dengan
   project 44.1 kHz lalu ke `/dj` berarti deck jalan di 44.1 kHz — benar, tapi
   harus ditulis di komentar supaya tidak mengejutkan.
3. **`ScrollingWave` dipakai dua konteks.** Kalau prop-nya salah desain, Studio
   berubah perilaku tanpa ada yang menangkap. Karena itu perubahannya wajib
   disertai tes perilaku-lama.
4. **Apakah FX `pitch` yang sudah ada cukup untuk mengompensasi varispeed
   ±16%?** Kalau ya, MT bisa hidup lebih awal dari yang diperkirakan. Kalau
   kualitasnya buruk di materi nyata, jangan dinyalakan sama sekali. **Harus
   diputuskan dengan mendengarkan, bukan dengan membaca kode.**
5. **SYNC pada lagu tanpa grid** harus menolak dengan kalimat ("deck B belum
   punya beat grid"), bukan diam. Sudah dimodelkan lewat `SyncResult`; ke mana
   kalimatnya dipajang belum diputuskan — usul: satu baris status di bawah baris
   FX, yang juga dipakai untuk kegagalan import.
6. **Beat FX: insert atau send?** DJM punya keduanya. `createFxNode` alami
   sebagai **insert**; send butuh keputusan berapa bus yang ada — celah yang
   `docs/08 §8e` sendiri belum tutup. Usul: insert dulu, dan katakan di UI bahwa
   level = dry/wet, bukan kirim.
7. **Asset hilang di bawah deck** → `DeckView.missing`, UI menulis "ASSET
   HILANG", deck tidak bisa play. **Jangan** auto-eject: menghapus keadaan user
   secara otomatis adalah cara termudah menghilangkan hot cue yang butuh sepuluh
   menit dipasang.
8. **Matematika kurva crossfader adalah pilihan produk, bukan standar.** Tidak
   ada "kurva sharp yang benar". Yang penting tesnya mengunci apa pun yang
   dipilih, sehingga mengubahnya nanti terlihat dan disengaja.

---

## Verifikasi

```bash
pnpm -C web test        # vitest
pnpm -C web build       # tsc --noEmit + vite build
pnpm run test:rust      # cargo test --workspace
pnpm run build:wasm     # WAJIB setelah mengubah crates/ — ABI FX ikut di sini
pnpm run dev            # http://localhost:5173/dj
```

Terukur pada saat ditulis: **819 tes web lulus** (baseline sebelum halaman ini
690), **332 tes Rust lulus**, `tsc --noEmit` bersih, build produksi bersih.

Manual, dan urutannya sengaja — tiap langkah menguji satu hal yang tidak bisa
diuji tanpa telinga:

1. Buka `/dj`. Badge berbunyi **`SENTUH UNTUK MENYALAKAN AUDIO`** — belum
   `READY`. Ini bukan basa-basi: context yang dibuat di luar gestur user lahir
   `suspended`.
2. Jatuhkan dua berkas audio ke baris Collection. BPM muncul setelah worker
   selesai; yang keyakinannya rendah ditandai `?`.
3. `LOAD A` dan `LOAD B`. Waveform menggambar envelope asli.
4. Tekan PLAY di deck A → **ada suara**, badge jadi `READY`, playhead bergerak,
   jendela waveform bergeser mulus dengan playhead diam di tengah.
5. Geser tempo fader → nada ikut naik/turun (varispeed — MT memang belum ada,
   dan tombolnya mati dengan alasan itu). Angka BPM dan sisa waktu ikut berubah
   **bersamaan**; kalau tidak, `effectiveRate` dipakai di lebih dari satu tempat.
6. Pad `BEAT LOOP` → 4 → loop terdengar rapat di grid. Tekan **÷2 saat playhead
   di paruh kedua loop** → deck melompat ke dalam loop yang lebih pendek, tidak
   lari keluar. Ini regresi yang paling mudah kembali.
7. Nyalakan `SLIP`, pasang loop, tunggu beberapa bar, tekan `EXIT` → lagu
   melanjut di posisi seolah loop tidak pernah ada.
8. Putar knob `COLOR` melewati tengah perlahan → **tidak ada klik** di titik
   tengah. Itu yang dibayar dua biquad permanen.
9. Klik label `LOW` → bass hilang. Klik lagi → kembali.
10. Sapu crossfader → angka gain di kiri-kanan berubah, dan yang terdengar
    mengikutinya. Ganti kurva `SMOOTH`/`SHARP`/`CUT` → bedanya terdengar.
11. Meter bergerak mengikuti materi, dan **berhenti di nol saat fader nol**.
12. Baris Beat FX: pilih `ECHO`, target `CH A`, `ON`, pilih `1/4` → pantulannya
    jatuh di seperempat ketukan **lagu itu**, bukan pada 120 BPM. Geser tempo
    fader → jarak pantulan ikut berubah.
13. Colok headphone, pilih perangkatnya di pemilih `CUE`, tekan `CUE` di kanal
    B → deck B terdengar di headphone **tanpa masuk ke master**. Tanpa memilih
    perangkat, pemilihnya berkata `CUE: TIDAK DIMONITOR` — dan itu jujur, karena
    Web Audio tidak bisa membelah `ctx.destination`.
14. Refresh → lagu, cue, tempo, dan posisi mixer kembali; **tidak ada yang
    berbunyi sendiri**.
15. Buka `/studio`, tunggu autosave (>600 ms), kembali ke `/dj` → lagunya masih
    ada. Ini regresi jebakan `pruneAssets`.

**Yang harus tetap terlihat jujur di layar:** tombol `MT` mati dengan alasannya,
sel `KEY` berisi `—`, dan tombol `SYNC` berlabel yang mengatakan bahwa yang
disamakan baru tempo, bukan fase.
