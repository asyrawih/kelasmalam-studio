# 15 — App shell: routing, command, keyboard

Semuanya sisi TypeScript. Tidak ada crate, dependency, atau build WASM baru.
Kode di `web/src/app-shell/`.

---

## Kenapa

Sebelum ini, routing ada di `Root.tsx` dan keyboard tersebar sebagai listener
`window` di tiap halaman. Keduanya bekerja. Tapi keduanya juga berarti tidak ada
satu pun tempat yang bisa menjawab dua pertanyaan yang akan terus ditanyakan:

1. **"Apa yang bisa dilakukan sekarang?"**
2. **"Tombol ini milik siapa?"**

Pertanyaan pertama muncul begitu ada command palette. Yang kedua muncul begitu
ada dua halaman yang sama-sama memasang listener `window`, dan bentroknya baru
ketahuan saat dua fitur kebetulan dipakai bersamaan.

Yang lebih menentukan: sebuah aksi punya **lebih dari satu pintu masuk**. Hari
ini tombol di layar dan keyboard; berikutnya command palette, MIDI controller,
macro, remote. Kalau tiap pintu memetakan sendiri ke `djActions.*`, jumlah
pemetaan tumbuh **perkalian** — dan tiap pintu baru berarti menulis ulang
seluruh daftar aksi lalu menjaganya tetap sama selamanya.

Shell memutus itu: tiap aksi punya **satu id stabil**, dan pintu mana pun cukup
mengirim id. Pintu baru = satu penerjemah kecil, bukan satu salinan daftar.

---

## Bentuk

```
  AppShell ─┬─ routing            path → route, satu tabel
            ├─ registry command   id → { title, group, defaultChord, run }
            ├─ keymap             chord → id, bawaan ditimpa milik user
            ├─ dispatcher         SATU listener keydown untuk seluruh app
            ├─ command palette    ⌘K — pintu kedua ke registry
            └─ editor pintasan    ?  — ubah binding, bertahan
```

Halaman **mendaftarkan** command-nya selama ia hidup:

```ts
useCommands(djCommands());
```

`dj.deckA.play` tidak punya arti saat user di `/studio`. Command yang hidup
mengikuti halamannya membuat "apa yang bisa dilakukan sekarang" jadi pertanyaan
yang punya jawaban — dan itulah yang membuat palette menampilkan daftar jujur
alih-alih daftar penuh berisi hal yang diam-diam tidak melakukan apa-apa.

---

## Empat keputusan yang menentukan sisanya

### 1. Binding menyimpan POSISI tombol, bukan karakternya

`event.key` adalah karakter yang DIHASILKAN, jadi ia bergeser mengikuti layout
dan modifier: `Shift+1` menghasilkan `!` di QWERTY-US tapi `+` di beberapa
layout Eropa. Binding yang disimpan sebagai karakter berhenti bekerja begitu
user mengganti layout — dan gejalanya "shortcut-nya hilang", tanpa petunjuk.

`event.code` adalah posisi fisik (`KeyQ`, `Digit1`). Untuk alat pertunjukan itu
yang benar: yang dihafal tangan adalah **letak** tombol, bukan huruf yang
tercetak di atasnya.

Harganya: pada layout non-QWERTY, label yang ditampilkan bisa berbeda dari huruf
di tombolnya. Itu sebabnya keymap-nya bisa diubah.

### 2. Keymap disimpan `chord → id`, bukan sebaliknya

Yang ditanyakan dispatcher tiap ketukan adalah "chord ini milik siapa". Bentuk
terbalik berarti menyisir seluruh daftar tiap tombol ditekan.

Lebih penting: bentuk ini membuat **satu chord tidak bisa dimiliki dua command
secara struktural**. Disimpan `id → chord`, bentrokan hanya ketahuan saat
keduanya kebetulan diadu — dan sampai saat itu salah satunya diam-diam kalah.

### 3. `preventDefault` hanya kalau command-nya BENAR-BENAR jalan

Chord tak terikat, atau command yang sedang tidak bisa dijalankan, diteruskan apa
adanya. Menelan tombol yang tidak melakukan apa-apa berarti mematikan perilaku
bawaan browser tanpa memberi gantinya — kerusakan yang paling sulit dilaporkan,
karena yang hilang adalah sesuatu yang user tidak sadar pernah ada.

### 4. Tombol yang SUDAH punya arti tidak dirampas

Tiga lapis pengecualian, dan ketiganya menjawab hal yang berbeda:

- **Sedang mengetik.** Tanpa ini, "q" di kotak pencarian memutar deck A dan
  hurufnya tidak pernah sampai ke kotaknya. Aturan yang sama sudah ditulis di
  `studio/shortcuts/useTransportShortcuts.ts`.
- **Tombol ditahan** (`e.repeat`). Perintah pertunjukan tidak boleh berulang
  puluhan kali per detik — PLAY yang di-toggle 30×/detik.
- **Space/Enter saat fokus ada di kontrol.** Itu cara keyboard MENEKAN tombol.

Yang ketiga ditemukan belakangan, dan ia adalah kelas kesalahan yang paling
mahal di lapisan ini: **merampas tombol navigasi**. `Tab` sempat diikat ke
"pindah fokus deck", dan akibatnya seluruh halaman berhenti bisa dipakai tanpa
tetikus. Yang membuatnya berbahaya bukan besarnya kerusakan, melainkan bahwa ia
**tidak terlihat sama sekali** oleh siapa pun yang memakai tetikus — jadi ia bisa
hidup sangat lama sebelum ada yang melaporkannya.

Aturannya sekarang: `Tab` tidak pernah diikat, dan `Space`/`Enter` polos
diteruskan begitu fokus ada di `<button>`, `<a>`, atau elemen ber-`role` yang
bisa diaktifkan.

### 5. Satu aksi boleh punya lebih dari satu tombol

`defaultAliases` menjalankan command yang sama tanpa ikut ditampilkan.

Ada karena satu aksi kadang punya dua tombol yang sama-sama wajar diraih, dan
yang **tidak** terikat akan bocor ke browser. Contoh nyatanya: daftar pintasan
diikat ke `?` saja, lalu `/` polos membuka **Quick Find Firefox** — separuh
percobaan user berakhir di kotak pencarian browser alih-alih di daftar pintasan.
Sekarang keduanya terikat.

Alias adalah bawaan saja: begitu user mengikat chord-nya sendiri, alias ikut
dilepas. Pilihan user **menggantikan**, bukan menumpuk — kalau alias tetap
hidup, user yang memindahkan sebuah pintasan akan mendapati tombol lamanya masih
bekerja, dan tidak ada layar yang menjelaskan kenapa.

---

## Merebut chord yang sudah terpakai

Mengikat chord yang sudah dimiliki command lain **merebutnya**, dan pemilik lama
jadi tidak terikat. Menolak dengan "sudah dipakai" memaksa user melepas binding
lama di layar lain lebih dulu — dua langkah untuk satu maksud. Yang direbut
dilaporkan lewat baris status supaya kejadiannya tetap terlihat, bukan senyap.

Chord milik browser (`⌘R`, `⌘W`, `F12`, …) ditolak: merampasnya berarti user
terkurung di dalam aplikasi, dan sebagiannya bahkan tidak bisa dicegah oleh
halaman sama sekali — mengizinkannya hanya menghasilkan binding yang tidak
pernah menyala dan tidak bisa dijelaskan.

---

## Penyimpanan: localStorage, dan satu jebakan

Keymap dibaca **sebelum render pertama** supaya daftar shortcut tidak berkedip
dari bawaan ke milik user, dan localStorage sinkron. Ini juga satu-satunya yang
tersisa di penyimpanan browser: audio dan project **tidak** lagi disimpan lokal
(IndexedDB sudah dibuang seluruhnya) dan akan pindah ke kepustakaan eksplisit
lewat backend. Beberapa ratus byte preferensi tidak butuh backend; puluhan MB
audio butuh.

**Jebakannya**, dan ini ditemukan oleh tes: `typeof localStorage === 'undefined'`
BUKAN penjaga yang cukup. Node 22 mendefinisikan `localStorage` sebagai global
yang **ada tapi bernilai undefined** kecuali dijalankan dengan
`--localstorage-file`; Safari mode privat punya bentuk sebelah lagi — propertinya
ada dan bertipe objek, tapi `setItem` melempar.

Jadi yang diperiksa bukan keberadaannya melainkan **apa yang bisa dilakukan
padanya**, lewat satu tulis-hapus percobaan.

---

## Peringkat palette

Subsekuens murni tidak cukup, dan ini juga ketahuan dari tes: untuk query
`putar`, string "**A**pl**i**kasi B**u**ka daf**t**ar perint**a**h" ikut cocok —
dan karena urutannya alfabetis, ia mendarat di ATAS "Putar / jeda".

Palette yang meranking omong kosong di baris pertama **lebih buruk daripada
tidak ada palette**: Enter jadi tombol yang hasilnya harus dibaca dulu.

Skornya memberi bonus untuk huruf beruntun, awal kata, dan posisi awal — dan
judul disusun sebelum nama grup, supaya kecocokan di nama aksi menang atas
kecocokan di nama kelompoknya.

---

## Fase tahan — kenapa Studio sempat tidak ikut, dan apa yang mengubahnya

Sampai wave 1 desktop, `studio/shortcuts/useTransportShortcuts.ts` adalah
listener `window` kedua di samping dispatcher shell. Alasannya bukan kemalasan:
Spasi di Studio punya semantik **tahan-lepas** — ditahan berarti alat tangan
untuk pan, diketuk berarti play, dan play menyala di `keyup` (lihat
`space-pan.ts`). Registry hanya memodelkan `keydown`.

Menu native desktop (docs/20 D5) yang memaksa keputusannya: item "Putar /
Jeda" harus menyasar **satu id**, dan id itu harus sama dengan yang dipakai
keyboard — kalau tidak, ada dua daftar aksi Studio yang harus dijaga tetap sama.

Jadi registry sekarang punya `Command.hold` — `press` / `release` / `cancel`:

- dispatcher memanggil `press()` di keydown dan **mengingat `e.code`**, bukan
  chord, supaya keyup tetap cocok walau modifier dilepas lebih dulu;
- `release()` di keyup menjawab "ketukan murni?" — hanya kalau ya, `run()`
  dipanggil;
- `blur` jendela memanggil `cancel()` untuk semua yang masih ditahan: Alt-Tab
  saat Spasi ditahan berarti keyup tidak pernah datang.

Hanya keyboard yang punya fase ini. Palette, menu native, dan MIDI memanggil
`run()` langsung — bagi mereka setiap command adalah ketukan. Dan hanya
command yang **membutuhkannya** yang mengisinya; sisanya tidak berubah.

Semua pemetaan Studio kini ada di `studio/commands.ts` (`studio.transport.*`,
`studio.undo/redo`, `studio.clip.*`, `studio.project.save`,
`studio.export.open`), dan `/studio` mendaftarkannya seperti DJ:
`useCommands(studioCommands())`. Dua perbedaan kecil yang mengikuti aturan
shell: tombol yang ditahan tidak lagi mengulang perintah (panah ←/→), dan
Spasi/Enter saat fokus ada di tombol menekan tombolnya.

`studio.project.save` (⌘S, juga item File → Simpan di menu native) sendiri
tidak menyimpan: ia memanggil `runCommand('library.project.save')`, command
yang didaftarkan `LibraryDock` selama dok hidup — bersama
`library.project.saveAs` (selalu buat project baru) dan `library.toggle`.
Simpan yang sebenarnya (`saveProject`, `If-Match`, `markSaved(serial)`,
pembaruan daftar) tetap satu jalur di dalam dok, dipakai tombol SIMPAN PROJECT
dan kedua command itu. Kalau dok belum terdaftar atau sedang tidak bisa
menyimpan (belum masuk, sibuk), ⌘S membuka dok dan memfokuskan tombolnya —
supaya alasannya terlihat, bukan diam.

---

## Menambah pintu masuk berikutnya

MIDI, misalnya, tidak perlu menyentuh satu pun halaman:

```ts
import { runCommand, listCommands } from './app-shell/command';
// note 0x24 → 'dj.deckA.playPause'
runCommand(mapping[note]);
```

Itulah seluruh alasan lapisan ini ada.
