# BEAT SYNC — tempo, fase, dan siapa yang jadi acuan

Riset + keputusan untuk SYNC di halaman `/dj`.

Gejala yang memicunya: menekan SYNC sering ditolak dengan *"selisih tempo di
luar rentang ±10% — ganti rentang tempo dulu"*. Ternyata itu bukan masalahnya,
hanya yang paling terlihat.

---

## 1. Apa yang salah, dan urutan kepentingannya

### (a) Fase tidak ada sama sekali

Beat sync punya **tiga** bagian. Kode lama punya satu.

| Bagian | Sebelum |
|---|---|
| Tempo — samakan BPM | ✅ `faderForBpm` |
| **Fase — sejajarkan ketukannya** | ❌ tidak ada |
| Leader/follower + kapan difase ulang | ⚠️ master manual, sekali jalan |

Menyamakan BPM **tidak** menyambungkan beat. Dua lagu 128 BPM yang dimulai di
detik berbeda akan berjalan sama cepat selamanya sambil ketukannya meleset
tetap — seperti dua jam yang sama-sama akurat tapi disetel beda 200 ms. Ini
kemungkinan besar penyebab sebenarnya dari "SYNC-nya kok tidak kena".

### (b) SYNC menyamakan ke tempo yang tidak sedang terdengar

`Deck.tsx` dan `commands.ts` sama-sama mengirim BPM **base** master ke
`applySync`, bukan BPM efektifnya. Kalau tempo fader master tidak di nol,
follower disamakan ke angka yang tidak keluar dari speaker mana pun. Master di
+6% → follower meleset 6% sejak detik pertama.

### (c) Penolakan "di luar rentang" biasanya salah diagnosis

Selisih di atas ±16% hampir selalu berarti **beda oktaf**, bukan dua lagu yang
tempo-nya berjauhan. Deck 87 lawan master 174 sudah nyambung beat-nya pada
rasio 2:1. Memaksakannya lewat rentang WIDE justru **menaikkan pitch satu oktaf
penuh**, karena MASTER TEMPO belum ada (Utang 2) dan ±100% di sini varispeed
murni. SYNC-nya "berhasil" dan suaranya hancur.

---

## 2. Acuan: Mixxx SyncLock

Satu-satunya algoritma beat sync yang terbuka dan matang. Yang diambil:

- **Leader/follower** dengan pemilihan otomatis (`pickLeader`) — `LeaderSoft`
  dipilih sendiri kalau tidak ada yang eksplisit.
- **Tempo**: `required_rate = (leader_bpm / deck_base_bpm) × halve_double_factor`.
- **Fase lewat beat distance**: nilai `[0,1)` = posisi playhead di dalam ketukan.
- **Seek memicu re-fase** semua follower.

Yang **tidak** diambil: loop koreksi kontinu (tiap callback, error 0.01–0.2
dikoreksi proporsional sampai ±5% rate; di atas 0.2 "train wreck" → +5% penuh).

---

## 3. Kenapa loop koreksi kontinunya sengaja tidak ditiru

Dua alasan yang berdiri sendiri-sendiri:

1. **Deck di sini konstan.** `AudioBufferSourceNode` ber-`playbackRate` tetap,
   dijalankan satu jam audio yang sama. Sekali sejajar, ia tetap sejajar secara
   matematis. Mixxx butuh loop itu karena melayani scratch, grid variabel, dan
   sumber drift-nya sendiri; kita tidak punya satu pun dari ketiganya.
2. **MASTER TEMPO belum ada.** Rate yang digoyang terus-menerus = pitch yang
   bergetar terus-menerus. Obatnya lebih buruk daripada penyakitnya.

Satu-satunya drift yang tersisa berasal dari **grid yang BPM-nya meleset** —
dan itu urusan `analysis/grid-edit.ts`, bukan urusan SYNC. Menambalnya dengan
menggoyang rate berarti menyembunyikan penyebabnya.

Gantinya: **phase meter**. Drift jadi sesuatu yang DILIHAT, bukan yang baru
terdengar dua lagu kemudian, dan yang ditunjuk adalah penyebab yang benar.

---

## 4. Algoritmanya

Semua di `web/src/dj/sync.ts`, murni, tanpa store dan tanpa Web Audio.

### Tempo, dengan pelipatan oktaf

```
leaderBpm = leaderGrid.bpm × tempoRatio(leader.tempo)   ← EFEKTIF, tanpa bend
octave    = round(log2(selfGridBpm / leaderBpm))
targetBpm = leaderBpm × 2^octave
ratio     = targetBpm / selfGridBpm                     ← selalu di [1/√2, √2)
```

Pemilihan di ruang **log**, bukan linier: itu metrik yang benar untuk rasio.
100 lawan 140 karena itu memberi 1.4× (jarak log 0.485), bukan 0.7× (0.514).

**Bend sengaja tidak ikut** ke `leaderBpm`. Jog bend adalah dorongan sesaat;
kalau ikut terbaca, satu sentuhan jog di leader mengubah tempo follower secara
permanen. Mixxx menyebut hal yang sama: *instantaneous BPM* untuk umpan balik
controller, bukan untuk sinkronisasi.

### Fase, pada periode yang lebih KASAR

Ini bagian yang paling mudah salah — Mixxx sendiri pernah kejeblos di sini
(isu #6618: fase kacau justru saat satu lagu setengah tempo yang lain).
Sebabnya: kalau ketukan follower dua kali lebih panjang, "samakan beat distance"
jadi ambigu.

Karena `Tf = Tl / 2^octave`, salah satu periode **selalu** kelipatan bulat yang
lain. Jadi menyejajarkan pada yang lebih panjang otomatis menyejajarkan yang
lebih pendek, dan ambiguitasnya hilang.

```
Tl = 60 / leaderBpm            Tf = 60 / targetBpm       P = max(Tl, Tf)
φ  = (beatIndexAt(pos, grid, sr) × T) mod P              ← tiap deck
δ  = ((φl − φf + 1.5P) mod P) − P/2                      ← |δ| ≤ P/2
δ_samples = δ × ratio × sr
```

`δ × ratio × sr` karena source maju `ratio × sr` sample tiap detik nyata.

Fase dihitung dari **beat index**, bukan dari selisih posisi mentah — itu yang
membuat dua lagu dengan downbeat di tempat berbeda tetap bisa disejajarkan.

### Menerapkannya

Posisi follower **digeser sekali**, bukan dibending pelan-pelan. Itu yang
dilakukan CDJ sungguhan saat SYNC ditekan di tengah lagu; stutter sesaatnya
memang yang orang harapkan. `seekEpoch` ikut dinaikkan — tanpa itu angka di
layar pindah tapi yang terdengar tidak.

### Kapan difase ulang

Hanya saat **leader melompat**, lewat satu langganan store (`startSyncFollow`)
alih-alih panggilan dari dalam `seek()` — `sync-ops` meng-import store, jadi
arah sebaliknya akan jadi siklus. Satu langganan di tepi juga menangkap SEMUA
jalan menuju lompatan tanpa satu pun dari mereka perlu tahu SYNC itu ada.

Yang sengaja **tidak** memicu:

- `syncFromClock` (16×/detik dari jam audio) — ia tidak menaikkan `seekEpoch`,
  dan kalau memicu, jadilah loop koreksi yang §3 jelaskan kenapa dihindari.
- Lompatan follower sendiri — user sedang mengambil keputusan, bukan berbuat
  salah. **Quantize yang menjaganya**: setelah kedua grid sejajar, menempel ke
  grid sendiri berarti mendarat di ketukan leader juga.
- **Tarikan waveform yang masih berlangsung.** Satu tarikan menghasilkan puluhan
  `seek`; `DeckState.scrubbing` menahan langganan sampai jari diangkat, lalu
  seluruh tarikan ditanggapi SEKALI.

Dan satu batas yang lebih keras dari semuanya:

> **Follower yang SEDANG BERBUNYI tidak pernah digeser.**

Itu apa yang sedang didengar orang. Memindahkan posisinya karena user menyentuh
deck *lain* berarti lagu yang mengudara melompat tanpa ada yang menyentuhnya.
Mixxx boleh melakukannya karena ia mengoreksi lewat RATE beberapa persen —
perubahan yang tidak terdengar sebagai lompatan; kita menggeser POSISI, dan
lompatan posisi selalu terdengar. Fase follower yang berbunyi karena itu jadi
keputusan user lewat tombol SYNC, dan `PhaseMeter` yang memberi tahu kapan
perlu.

Versi pertama fitur ini melewatkan kedua hal di atas, dan gejalanya persis:
menarik waveform deck MASTER menyeret deck sebelahnya ikut berjalan, sambil
menjadwalkan ulang audionya puluhan kali dalam satu gerakan tangan.

### Leader dan rentang

- Tidak ada MASTER? Deck lain **diangkat jadi master**, bukan dipakai diam-diam
  sebagai acuan — crown di layar harus menunjuk deck yang benar-benar jadi acuan.
- Rasio tidak muat? Naik ke rentang **terkecil** yang cukup (6 → 10 → 16 → 100)
  dan katakan di notice. Bukan langsung WIDE: di ±100% langkah fader 0.5%, yaitu
  ±0.64 BPM pada 128, terlalu kasar untuk nudge manual sesudahnya. Rentang tidak
  pernah DIPERSEMPIT — itu mengubah arti tiap gerakan fader sesudahnya.

---

## 5. Berkas

| Berkas | Isi |
|---|---|
| `dj/sync.ts` | murni: `syncBpmOf`, `foldToOctave`, `smallestRangeFor`, `phaseDeltaSec`, `phaseErrorBeats`, `planSync` |
| `dj/sync-ops.ts` | leader, penerapan, `toggleSyncFor`, `resyncPhase`, `startSyncFollow` |
| `dj/deck/PhaseMeter.tsx` | strip fase di bawah tombol SYNC |
| `dj/store.ts` | `applySyncPlan` + `clearSync` menggantikan `applySync`/`toggleSync` |
| `dj/sync.test.ts` · `dj/sync-ops.test.ts` | 26 + 16 tes |

Store sekarang **tidak menghitung apa pun** soal sync — ia menerima rencana
jadi. Alasannya: sync butuh grid, grid milik `studioStore`, dan store DJ sengaja
tidak tahu apa pun tentang asset. Pola yang sama dengan `grid/grid-ops.ts`.

`PhaseMeter` komponen tersendiri karena ia membaca playhead KEDUA deck yang
bergerak ~16×/detik; menaruhnya di dalam `DeckTempo` akan me-render ulang
seluruh kolom tempo pada laju itu.

---

## 6. Yang dikunci tes

- Tempo disamakan ke BPM **efektif** leader, bukan base-nya.
- 87 mengikuti 174 dengan fader **nol** dan badge `÷2` — bukan ditolak, bukan
  dinaikkan satu oktaf.
- Rentang naik sendiri ke ±16% untuk 128 → 145, dan dikatakan.
- Rentang tidak pernah dipersempit.
- Fase benar-benar nol setelah SYNC, termasuk saat downbeat kedua grid berbeda
  **dan** saat oktafnya berbeda.
- `seekEpoch` naik saat fase digeser.
- Leader melompat → follower ikut; umpan jam → tidak; lompatan follower sendiri
  → tidak ditarik balik.
- Koreksi fase selalu yang **terkecil** (mundur 0.25 ketukan, bukan maju 0.75).

---

## 7. Yang masih terbuka

- **MASTER TEMPO / keylock** (Utang 2). Selama belum ada, rasio yang jauh dari
  1.0 tetap menggeser pitch — pelipatan oktaf memperkecil dampaknya, tidak
  menghapusnya.
- **Sync ke BAR, bukan hanya ketukan.** rekordbox pun menyejajarkan ketukan, dan
  nomor bar di sini arbiter (`beat-grid.ts`), jadi bar sync baru jujur kalau
  kedua downbeat sudah disetel tangan lewat GRID EDIT. Bisa jadi opsi nanti.
- **Deck C/D.** `pickLeader` sekarang mengasumsikan dua deck.
