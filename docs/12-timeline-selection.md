# 12 — Seleksi banyak clip & tinggi lane

Semuanya sisi TypeScript. Tidak ada crate, dependency, atau build WASM baru.

---

## Tinggi lane

`LANE_HEIGHTS = { S: 64, M: 96, L: 144 }`, default **M**. 64 px — nilai lama —
terlalu pendek untuk mengedit: waveform di dalamnya hanya ±40 px, transien tidak
terbaca, dan sasaran klik clip pendek jadi sempit. S tetap ada karena project
dengan banyak lane butuh melihat semuanya sekaligus.

Diatur dari toolbar timeline (di samping zoom — keduanya menjawab "seberapa
besar materinya di layar", hanya beda sumbu) dan ikut disimpan
(`StudioAppState.laneHeight`, field opsional di `PersistedProject`).

---

## Seleksi banyak clip

### Dua field, bukan satu

```ts
selectedClipIds: readonly string[]   // himpunan
selectedClipId: string | null        // PRIMER — yang ditampilkan Clip Detail
```

Keduanya menjawab pertanyaan berbeda. Aksi massal (geser, hapus, salin) butuh
himpunannya; editor di Clip Detail — beat, loop, stem, fade — hanya masuk akal
untuk SATU clip. Menyatukannya berarti salah satu harus menebak, dan tebakan itu
yang akan salah.

**Invariannya ditegakkan di `withDerived`, bukan di tiap aksi:**

1. id yang clip-nya sudah hilang dibuang;
2. primer selalu anggota himpunan (kalau himpunan tidak kosong);
3. himpunan kosong + primer ada → himpunan diisi primer.

Aturan ketiga yang membuat project LAMA (yang hanya menyimpan `selectedClipId`)
langsung punya seleksi sah **tanpa migrasi**.

`setSelectedClips` mengembalikan array LAMA kalau isinya sama — kotak seleksi
memanggilnya puluhan kali per detik, dan array baru tiap kali berarti seluruh
timeline digambar ulang tanpa ada yang berubah.

### Kotak seleksi (marquee)

Drag di area kosong = pilih. Kotaknya dihitung dalam koordinat **TRACK**, bukan
layar: track punya lebar penuh timeline (bisa jauh melebihi viewport) dan ikut
tergeser saat scroll. Menghitung dari koordinat layar membuat kotak melenceng
begitu user menggulir di tengah drag — dan itu terjadi setiap kali seleksi
ditarik sampai ke tepi.

Clip terpilih kalau **bersinggungan** dengan kotak, bukan termuat seluruhnya:
clip bisa jauh lebih lebar dari layar, dan menuntut kotaknya melingkupi seluruh
clip berarti clip panjang tidak akan pernah bisa dipilih dengan cara ini.

Shift/Ctrl/Cmd saat memulai = tambahkan ke seleksi yang ada.

### Menggeser rombongan

`moveClips(origins, deltaSamples, deltaLanes)`:

- `origins` = posisi saat drag **dimulai**, bukan posisi sekarang. Menggeser
  relatif terhadap posisi sekarang menumpuk galat pembulatan di setiap
  `pointermove`, dan setelah beberapa detik menyeret, jarak antar clip yang
  seharusnya tetap sudah tidak sama lagi.
- Selisihnya di-**clamp sekali untuk seluruh rombongan**, bukan per clip. Kalau
  tiap clip dibatasi sendiri-sendiri, clip yang menabrak batas kiri berhenti
  sementara yang lain terus jalan — susunan yang sedang dipindahkan berubah
  bentuk di tangan user.

Menyeret clip yang **sudah** terpilih membawa seluruh seleksi; menyeret clip di
luar seleksi menggantinya lebih dulu. Shift/Ctrl-klik pada clip hanya
menambah/membuang dan **tidak** memulai geser — menyeret sambil menahan Ctrl
hampir selalu tidak disengaja, dan kalau ia ikut memindah clip, satu klik salah
bisa menggeser materi tanpa disadari.

### Salin & tempel

Papan salin menyimpan **selisih** terhadap clip paling kiri (`startOffset`,
`laneOffset`), bukan posisi absolut. Menyalin empat clip dari dua lane lalu
mem-paste-nya di tempat lain tetap menghasilkan susunan yang sama persis. Lane
di luar jangkauan **dijepit**, bukan dilewati: menyalin dua lane ke lane
terakhir lebih baik daripada diam-diam kehilangan separuh materi.

---

## Spasi: ditahan = pan, diketuk = play

Dua fitur memperebutkan tombol yang sama, dan keduanya benar. Spasi sudah lama
berarti play/pause; sejak drag di area kosong berarti kotak seleksi, pan butuh
modifier, dan spasi adalah modifier yang sudah dihafal tangan (Figma, Photoshop,
Premiere).

`shortcuts/space-pan.ts` memisahkannya berdasarkan **apa yang terjadi selama
tombol ditahan**:

```
tekan spasi → tahan → drag  = PAN, dan play TIDAK di-toggle saat dilepas
tekan spasi → lepas         = PLAY (di keyup, bukan keydown)
```

Harga yang dibayar: play menyala saat spasi **dilepas**. Untuk ketukan biasa
selisihnya beberapa puluh milidetik dan tidak terasa; sebagai gantinya kedua
fitur hidup berdampingan tanpa mode dan tanpa tombol tambahan. `blur` jendela
membatalkan keadaan tahan — tanpa itu, Alt-Tab saat spasi ditahan membuat keyup
tidak pernah sampai dan drag berikutnya jadi pan, bukan seleksi.

Tombol tengah tetikus juga pan, tanpa spasi.

---

## Nilai yang dibaca saat pointer turun, bukan dari closure render

`isSpaceHeld()` dan `selectedClipIds` dibaca **langsung dari sumbernya** di dalam
handler pointer, bukan dari nilai hasil render. Nilai render bisa satu frame
basi, dan satu frame di sini berarti gerakan pertama setelah menekan spasi jadi
kotak seleksi alih-alih geser — atau menyeret rombongan hanya membawa satu clip.
Pernah salah; `marquee.test.tsx` yang menangkapnya.

---

## Clip Detail tidak boleh mengempis

Panel ini SELALU terpasang, dan setelah pernah ada seleksi ia **tetap
menampilkan clip terakhir** — ditandai `TIDAK TERPILIH`.

Alasannya tata letak, bukan kenyamanan. Panel boleh diletakkan di ATAS timeline
(`panelOrder` bisa diurutkan user). Kalau isinya mengempis tiap kali seleksi
kosong, timeline di bawahnya melompat — dan itu terjadi puluhan kali saat
menarik kotak seleksi, persis ketika posisi timeline harus diam karena kotak
yang sedang ditarik diukur terhadapnya. Panel yang bergerak sendiri membuat klik
berikutnya mendarat di tempat berbeda dari yang dilihat mata.

Perilakunya sama dengan Clip View di Ableton: yang terakhir dibuka tetap
terbuka. Yang penting keadaannya DIKATAKAN — mengedit clip yang tidak tersorot
di timeline harus terlihat jelas, bukan ketahuan belakangan.

Clip yang dihapus tidak dipajang sebagai hantu: id-nya di-resolve ulang dari
`lanes` setiap render, bukan disimpan sebagai objek. Dan kalau clip itu memang
hilang, panel **jatuh ke clip lain** (`fallbackClip`) — yang di bawah playhead
lebih dulu, kalau tidak ada yang paling awal — bukan mengempis. Kalau ia
mengempis, tingginya berubah tepat setelah menekan X dan timeline di bawahnya
melompat: masalah yang sama, pemicu yang berbeda. Panel baru benar-benar kosong
kalau project tidak punya clip sama sekali, dan di keadaan itu timeline juga
kosong sehingga tidak ada yang bisa melompat.

---

## `scroll = zoom` berlaku di SELURUH kartu timeline

Aturannya satu kalimat yang bisa dipegang: **kursor di timeline → gulir berarti
zoom, halaman tidak ikut bergerak.** Listener `wheel` menempel di `[data-tl-card]`
— pembungkus seluruh kartu, termasuk toolbar dan baris MIN/MAX.

Dua versi sebelumnya salah karena membelah kartu ini jadi zona-zona. Mula-mula
hanya area clip yang menggulir; lalu badan timeline tanpa toolbar. Keduanya
membuat "scroll = zoom" bekerja atau tidak tergantung beberapa piksel posisi
kursor — dan batas zonanya tidak terlihat sama sekali di layar. Fitur yang benar
separuh waktu lebih membingungkan daripada fitur yang tidak ada.

Halaman tetap bisa digulir dengan kursor di panel lain (Clip Detail, rail) atau
di luar kartu.

Listener dipasang manual (bukan `onWheel` React) karena React memasang listener
wheel sebagai passive, sehingga `preventDefault()` diabaikan dan halaman tetap
ikut bergerak. Jangkar zoom dijepit ke tepi area gulir, jadi menggulir di atas
kolom nama lane tidak melompat ke posisi negatif.

---

## Peta berkas

| Berkas | Isi |
|---|---|
| `web/src/studio/shortcuts/space-pan.ts` | pemisah spasi tahan vs ketuk |
| `web/src/studio/timeline/ClipArea.tsx` | kotak seleksi, pan, geser rombongan |
| `web/src/studio/multi-select.test.ts` | himpunan, invarian, aksi massal |
| `web/src/studio/timeline/marquee.test.tsx` | jalur pointer + pemetaan koordinat |
| `web/src/studio/timeline/wheel-zoom.test.tsx` | di mana gulir dianggap zoom |
