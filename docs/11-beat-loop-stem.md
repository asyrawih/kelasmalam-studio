# 11 — Beat loop cut & pembuangan stem

Dua fitur di panel **Clip Detail**, keduanya murni sisi TypeScript. Tidak ada
crate baru, tidak ada dependency baru, dan tidak ada build WASM ulang.

---

## A. Beat grid & loop cut

### Dari mana grid-nya

`crates/analysis` sudah lama mengembalikan `beat_offset_sec` (fase ketukan) di
samping BPM, dan nilainya sudah sampai ke `StudioAsset.tempo.beatOffsetSec` —
lalu berhenti di sana. docs/10 menyebutnya sendiri "bahan untuk snap-to-beat".
Fitur ini yang memakainya. Rust tidak disentuh.

### Grid milik ASSET, hidup di SOURCE-space

Ketukan adalah sifat materi rekamannya, bukan sifat clip. Dua clip dari lagu
yang sama punya grid yang sama. Karena itu semua posisi di `analysis/beat-grid.ts`
diukur di source-space; konversi ke timeline hanya terjadi di titik pemotongan,
dengan `lane.speedRatio` (aturan dua-koordinat, docs/07 §8d).

### Nomor bar-nya arbiter

Yang dideteksi mesin adalah fase KETUKAN, bukan fase birama — tidak ada cara
otomatis untuk tahu ketukan mana yang "satu". Bar 1 karena itu didefinisikan
sebagai bar yang mulai di ketukan pertama, dan offset bisa digeser user sejauh
**satu bar penuh** (bukan satu ketukan): menaruh downbeat di tempat yang benar
memang butuh sebanyak itu.

### Koreksi manual

`StudioAsset.bpmOverride` dan `beatOffsetOverride`. Keduanya OVERRIDE, bukan
pengganti: hasil deteksi tetap tersimpan sehingga tombol AUTO benar-benar bisa
mengembalikan keadaan semula, dan mengisi salah satunya tidak membuang yang lain.
Hanya asset yang benar-benar dikoreksi yang ikut disimpan
(`PersistedProject.assetGrids`, field opsional — `SCHEMA_VERSION` tidak naik,
project lama tetap terbuka).

Perhatikan: tempo hasil deteksi memang **tidak** dipersist (docs/10) dan
dianalisis ulang tiap boot. Yang tidak bisa dibangun ulang adalah keputusan user,
dan hanya itu yang disimpan.

### Audisi loop (LOOP PLAY) — PEMUTAR KEDUA

`StudioAppState.clipLoop` — satu region di dalam satu clip, diputar berulang di
**pemutarnya sendiri, berdampingan dengan timeline**. State sesi, tidak
dipersist. Disimpan di SOURCE-space; batas timeline-nya diturunkan lewat
`clipLoopRange()` setiap kali dipakai, supaya menggeser clip atau mengubah
`speedRatio` tidak membuat loop menunjuk materi yang berbeda dari yang disorot.

**Versi pertama fitur ini salah dan sudah diperbaiki.** Ia membajak transport:
LOOP PLAY memindahkan playhead, menyalakan `playing`, dan membuat
`buildProjectGraph` hanya merakit satu clip. Akibatnya, ingin mendengar dua bar
dari clip 1 menghentikan lagu di lane 2 dan menyeret playhead timeline masuk ke
dalam loop. Bentuk yang benar adalah **dua pemutar**:

| | Mix utama | Pemutar audisi |
|---|---|---|
| dinyalakan oleh | transport (play/stop) | tombol LOOP PLAY |
| isinya | semua lane, MINUS clip yang diaudisi | satu region, mengulang |
| posisinya | `previewPositionSec()` (timeline) | `auditionPositionSourceSec()` (source) |
| sidik jarinya | `mixFingerprint` | `auditionFingerprint` |

Keduanya menyambung ke rantai master yang **sama** (`ensureMaster`), supaya
AMPLIFY dan meter berlaku untuk keduanya. Karena itu `stop()` tidak lagi
membongkar master — kalau ia membongkarnya, menekan STOP di timeline akan
membisukan loop yang justru sedang didengarkan. Pembongkaran total ada di
`teardown()`.

Empat keputusan yang saling bergantung:

1. **`startClipLoop`/`stopClipLoop` tidak menyentuh `playhead` maupun
   `playing`.** Audisi tidak meninggalkan jejak apa pun di transport.
2. **`tick()` tidak mengenal loop.** Playhead timeline terus maju lurus.
3. **Clip yang diaudisi dilewati di mix utama** lewat
   `GraphBuildOptions.skipClipId` — kalau tidak, ia terdengar dua kali dari dua
   posisi berbeda. Lewat opsi dan bukan dibaca dari state, supaya `run-export`
   tidak mungkin kehilangan satu clip karena user lupa mematikan audisi.
4. **Pengulangan diserahkan ke Web Audio** (`AudioBufferSourceNode.loop` +
   `loopStart`/`loopEnd`). Sambungannya akurat per-sample; menjadwalkan ulang
   tiap putaran terdengar sebagai klik di setiap sambungan. Konsekuensinya, jam
   audio terus maju lurus dan pembungkusannya dilakukan di
   `auditionPositionSourceSec()` dengan batas yang sama persis.

Di pemutar audisi: rantainya sama dengan clip biasa (stem → gain → EQ lane →
fader lane, semua bisa diubah live lewat `updateLaneParams`), kecuali dua hal —
mute/solo **dilewati** (LOOP PLAY perintah eksplisit atas satu clip; tombol yang
diam karena lane kebetulan di-mute lebih membingungkan daripada tombol yang
sementara mengabaikan setelan mix) dan fade **tidak** diterapkan (kurvanya hanya
berbunyi di putaran pertama, jadi putaran berikutnya terdengar berbeda tanpa
sebab yang terlihat).

Kotak waveform Clip Detail mengikuti **pemutar audisi** saat audisi berjalan —
bukan playhead timeline, yang sedang berjalan di tempat lain dan tidak ada
hubungannya. Urutan sumber pusat jendela ada di `centerOf()`: tarikan tangan →
audisi → playhead.

### Jendela geser (gaya Rekordbox)

Baris **VIEW** di Clip Detail: `FULL / 1 / 2 / 4 / 8` bar.

- `FULL` — waveform diam, playhead yang berjalan (perilaku lama).
- angka — jendela sekian BAR, **playhead diam di tengah dan waveform yang
  bergeser**. Materi tanpa BPM jatuh ke `FALLBACK_WINDOW_SEC` (8 detik).

Menekan PLAY saat tampilan masih FULL memindahkannya ke 4 bar. Itu satu-satunya
keajaiban di sini dan disengaja: yang dicari orang saat menekan play adalah
waveform yang bergerak. Perubahannya terlihat (tombol zoom ikut menyala), bisa
dibatalkan satu klik ke FULL, dan hanya transisi berhenti→main yang memicunya —
bukan keadaan "sedang main" — sehingga ia tidak akan memaksa lagi setelah user
memilih FULL. Saat transport berhenti, jendelanya **tetap di posisi terakhir**;
pause tidak mengubah apa yang sedang dilihat.

Tiga hal yang membuatnya benar:

1. **Posisinya dari JAM AUDIO** (`previewPositionSec()` → `ctx.currentTime`),
   bukan dari playhead di store. Playhead store maju 16×/detik dari
   `setInterval`; menggeser seluruh gambar dengan angka itu menghasilkan gerakan
   tersendat yang juga tidak pernah persis di posisi yang terdengar. Saat audisi
   loop, jam audio terus maju lurus (yang mengulang adalah voice-nya), jadi
   pembungkusannya dilakukan di `previewPositionSec` dengan batas yang sama
   dengan `loopStart`/`loopEnd`.
2. **Satu canvas, bukan dua.** Waveform, grid, dan playhead digambar bersama
   tiap frame — isinya memang semua bergeser. Ini kebalikan dari tampilan FULL,
   di mana waveform diam dan pantas dipisah dari overlay yang bergerak.
3. **Loop rAF hanya bergantung pada `playing`.** Kalau `playhead` ikut masuk
   daftar dependensi efeknya, loop-nya dibongkar-pasang 16×/detik dan gerakan
   yang seharusnya mulus justru tersendat — gejala yang mustahil ditebak dari
   kodenya. Ada di komentar `ScrollingWave.tsx` karena pernah salah.

Grid digambar oleh `beat-draw.ts` yang dipakai BERSAMA oleh kedua tampilan; dua
salinan berarti grid bisa berpindah tempat hanya karena user menekan zoom.

### Menarik waveform untuk menaruh loop

Di jendela geser, waveform-nya sendiri bisa ditarik (kursor `grab`). Satu
tarikan mengerjakan dua hal yang SENGAJA berbeda:

- **playhead mengikuti tangan secara mulus** — kalau ia ikut menempel ke bar,
  gambarnya tersentak per bar dan tarikan berhenti terasa seperti menarik apa
  pun;
- **awal region menempel ke bar** (Shift = ke ketukan) — loop yang mulai di
  tengah ketukan tidak ada gunanya.

Jadi yang bergerak halus dan yang menempel adalah dua benda berbeda di layar,
dan keduanya terlihat. Saat dilepas, playhead dipindahkan ke awal region supaya
yang terdengar berikutnya persis loop yang barusan disusun.

Arah: menarik ke kanan membawa materi ke kanan, artinya MUNDUR dalam waktu —
seperti menggeser kertas di bawah jarum, kebalikan dari "menggeser playhead".

Menarik waveform **tidak menyentuh playhead timeline sama sekali** — Clip Detail
punya posisinya sendiri (`dragCenter`), dan menyetel loop di satu clip tidak
boleh menggeser tempat lagu di lane lain sedang berbunyi.

Perpindahan region baru dikirim ke pemutar audisi saat jari **dilepas**
(`BeatState.setRegionDragging`). Sorotan di layar tetap mengikuti tangan; yang
ditahan hanya audionya. Tanpa itu, tiap `pointermove` membangun ulang voice
audisi dan yang terdengar hanya deretan klik.

Saat dilepas: kalau audisi berjalan, jendela kembali MENGIKUTI-nya (loop sudah
dijadwalkan ulang di region baru); kalau tidak, tampilan tinggal di tempat —
itulah gunanya menarik, menentukan posisi lalu memeriksanya.

Region digambar walau belum berbunyi — lebih redup — karena seluruh guna
menarik waveform adalah melihat di mana loop akan jatuh SEBELUM LOOP PLAY
ditekan.

### Panjang loop pecahan

`LOOP_BAR_PRESETS = [1/8, 1/4, 1/2, 1, 2, 4, 8, 16]` bar. Di bawah satu bar-lah
pekerjaan yang menarik terjadi: 1/4 bar = satu ketukan (roll), 1/8 bar = not
seperdelapan (stutter). `setBars` **tidak** membulatkan ke bilangan bulat —
pembulatan itu yang dulu meruntuhkan semua pecahan jadi 1 bar.

**Langkah tempel mengikuti panjang loop**, dibatasi maksimal satu bar
(`snapStepBeats`). Loop 1/4 bar boleh mendarat di ketukan mana pun; loop 4 bar
tetap mendarat di awal bar. Kalau langkahnya selalu sebar penuh, loop 1/4 bar
tidak akan pernah bisa ditaruh di ketukan 2, 3, atau 4 — yang justru seluruh
gunanya loop sependek itu. Shift memberi langkah lebih halus: satu ketukan, atau
panjang loop kalau ia sudah lebih pendek dari itu. Untuk itulah
`snapSourceToGrid(at, grid, sr, stepBeats)` ada; `snapSourceToBeat` sekarang
hanya pembungkusnya.

Tombol ◀ ▶ menggeser **sepanjang region itu sendiri**, bukan sebar penuh — untuk
loop 1/4 bar, melompat satu bar berarti melewati tiga posisi yang justru ingin
dicoba.

Baris kontrolnya dipecah dua sejak presetnya jadi delapan: **LOOP** (mendengarkan
— preset, ◀ ▶, LOOP PLAY) dan **CUT** (mengubah clip — ULANG, LOOP CUT, SNAP
SPLIT). Sebelumnya LOOP CUT terdorong ke ujung baris yang sama dengan tombol
yang cuma memutar, padahal ia merusak.

### Pengulangan = clip terpisah

`applyLoopCut` (`timeline/beat-cut.ts`) mengembalikan N clip, bukan satu clip
dengan `loopCount`. Renderer, export, drag, copy, dan delete semuanya sudah
bekerja untuk clip; field baru berarti kelima jalur itu harus diajari
mengenalinya. Efek sampingnya justru diinginkan: tiap pengulangan bisa diedit
sendiri. Fade dibawa hanya ke potongan pertama — kalau tiap pengulangan ikut
membawa fade-out, tiap sambungan loop akan melubang.

`Clip.loop_count` di `crates/timeline-core` baru relevan kalau engine Rust sudah
jadi jalur hidup, dan saat itu ia bisa diturunkan dari deretan ini.

---

## B. Remove vocal / bass / instrument

### Yang ini BUKAN

Bukan stem separation ML. Repo ini tidak punya backend, tidak punya
onnxruntime/tfjs, dan tidak punya FFT sama sekali. Demucs/open-unmix akan
menuntut dependency baru ~5 MB, bobot model 20–80 MB, STFT baru, dan render
offline bermenit-menit.

### Yang ini

Mid/side + crossover komplementer:

```
M = (L+R)/2                 S = (L-R)/2
bass  = LP(M, bassSplitHz)
vocal = LP(M - bass, voiceTopHz)
other = (M - bass - vocal) + S
```

Tiap `StemMix.{vocal,bass,other}` adalah **berapa banyak bagian itu disisakan**
(0..1). Frekuensi pisahnya bisa digeser (`bassSplitHz`, `voiceTopHz`).

### Kenapa pengurangan, bukan filter kedua

Pita atas dibuat dengan `M − LP(M)` (GainNode −1 yang dijumlahkan), bukan dengan
high-pass. Dengan begitu `low + voice + high ≡ M` berlaku PERSIS untuk biquad apa
pun pada frekuensi apa pun — bukan "kira-kira" seperti sepasang LP/HP yang
fasanya tidak pernah benar-benar saling melengkapi. Konsekuensinya: dengan semua
bagian disisakan penuh, rantai ini transparan secara aritmetika. Bypass yang
terbukti, bukan bypass yang diklaim. `preview/stem-chain.test.ts` menghitung
grafnya dan memeriksa identitas itu.

Karena bypass transparan, `graph-builder` boleh MELEWATI rantainya sama sekali
saat `isStemBypass(clip.stem)` — clip biasa tidak membayar dua puluh node
Web Audio untuk hasil yang identik dengan tidak memproses apa pun.

### Masukan di-upmix ke stereo 'speakers'

Materi mono yang masuk langsung ke `ChannelSplitter` terbaca sebagai
L = sinyal, R = SENYAP (splitter memakai interpretasi `discrete`), sehingga `S`
bukan nol pada materi yang jelas tidak punya sisi — hasilnya "buang vokal" pada
file mono menghasilkan stereo aneh. Satu GainNode ber-`channelInterpretation:
'speakers'` di depan memperbaikinya: mono jadi L = R, `S = 0`.

### Batas yang ditampilkan di UI

- Clip **mono**: tidak ada kanal sisi. Peringatan ditampilkan di panel, dan
  tombolnya tetap bisa ditekan — user berhak mencoba.
- Vokal ber-reverb lebar, backing vocal, dan snare yang di-center akan ikut
  terbawa. Dinyatakan apa adanya di panel.

### Live vs bypass

Gain dan frekuensi stem diubah **live** lewat `setTargetAtTime` di
`updateLaneParams`, sama seperti EQ lane. Yang masuk `mixFingerprint` hanya satu
BIT per clip (bypass atau tidak) — memasukkan nilainya akan me-restart audio tiap
slider bergerak satu piksel.

### BAKE

`timeline/stem-bake.ts` merender region clip lewat `buildStemChain` yang SAMA di
`OfflineAudioContext`, mendaftarkannya sebagai asset baru, memindahkan beat
grid-nya (digeser sesuai potongan), dan menetralkan setelan stem clip supaya
pemisahannya tidak diterapkan dua kali.

Byte-nya ditulis sebagai WAV IEEE-float 32-bit oleh helper lokal, **bukan** lewat
`encoders/wav.ts`. Encoder itu adalah encoder export (bit depth, dither) dan
berjalan di atas Rust sehingga menuntut modul WASM sudah termuat; menggantungkan
tombol BAKE padanya berarti ia gagal justru saat build WASM belum ada.

---

## Blok yang bisa dilipat

Clip Detail tumbuh sampai empat blok (BEAT & LOOP, REMOVE, FADE, plus baris
aksi) dan tinggi penuhnya menutupi timeline — tempat pekerjaan sebenarnya
terjadi. `DetailSection.tsx` melipatnya.

Default: **BEAT & LOOP terbuka, REMOVE dan FADE terlipat**. Pilihannya ikut
disimpan (`StudioAppState.clipDetailSections`, field opsional di
`PersistedProject`, tanpa menaikkan `SCHEMA_VERSION`) — seperti `panelOrder` dan
`eqMode`. Melipat blok adalah keputusan tata letak yang dibuat sekali, dan
memaksanya diulang tiap refresh mengembalikan persis kepadatan yang ingin
dihindari. Berbeda dari `maximizedPanel`, yang sengaja TIDAK disimpan karena ia
menyembunyikan segalanya.

**Aturan yang membuatnya bukan sekadar "sembunyikan": blok terlipat WAJIB
menampilkan ringkasan keadaannya di kepala.** Fade yang aktif dan stem yang
dibuang sama-sama MENGUBAH SUARA; kontrol yang hilang tanpa jejak membuat user
tidak bisa tahu kenapa clip-nya terdengar begitu. Ringkasannya kecil, tapi ia
yang membedakan "dilipat" dari "disembunyikan" — dan itu yang dikunci
`collapse-ui.test.tsx`. Saat blok terbuka, ringkasannya TIDAK diulang: isinya
sudah di layar.

## Peta berkas

| Berkas | Isi |
|---|---|
| `web/src/studio/analysis/beat-grid.ts` | matematika grid (murni) |
| `web/src/studio/timeline/beat-cut.ts` | `applyLoopCut` (murni) |
| `web/src/studio/timeline/BeatSection.tsx` | overlay grid, region loop, kontrol VIEW/LOOP |
| `web/src/studio/timeline/beat-draw.ts` | penggambar grid + playhead (dipakai dua tampilan) |
| `web/src/studio/timeline/ScrollingWave.tsx` | jendela geser rAF, playhead di tengah |
| `web/src/studio/timeline/DetailSection.tsx` | blok yang bisa dilipat + ringkasannya |
| `web/src/studio/timeline/stem.ts` | normalisasi & pembacaan `StudioClip.stem` |
| `web/src/studio/preview/stem-chain.ts` | rantai mid/side di Web Audio |
| `web/src/studio/timeline/stem-bake.ts` | render offline → asset baru |
| `web/src/studio/timeline/StemSection.tsx` | tombol REMOVE, slider halus, BAKE |

## Belum dikerjakan

- Stem separation ML. `StemMix` + `stem-bake.ts` sengaja berbentuk *backend yang
  bisa ditukar*, jadi menambahkannya tidak perlu membongkar UI.
- Slicer penuh (iris seluruh clip jadi potongan per-beat). Semua matematikanya
  sudah ada di `beat-grid.ts` + `beat-cut.ts`.
- Birama selain 4/4 (`BeatGrid.beatsPerBar` sudah jadi field, nilainya masih tetap 4).
