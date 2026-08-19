# 05 — Lapisan audio

Sudah dibangun. Dokumen ini menjelaskan **kenapa bentuknya begini**; bentuk
persisnya ada di `web/src/dj/audio/` dan tidak disalin ke sini supaya tidak ada
dua kebenaran.

---

## Keputusan pertama: `AudioBufferSourceNode`, bukan worklet resampler

Worklet ber-kursor-float adalah jawaban yang benar untuk **scratch, reverse, dan
key lock** — dan ketiganya memang ditandai TIDAK/MATI di matriks fitur. Yang
benar-benar dibutuhkan halaman ini adalah varispeed, loop, dan slip, dan
ketiganya sudah ada di node bawaan:

- `playbackRate` memberi varispeed;
- `loop` + `loopStart`/`loopEnd` memberi loop **sample-akurat**, dan ketiganya
  bisa diubah **saat berbunyi** — itu persis yang dibutuhkan ÷2/×2 di tengah lagu;
- slip cukup dengan membayangi posisi di JS, karena yang dibutuhkan saat slip
  berakhir hanyalah satu lompatan.

Harga kalau memakai worklet: PCM harus **disalin** dan ditransfer ke thread
audio — mentransfer `AudioBuffer` yang sudah ada akan men-*detach*-nya dan
merusak cache bersama di `audio-preview.ts`. Untuk lagu stereo lima menit itu
~115 MB duplikat **per deck**. Membayar itu demi fitur yang memang tidak
dibangun adalah harga yang salah.

Konsekuensinya jujur: **scratch, reverse, dan key lock tetap tidak ada**, dan
itu sama dengan yang sudah dijanjikan matriks sejak awal.

### Yang tetap bisa dibunyikan tanpa membayar harga itu: SCRUB

Menarik jog atau waveform sekarang **terdengar**. Bunyinya bukan dari source
utama melainkan dari deretan butir 90 ms yang bertindih (`audio/scrub-voice.ts`),
dan selama tangan menempel source utama justru **diredam**.

Pembagian itu bukan penyederhanaan. `AudioBufferSourceNode` tidak bisa
dipindahkan posisinya setelah `start()`, jadi "mengikuti tangan" dengan satu
source berarti menjadwalkan source baru pada **setiap** `pointermove` — enam
puluh potongan 16 ms per detik, masing-masing dengan tepi keras. Yang terdengar
dari itu bukan lagu yang dicari melainkan dengung 60 Hz. Butir memecahkan
persoalan itu dengan memisahkan laju tangan dari laju bunyi: tangan boleh
melapor sesering apa pun, butirnya tetap paling rapat 45 ms sekali.

Dua batasnya disebut apa adanya:

- **Butir selalu maju.** Menarik mundur membunyikan materi di posisi baru, bukan
  lagunya diputar balik — itu tetap butuh kursor float. Jadi ini menjawab
  "materi apa yang ada di sini", bukan "seperti apa bunyinya kalau diputar
  balik".
- **Tangan yang DIAM tidak berbunyi.** Butir yang tetap dijadwalkan dari posisi
  yang sama adalah satu nada 22 Hz yang stabil, bukan lagu.

Butir masuk lewat **masukan channel strip yang sama** dengan source utama, jadi
TRIM, EQ, COLOR, channel fader, CUE, dan crossfader semuanya berlaku. Ini
berbeda dari scrub Studio, yang sengaja memintas EQ karena di sana rantainya
harus dirakit ulang per butir. Di sini rantainya sudah berdiri permanen, dan
memintasnya justru butuh kerja tambahan untuk hasil yang lebih buruk: DJ mencari
titik cue dengan channel fader **turun** dan CUE menyala, dan scrub yang
memintas fader akan menyemburkan lagu berikutnya ke ruangan.

---

## Posisi datang dari JANGKAR, bukan akumulasi

`DeckPlayer.positionAt(now)` dihitung dari satu jangkar `(ctxTime, sourcePos,
rate)`. Menjumlahkan delta tiap frame akan menghanyutkan posisi terhadap yang
benar-benar terdengar — dan hanyutnya tidak terlihat sampai lagu berjalan lima
menit, yaitu tepat saat DJ paling bergantung padanya.

Setiap perubahan laju memasang jangkar **baru** pada posisi saat itu, jadi
matematikanya tetap potongan-lurus dan tidak pernah perlu integrasi. Dikunci
tes: 3000 langkah kecil selama lima menit harus mendarat di angka yang sama
dengan satu langkah besar.

### Satu bug yang ditemukan tesnya, dan bukan bug kecil

`AudioBufferSourceNode` hanya melipat saat kursornya **mencapai** `loopEnd` dari
arah maju. Menekan **÷2 saat playhead ada di paruh kedua loop** menaruh `outAt`
baru di *belakang* kursor — node berjalan lurus sampai ujung lagu dan tidak
pernah kembali, sementara layar tetap menggambar playhead melipat di dalam loop.
Dua kebenaran yang berbeda tentang hal yang sama, pada gerakan yang justru
paling sering dilakukan.

`setLoop` karena itu melompatkan deck ke dalam loop baru kalau posisinya di luar.

---

## Jalur sinyal

```
 DeckPlayer → ① TRIM → ② EQ hi/mid/low → ③ COLOR (2 biquad) → ④ CHANNEL FADER
                                                                  │
                                      ⑧ CUE BUS ◄─────────────────┤ pre-crossfader
                                                                  ▼
                                                       ⑤ CROSSFADER GAIN
                                                                  ▼
                                            [Beat FX] → ⑥ MASTER → ⑦ destination
```

Dua urutan yang bukan selera:

- **CUE diambil sebelum crossfader.** Seluruh guna monitor headphone adalah
  mendengar lagu yang **belum** masuk mix; mengambilnya setelah crossfader
  membuat CUE ikut senyap justru saat paling dibutuhkan.
- **Channel fader sebelum crossfader.** Kalau dibalik, fader yang mentok di nol
  masih terdengar lewat sisi crossfader-nya.

Semua parameter kontinu lewat `setTargetAtTime` (τ 12 ms), bukan penugasan
langsung: satu tarikan fader menghasilkan puluhan nilai per detik, dan nilai
yang dilompati terdengar sebagai zipper noise.

**COLOR memakai dua biquad permanen**, tidak pernah ditukar jenisnya — alasan
lengkapnya di `crates/engine/src/fx/filter.rs`: state TDF-II yang
direinterpretasi berbunyi klik tiap kali knob melewati tengah, dan pada Q tinggi
resonansinya menyisakan puncak di kedua ujung sapuan.

---

## Arah data, dan kenapa ia tidak bisa berputar

```
  store ──(apply)──► graf Web Audio     dipicu perubahan store
  graf  ──(clock)──► store.playhead     dipicu rAF, ~16×/detik
```

Yang mengalir balik **hanya posisi**, dan posisi ditulis lewat `syncFromClock`
yang tidak menaikkan `seekEpoch`. Lapisan audio menjadwalkan ulang source hanya
saat `seekEpoch` berubah — jadi umpan jam secara struktural tidak bisa memicu
penjadwalan ulang.

Itulah alasan `seekEpoch` sudah ada di model sejak iterasi UI: bukan
persiapan spekulatif, melainkan satu-satunya hal yang memisahkan "playhead maju
sendiri" dari "user melompat". Pola yang sama dipakai `usePreviewPlayback` untuk
memilih `play()` vs `reschedule()`.

Waveform **tidak** ikut jalur itu: `deck-clock.ts` dibaca langsung di dalam loop
rAF penggambar, jadi jendelanya bergeser 60×/detik tanpa satu render React pun.

---

## Audio dibangun dari GESTUR

`AudioContext` yang dibuat di luar handler gestur user lahir `suspended` di
Safari dan Chrome — tanpa gejala apa pun selain "tidak ada suara". Daripada
menyebar `ensureDjAudio()` ke tiap tombol dan pasti melupakan salah satunya,
satu listener `pointerdown` **di akar halaman** menangkap interaksi pertama apa
pun, lalu melepas dirinya sendiri.

Badge header punya tiga keadaan: `AUDIO BELUM BERBUNYI — SENTUH HALAMAN`,
`READY`, atau pesan galat. Tidak ada keadaan keempat yang berarti "mungkin".

Dan `READY` dibaca dari `ctx.state === 'running'` **tiap frame**, bukan
diasumsikan dari keberhasilan pembangunan. `suspended` adalah keadaan paling
menyesatkan di Web Audio: graf terpasang, tiap parameter benar, nol error — dan
nol suara. Browser bisa mengembalikan context ke sana kapan saja (kebijakan
autoplay, tab disembunyikan, perangkat keluaran berganti), dan badge yang tetap
berkata READY saat itu terjadi membuat orang mencari penyebabnya di tempat lain.

Context-nya **dipinjam** dari `studio/preview/audio-preview.ts`, bukan dibuat
sendiri — kalau tidak, setiap lagu harus di-decode dua kali untuk mendapatkan
buffer yang isinya sama persis. Konsekuensinya: halaman DJ tidak pernah
memanggil `teardown()`, karena itu akan mematikan Studio juga.

---

## CUE butuh perangkat kedua, dan itu tidak bisa disembunyikan

Web Audio tidak punya konsep dua tujuan fisik dalam satu context:
`ctx.destination` cuma satu, dan `AudioContext.setSinkId` memindahkan **seluruh**
context, bukan satu cabang. Jalan yang ada:
`MediaStreamAudioDestinationNode` → `<audio>` → `audio.setSinkId(deviceId)`.

Karena itu bus CUE **sengaja tidak tersambung ke `ctx.destination`**. Kalau
tersambung, menyalakan CUE akan menambahkan lagu yang sama ke speaker utama —
kebalikan dari gunanya, dan terdengar seperti kerusakan. Selama user belum
memilih perangkat, tombol CUE tetap bekerja (kirimannya nyata, meternya ikut)
tapi tidak ada yang memonitornya, dan pemilih perangkat di mixer mengatakannya.

Daftar perangkat baru punya nama setelah izin media diberikan. Kita **tidak**
meminta izin mikrofon demi label: entri tanpa nama tetap bisa dipilih, dan
menukar akses mikrofon dengan nama perangkat bukan pertukaran yang pantas
ditawarkan.

---

## Beat FX

Insert, bukan send. `createFxNode` menghasilkan satu node rantai yang alami
dipasang sebagai insert; send butuh percabangan dan bus kembali, yang menuntut
keputusan tentang berapa bus yang ada — celah yang `docs/08 §8e` sendiri belum
tutup. UI mengatakan bahwa LEVEL adalah dry/wet, bukan besarnya kiriman.

Menyisipkan berarti memutus **satu** sambungan dan menaruh node di antaranya.
`disconnect(target)` dengan argumen hanya melepas sambungan itu, jadi cabang ke
analyser dan ke bus CUE tetap utuh — meter dan headphone harus tetap mendengar
kanalnya.

**Efek yang MATI tidak berada di jalur sinyal sama sekali.**

Versi pertamanya menyisipkan node begitu sebuah efek DIPILIH, lalu mengandalkan
bypass di dalam rak untuk meloloskan audio saat OFF. Itu taruhan yang salah
bentuknya: `fx.kind` ikut tersimpan antar sesi, jadi satu efek yang pernah
dipilih terpasang lagi di **setiap boot** — dan kalau worklet-nya gagal
memproses karena alasan apa pun (artefak WASM belum dibangun, `addModule`
gagal, processor melempar), yang terjadi bukan "efeknya tidak terdengar"
melainkan **seluruh mix diam**, tanpa satu pun error di layar.

Sekarang efek yang mati benar-benar dilepas, dan node yang melaporkan `fault`
atau `onprocessorerror` ikut dilepas lalu dilaporkan ke baris status. Harganya
satu penyambungan ulang saat ON/OFF ditekan — dan itu harga yang benar, karena
kegagalannya jadi sebatas "efek tidak jalan" alih-alih "tidak ada suara".

Node dibangun ulang **hanya** kalau jenis atau target berubah; level lewat pesan. Dan `sync()` menjaga sidik jari nilai terakhir, karena ia dipanggil
pada setiap perubahan state — termasuk tiap piksel gerakan crossfader, yang
tidak ada hubungannya dengan FX.

---

## Tinggi mixer dibagi, bukan dijatah

Channel strip menumpuk lima knob di atas fader dan tombol CUE. Versi pertamanya
memberi fader **panjang tetap**, dan begitu tumpukan knob melebihi ruang yang
ada, fader dan CUE terpotong habis oleh `overflow: hidden` di baris grid —
kontrol yang paling sering dipakai hilang tanpa satu pun gejala: tidak ada
error, tidak ada scrollbar, tidak ada apa pun yang menunjukkan ada yang
terpotong.

Sekarang tumpukan knob memakai tinggi alaminya dan **blok fader mengambil
sisanya** (`flex: 1`). Cap fader diposisikan lewat `calc()` persen pada
`top`/`left`, jadi ia benar pada tinggi berapa pun tanpa mengukur apa pun dan
tanpa satu pun listener resize.

> **`top`/`left`, bukan `transform`** — dan ini pernah salah. Persentase di
> dalam `translate()` dihitung terhadap **elemen itu sendiri**, bukan induknya.
> Untuk cap setinggi 16 px, `translateY(calc((100% - 16px) * t))` selalu
> bernilai `(16px − 16px) * t` = **0**: cap-nya membeku di ujung berapa pun
> nilainya, sementara angka di sebelahnya berubah normal. Fadernya terlihat
> "rusak" padahal store, audio, dan pembacaan di layar semuanya benar.
>
> Persentase pada `top`/`left` elemen ber-`position: absolute` dihitung terhadap
> containing block — yaitu induknya. Itu yang dimaksud. Dikunci
> `mixer/fader.test.tsx`. Knob memakai mode `dense` — label dan nilai sebaris —
karena dua baris teks per knob memakan ~55 px yang tidak dimiliki kolom mixer.

Dijaga `dj-layout.test.tsx`: yang diperiksa bukan pikselnya (jsdom tidak
melakukan layout) melainkan ATURAN yang membuat pikselnya benar.

---

## Yang tetap TIDAK ada

| | Kenapa |
|---|---|
| **MASTER TEMPO / key lock** | Butuh time-stretch realtime. `docs/07 §8c` memilih WSOLA sendiri di Rust, tapi rencananya ditulis untuk **pre-render di worker** — dan itu tidak berlaku untuk deck DJ, karena tempo fader digerakkan saat lagunya berbunyi. Tombolnya ada, mati, dengan alasannya di `title` |
| **Scratch / reverse / vinyl** | Scrub yang berbunyi sudah ada, tapi butirnya selalu maju. Memutar **balik** butuh kursor float yang bisa membaca mundur; `AudioBufferSourceNode` tidak bisa, dan browser tidak memutar `playbackRate` negatif |
| **Deteksi KEY** | `crates/analysis` belum punya `detect_key`. Kolomnya `—`, bukan tebakan |
| **SYNC fase / downbeat** | Yang disamakan baru tempo. Label tombolnya berbunyi `SYNC` tapi `title`-nya mengatakan batasnya |
