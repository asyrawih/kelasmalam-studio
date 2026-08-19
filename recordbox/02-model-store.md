# 02 — Model & store halaman `/dj`

Kode: `web/src/dj/model.ts` (tipe + matematika murni) dan `web/src/dj/store.ts`
(mutasi). Dokumen ini hanya berisi **kenapa**-nya; bentuk persisnya ada di kedua
berkas itu dan tidak disalin ke sini supaya tidak ada dua kebenaran.

---

## Tiga keputusan yang menentukan sisanya

**1. Semua posisi SOURCE-space, tanpa kecuali.**
Studio punya dua koordinat (`docs/07 §8d`): SOURCE di dalam asset, TIMELINE di
lane yang diskalakan `speedRatio`. Deck memutar **satu lagu utuh** — tidak ada
trim-in, tidak ada clip, tidak ada lane — jadi keduanya runtuh jadi satu. Tempo
fader mengubah **laju baca**, bukan geometri.

Konsekuensinya nyata dan bukan kosmetik: `ScrollingWave` bisa dipakai apa adanya
dengan `clipStart = 0`, `speedRatio = 1`, `clipSourceStart = 0`, karena
pemetaannya jadi identitas.

**2. Kepustakaan asset TIDAK diduplikasi.**
`djStore` tidak menyimpan `assets`. Deck hanya memegang `assetId`; envelope,
frames, tempo, dan grid dibaca dari `studioStore`. Satu registry, satu jalur
decode, satu IndexedDB.

**3. Fakta asset yang IMMUTABLE boleh disalin; yang MUTABLE tidak.**
`frames`, `sampleRate`, `name` diset sekali di `assetFromBuffer` dan tidak pernah
berubah — menyalinnya ke `DeckState` membuat store bisa meng-clamp playhead,
cue, dan loop **sendiri di satu tempat** (`withDerived`) tanpa membaca store
lain. Sebaliknya `bpmOverride`, `tempoOctave`, `beatOffsetOverride` bisa diubah
user di `/studio` kapan saja; menyalinnya berarti BPM deck basi diam-diam.

> Aturan ringkasnya: **kalau sebuah nilai bisa berubah dari luar deck,
> turunkan — jangan simpan.** Semua turunan berkumpul di `deck-view.ts`.

---

## Hot cue milik ASSET, bukan deck

`DjState.cues: Record<assetId, TrackCues>`, dan aksi pad tetap ber-parameter
`deckId` (diselesaikan ke `assetId` di dalam store).

Alasannya sama dengan `assetGrids` di `persist/persistence.ts`: yang tidak bisa
dibangun ulang dari file adalah **keputusan user**, dan hanya itu yang layak
disimpan. Di rekordbox pun begitu — muat lagu yang sama ke deck lain, cue-nya
ikut. Kalau cue dipasang di `DeckState`, `ejectDeck` lalu memuat ulang lagu yang
sama akan menghapus sepuluh menit kerja tanpa satu pun peringatan.

Diuji langsung: `store.test.ts` → *"lagu yang sama di deck lain membawa cue-nya"*
dan *"lagu BERBEDA tidak mewarisi cue lagu lain"*.

---

## Nilai yang sengaja BERBEDA dari Studio

| Nilai | Bentuk | Kenapa bukan seperti Studio |
|---|---|---|
| Tempo fader | travel `−1..+1` + `rangePct` terpisah | Mengganti RANGE ±6→±16 **tidak** menggerakkan fader fisik; yang berubah adalah arti posisi yang sama. Kalau yang disimpan persen, ganti range harus menggeser fader — gerakan hantu yang tidak dilakukan alat mana pun |
| Channel fader | travel `0..1`, gain `t²` | Unity di **puncak**, nol **mutlak** di dasar. `rail/fader.ts` menyimpan dB dengan unity di 75% travel; bolak-balik lewat dB membuat "benar-benar nol" jadi −∞ yang harus dijaga di tiap konversi |
| EQ | `−26 … +6 dB` | **Spesifikasi DJM-900NXS2** yang ditiru rekordbox, bukan angka pilihan sendiri. `EQ_KILL_DB` dipakai sebagai KILL; −∞ ditolak karena memaksa cabang khusus di setiap rumus gain dan telinga tidak bisa membedakannya untuk satu band di dalam mix |
| `loop.active` | bit TERPISAH dari `in`/`out` | Itu seluruh guna RELOOP. `loop: {in,out} \| null` membuat keluar loop menghapus batasnya, dan memasangnya lagi dengan tangan di tengah mix tidak mungkin |
| `deck.bend` | pengali terpisah dari `tempo.fader` | Nudge harus kembali ke 1 saat tangan lepas; kalau ia menulis ke fader, satu nudge mengubah BPM lagu **permanen** |
| `deck.seekEpoch` | naik hanya saat user MELOMPAT | Satu-satunya yang memisahkan "playhead maju sendiri" dari "user melompat". Lapisan audio menjadwalkan ulang source hanya saat ia berubah — itulah yang membuat umpan jam 16×/detik tidak bisa memicu penjadwalan ulang |
| `deck.slip` | bit di store; posisi bayangannya TIDAK | Bayangan bergerak kontinu dari jam audio dan hanya dibaca pada satu momen (saat slip dilepas). Menyimpannya di store berarti menulis ulang state 60×/detik untuk angka yang tidak pernah dibaca di antaranya — jadi ia hidup di `DeckPlayer` |

`WIDE` benar-benar **±100%**, dan di −100% `effectiveRate` mengembalikan 0 —
lagunya berhenti. Itu perilaku CDJ, dan ada tesnya.

---

## SYNC mengembalikan alasan, bukan diam

`applySync` mengembalikan `{ ok, reason? }`. `faderForBpm` mengembalikan `null` —
**bukan nilai yang dijepit** — kalau selisih tempo di luar rentang yang dipilih.

Fader yang mentok di ±16% sambil menyalakan lampu SYNC adalah kebohongan yang
hanya ketahuan lewat telinga, setelah dua lagu terlanjur melenceng di depan
orang. Alasannya dipajang di baris status di bawah baris FX.

Label tombolnya berbunyi **SYNC** tapi `title`-nya menyatakan bahwa yang
disamakan baru **tempo**, bukan fase/downbeat.

---

## Tujuh jebakan stabilitas referensi

Satu gerakan crossfader menghasilkan puluhan `set` per detik, dan dua deck yang
masing-masing punya loop rAF waveform tidak boleh ikut bangun.

1. **Selector yang mengarang objek.** `useDj(s => ({a, b}))` → `getSnapshot`
   selalu berbeda → render tanpa henti. Panggil `useDj` dua kali.
2. **`crossfaderGains` sebagai selector.** Ia mengembalikan objek baru dan
   terlihat seperti "selector turunan" — itulah yang membuatnya berbahaya.
   Aturan: **fungsi yang mengembalikan objek dipanggil di dalam render, dari
   primitif.** `MixerSection.tsx` melakukannya persis begitu.
3. **Menyentuh kedua deck padahal satu berubah.** Semua mutasi lewat
   `patchDeck`, yang mengembalikan `null` kalau objeknya tidak berubah.
4. **`tick()`** — satu-satunya aksi yang menyentuh dua deck — harus tetap
   mengembalikan objek LAMA untuk deck yang tidak playing.
5. **Menulis nilai yang sama.** Tiap setter membandingkan dulu; `setTempoFader`
   dengan nilai identik tidak boleh memicu apa pun.
6. **`withDerived` yang selalu membangun ulang.** Ia berjalan pada setiap `set`,
   jadi ia wajib mengembalikan state yang MASUK kalau tidak ada invarian yang
   dilanggar.
7. **`useDj()` tanpa selector.** Ada untuk tes dan jalur non-React; komponen yang
   memakainya akan bangun pada perubahan apa pun.

Dijaga oleh `store-stability.test.tsx`: probe berlangganan deck A, 50 aksi pada
deck B + crossfader, `expect(renders).toBe(1)`.

---

## Invarian, ditegakkan di satu tempat

`withDerived` memaksa enam hal supaya tiap aksi tidak perlu mengingatnya:
playhead dijepit ke `[0, frames]`; loop yang keluar batas **dibuang** (bukan
dijepit — loop yang diam-diam berpindah tempat lebih buruk daripada loop yang
hilang); loop dengan `out ≤ in` tidak boleh aktif; `masterDeck` yang menunjuk
deck kosong jadi `null`; hanya satu deck boleh `master`; deck kosong tidak boleh
`playing`.
