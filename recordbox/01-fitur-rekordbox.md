# 01 — Fitur rekordbox yang kita tiru, dan yang tidak

Riset mentahnya (bahasa Inggris, dengan daftar sumber) ada di
[`01a-riset-mentah.md`](01a-riset-mentah.md). Berkas ini hanya berisi yang
**mengikat keputusan**: fakta yang dipakai, angka yang ditiru, dan hal yang
sengaja ditinggalkan beserta alasannya.

Matriks BANGUN / MATI / TIDAK per fitur ada di
[`00-plan.md`](00-plan.md#matriks-fitur-rekordbox). Yang di sini adalah
**alasan di balik angkanya**.

---

## Angka yang ditiru apa adanya

Ini bukan selera. Tiap baris punya sumber di manual perangkat yang ditiru
rekordbox sendiri, dan menyimpang darinya berarti alat ini terasa salah di
tangan orang yang sudah terbiasa.

| Besaran | Nilai | Dari mana |
|---|---|---|
| Rentang EQ per band | **−26 dB … +6 dB** | DJM-900NXS2, "Adjusting the sound quality". HI shelf @30 kHz, MID peaking @1 kHz, LOW shelf @20 Hz |
| Rentang tempo fader | ±6 / ±10 / ±16 / **WIDE = ±100%** | WIDE bukan sekadar "lebih lebar" — di −100% lagu **berhenti** |
| Langkah tempo fader | 0.02% (±6) · 0.04% (±10, ±16) · 0.5% (WIDE) | rekordbox; manual CDJ menyebut 0.05% untuk ±10/±16 — divergensi yang memang ada |
| Pembagian quantize | **1/16 · 1/8 · 1/4 · 1/2 · 1** | rekordbox satu langkah lebih halus dari CDJ (mulai 1/8). Default **1 ketukan** |
| Jumlah hot cue | 8 di pad, **16** tersimpan | pad menampilkan bank A–H |
| Jumlah Sound Color FX | **tepat 9** | manual mode `[USER]`: "select favorite effects from 9 types" |

Reset tempo di rekordbox adalah **klik-ganda pada angka %**, bukan tombol
terpisah. Reset knob EQ juga klik pada knob-nya; **klik pada LABEL** `HIGH` /
`MID` / `LOW` justru mematikan band itu. Dua gerakan berbeda pada dua sasaran
yang berdempetan — dan itu memang yang ditiru.

---

## Knob COLOR: dua arah BUKAN dua arah dari satu besaran

Manual, harfiah: *"If the knob is in the center position, the effect is not
applied. The effect level differs according to the clockwise or
counterclockwise turn of the knob."*

Yang mudah salah dipahami: kiri dan kanan bukan "−50%" dan "+50%" dari efek yang
sama. Keduanya **perilaku yang berbeda**:

| CFX | Putar kiri | Putar kanan |
|---|---|---|
| FILTER | cutoff LPF turun | cutoff HPF naik |
| SPACE | reverb di **mid + low** | reverb di **mid + high** |
| DUB ECHO | echo di **mid saja** | echo di **high saja** |
| SWEEP | notch/gate melebar | bandpass yang menyempit |
| NOISE | cutoff derau turun | cutoff derau naik |
| CRUSH | crush mentah | crush **lewat high-pass** |

`crates/engine/src/fx/filter.rs` sudah mengimplementasikan baris FILTER
persis begitu — dan komentarnya sudah menjelaskan kenapa dua biquad selalu
terpasang seri alih-alih menukar jenis filter di tengah. Delapan CFX lainnya
belum ada; menambahkannya adalah pekerjaan Rust di dalam katalog, **bukan**
pekerjaan UI.

**CFX tidak punya parameter beat sama sekali.** Ia murni efek posisi-knob.
Menaruh pemilih 1/4-beat di sebelahnya adalah kesalahan yang terlihat benar.

---

## Beat FX: rentang beat-nya TIDAK seragam

Ini koreksi penting terhadap dugaan awal. Tiap efek punya rentangnya sendiri,
dan dua di antaranya bahkan tidak memakai ketukan:

| Efek | Parameter BEAT |
|---|---|
| DELAY · ECHO · PING PONG · SPIRAL · ROLL | 1/16 – 16 |
| FILTER · FLANGER · PHASER | 1/16 – **64** |
| **REVERB** | **tidak ada** — 1–100 % |
| **PITCH** | **tidak ada** — −50 … +100 % |

Konsekuensinya untuk kita: pemilih pembagian beat **harus datang dari
`pflag::BEAT_SYNC` milik tiap efek di katalog Rust**, bukan dipasang seragam di
panel. Katalog kita sudah membawa bendera itu — `echo` dan `spiral` memilikinya,
`reverb` dan `pitch` tidak — jadi perilakunya sudah benar asalkan panel membaca
benderanya alih-alih mengasumsikan.

Dua perilaku lain yang layak ditiru kalau nanti audio hidup:

- `ROLL` / `SLIP ROLL` / `HELIX` **merekam masukan saat tombol ON ditekan**.
- `DELAY` / `ECHO` / `PING PONG` / `SPIRAL` / `REVERB` **post-fader** — menurunkan
  channel fader sampai nol menyisakan ekor delay-nya. Itu bukan bug, itu yang
  dipakai untuk transisi.

Enam efek yang sudah ada di repo — ECHO, SPIRAL, FLANGER, REVERB, PITCH,
FILTER — **semuanya nama Beat FX rekordbox yang sungguhan**, bukan padanan.
Daftar penuh rekordbox berisi ~23 efek; manual resminya sendiri tidak pernah
mencetak daftarnya.

---

## Warna waveform: dua skema, dan low-nya terbalik

| Skema | Low | Mid | High |
|---|---|---|---|
| **RGB** | **merah** | hijau | biru |
| **3Band** | **biru** | amber | putih |

Perhatikan inversinya: low adalah **merah** di RGB tapi **biru** di 3Band.
Pemetaan RGB itu tegak dari pembalikan (Deep Symmetry / Beat Link), bukan dari
pernyataan AlphaTheta. Di tampilan detail 3Band ketiga pita berbagi satu sumbu,
sehingga tumpang-tindih low∩mid tampil **cokelat**, dan high putih digambar
terakhir sehingga menutupi yang di bawahnya.

Setelannya **global tunggal** (`[View]` → `[Color]` → `[Waveform color]`) dan
berlaku untuk waveform besar maupun penuh — bukan per-deck.

**Sudah dibangun** (skema 3Band saja, tanpa saklar RGB). `envelope.ts` kini
menyimpan `low`/`mid`/`high` = |puncak| per bucket di samping min/max/rms, dan
`waveform.ts` menggambarnya low → mid → high sehingga putih tetap yang terakhir
menutupi — urutan yang sama dengan rekordbox, dan alasannya sama: yang paling
pendek harus digambar paling akhir atau ia tidak pernah terlihat.

Yang berbeda dari catatan riset di atas, dan itu disengaja:

- **Amber tema ini yang jadi pita tengah**, bukan oranye rekordbox. Pita tengah
  mendominasi layar, jadi warnanya adalah warna halaman.
- **Tidak ada `[Waveform color]` global.** Satu skema, satu tempat
  (`BAND_COLORS` di `waveform.ts`). Saklar dua skema hanya berguna kalau ada
  user yang sudah terbiasa dengan RGB; di sini belum ada satu pun.

Ongkosnya, terukur (bukan taksiran): pyramid untuk 3 menit stereo @48k naik dari
~49 ms ke **76 ms** dan dari 1,85 MB ke **3,70 MB** (0,428 B per frame). Filternya
enam kutub per sample, berjalan di pass yang SUDAH melewati PCM — tidak ada
lintasan baru, meski catatan di atas menduga akan ada tiga.

---

## Deteksi & grid

- **Tiga mode analisis**, bukan dua: `[Normal]`, `[Dynamic]`, `[Auto]` — dan
  `[Auto]` hanya tersedia kalau `[Use high precision BeatGrid analysis]` menyala
  (toggle terpisah). `[BPM Range]` hanya berlaku untuk `[Normal]`.
- **Panel `[GRID EDIT]`** punya set kontrol yang layak ditiru langsung: geser
  playhead ke ketukan-pertama-bar, ketik BPM, `[TAP]`, geser ±1 ms, rapatkan/
  renggangkan ±1 ms (3 ms dengan `[fine]`), ×2 / ÷2 BPM, cakupan seluruh-lagu vs
  dari-sini, metronom tiga tingkat volume, undo/redo.
- Dua batasan yang **wajib** ikut ditiru karena keduanya adalah janji ke user:
  **analisis ulang menimpa koreksi grid manual**, dan **menjalankan ulang
  analisis frase menghapus suntingan frase**. Kalau kita menyimpan koreksi user
  di tempat yang bisa tertimpa diam-diam, itu bug — bukan kesetiaan.
- **Analisis frase berbasis MOOD, bukan genre.** rekordbox mengklasifikasi
  otomatis tiap lagu ke **HIGH / MID / LOW** dari tempo, ritme, kick, dan
  kerapatan bunyi; mood-nya yang menentukan label apa saja yang tersedia. Set
  **HIGH** bernomor — Intro 1/2, Up 1/2/3, Down, Chorus 1/2, Outro 1/2 — dan
  **tidak punya Verse maupun Bridge sama sekali**. **MID** punya Verse 1–6.
  Tidak ada pemilih genre di mana pun.

---

## Key: kita menyimpang, dan ini alasannya

rekordbox hanya menawarkan dua format: `[Classic]` (Am, F#m) dan
`[Alphanumeric]` — yang alphanumeric itu **Camelot** (8A, 5B). **Open Key tidak
ada di rekordbox.**

Kita tetap memakai **Classic sebagai bentuk utama + Open Key sebagai kode**,
karena "Camelot" dan Camelot Wheel adalah **merek dagang Mixed In Key LLC** dan
pemegangnya menyatakan seluruh produk — termasuk yang gratis — butuh lisensi.
Notasi 8A/8B sudah de facto standar, tapi **namanya** yang dilindungi.

`[Traffic Light]` rekordbox menyorot kunci yang cocok, dan ternyata punya
**empat tingkat**, bukan biner. Untuk lagu 2A yang sedang dimuat:

| Setelan | Yang disorot |
|---|---|
| `Same key` | 2A |
| `Related key 1` | 2A, 2B |
| `Related key 2` | +1A, 3A |
| `Related key 3` (**default** sejak 6.5.2) | +1B, 3B |

Spesifikasi itu lengkap dan murah — begitu `detect_key` ada, penyorotannya
tinggal tabel.

---

## Browser: dua hal yang mengubah desain UI

1. **Pencarian di rekordbox ber-lingkup kolom**, bukan fuzzy semua kolom: klik
   `▼`, pilih kolom, baru ketik. Menyalin "search bar yang mencari semuanya"
   adalah menyalin aplikasi lain.
2. **Alphabet Search dimatikan di mode PERFORMANCE** karena shortcut keyboard
   mengambil alih. Relevan langsung untuk penanganan keyboard kita: begitu
   halaman `/dj` punya shortcut huruf, kotak pencarian tidak boleh diam-diam
   memakan ketukan tombol yang sama.

Operator Intelligent Playlist terdokumentasi penuh dan identik lintas v5/v6/v7:
`=` `≠` `>` `<` `contains` `does not contain` `starts with` `ends with`
`is in the range` `is in the last` `is not in the last`, digabung dengan
match-all atau match-any. Murah, dan kandidat MVP yang lebih baik dari dugaan —
tapi tetap di luar iterasi pertama karena butuh model playlist yang belum ada.

---

## Yang tidak terdokumentasi oleh siapa pun

Ditulis di sini supaya tidak ada yang membuang waktu mencarinya lagi: daftar
lengkap kriteria Related Tracks (teks resminya harfiah berakhir "…etc."), daftar
lengkap kolom browser, format string persis yang ditulis
`[Add My Tag to the Comments]` (dan ia **berbagi field `[Comments]`** dengan
fitur komentar-warna, jadi keduanya bisa bertabrakan), sintaks operator di kotak
pencarian, dan `SCENE FX` — yang muncul di manual v7 sebagai kategori parameter
PAD FX tapi tidak pernah didefinisikan di mana pun.
