# 24 — Composer: halaman produksi musik ala FL Studio

Rencana membangun halaman baru **Composer** di route **`/composer`** dengan
workflow ala FL Studio: Channel Rack, Pattern, Playlist, Piano Roll dan Mixer.
Composer berdampingan dengan `/studio` dan `/dj`; Studio lane tetap tersedia
pada web maupun desktop. Ini penambahan halaman, bukan penggantian Studio.

**Revisi riset: 10 September 2026.** Target kini mencakup workflow produksi lengkap,
bukan hanya lima panel FL. F0–F8 adalah fondasi; F9–F14 wajib untuk rilis
produksi, F15–F17 perluasan. Matriks cakupan, koreksi kontrak, dan sumber
resmi ada di §8–§11. Semua fase adalah rencana, bukan klaim sudah tersedia.
Lampiran user berisi katalog Lua Roblox, sehingga review memakai dokumen ini.

Dokumen ini adalah keputusan dan fase. Kode datang setelahnya, per fase, lewat
`pengoding` (AGENT.md), dengan fase yang tidak saling bergantung dikerjakan
paralel di worktree terpisah.

> **Koreksi scope user: Composer adalah page baru.** Implementasi awal tetap
> desktop sesuai scope sebelumnya, dengan entry `ComposerPage`, route
> `/composer` dan paket `packages/composer`. `/studio` tetap menggunakan
> `packages/studio` di kedua host. Prasyarat paket bersama mengikuti
> [docs/25](25-pisah-web-desktop.md) P2/P4. Asset, waveform, import, BPM dan
> stem memakai `packages/studio-core`; engine/export memakai `packages/engine`.
> Penyebutan Studio sebagai produk baru pada sketsa lama berarti Composer;
> nama FL Studio hanya referensi workflow. File plan tetap bernama
> `24-studio-fl.md` agar tautan dokumentasi yang ada tidak putus.

---

## 0. Dari mana kita mulai

Empat fakta dari repo yang menentukan bentuk rencana ini:

1. **Engine Rust sudah punya bahan sequencer, tapi hanya dipakai saat export.**
   `crates/engine/src/lib.rs` `render_block` memotong blok di setiap event
   (`render_span`), `VoicePool` 256 voice dengan stealing (`voice.rs`), dan
   opcode `TRIGGER_CLIP` memicu voice dari sebuah `ClipDesc` dengan `speed`.
   Semua itu dijalankan dari `OfflineRenderer` (`crates/export`), diberi
   project lewat pemetaan `crates/wasm-bridge/src/studio.rs` (UI JSON →
   postcard).
2. **Playback realtime Studio bukan engine.** `web/src/studio/preview/` memakai
   `AudioBufferSourceNode` per clip, dengan catatan "jalur SEMENTARA". Edit clip
   hanya memutasi mirror TS (`web/src/studio/store.ts`); Rust tidak pernah
   menerima snapshot kecuali saat export. Akibatnya preview ≠ export, dan
   melanggar aturan emas #3 ARCHITECTURE.md. Step sequencer tidak mungkin
   dibangun di atas jalur ini tanpa membuat pelanggaran itu permanen.
3. **Waktu di model semuanya sample.** `timeline-core/src/model.rs` punya
   `TempoMap` (konstan 120 BPM, `rebuild_anchors`), tapi tidak ada bar, beat,
   tick, atau time signature. BPM yang tampil di `BpmCell` adalah hasil deteksi
   per-asset (docs/10), bukan tempo project. Beat grid docs/11 hidup di
   source-space clip, bukan di timeline.
4. **Piano Roll dan Step Sequencer sudah ada sebagai shell statis**
   (`web/src/ui/panels/StepSequencer.tsx`, `PianoRoll.tsx`, docs/08 §8c) dengan
   prasyarat yang dituliskan di sana: clip MIDI di model, opcode NoteOn/NoteOff,
   instrumen, voice allocator polifonik. Rencana ini adalah cara melunasi
   prasyarat itu.

Yang tetap dipakai utuh: import/decode/waveform pyramid (docs/06), deteksi BPM
(docs/10), beat cut/loop cut/stem (docs/11), registry FX yang ada
(`engine/src/fx/registry.rs`: Eq4, Comp, Filter, Echo, Spiral, Flanger, Reverb,
Pitch, Stem), export offline (docs/03), app-shell command registry + keymap
(docs/15), kepustakaan (docs/16, docs/21), desktop (docs/20).

---

## 1. Peta paradigma: sekarang → FL

| Konsep FL Studio | Sekarang di Studio | Di Composer |
|---|---|---|
| **Channel** (sumber bunyi: sampler, audio clip, instrumen) | tidak ada; clip audio langsung di lane | `Channel` di model Rust; jenis `Sampler`, `AudioClip`, `Synth` |
| **Channel Rack** (daftar channel + 16 step per bar) | shell statis `StepSequencer.tsx` | panel nyata, state dari store, step = `Note` panjang 1 step |
| **Pattern** (kumpulan not semua channel) | tidak ada | `Pattern` di model; pattern selector di toolbar; PAT/SONG mode |
| **Playlist** (susunan pattern clip + audio clip di track visual) | timeline per lane, clip terikat lane | `Playlist` dengan `PlaylistTrack` (visual saja) dan `PlaylistClip` |
| **Piano Roll** (not per channel per pattern) | shell statis `PianoRoll.tsx` | panel nyata |
| **Mixer Insert** (slot FX, EQ, volume, pan, routing) | lane punya gain/EQ/chain sendiri | `Insert` di `Mixer`; channel → satu insert; insert 0 = Master |
| **Browser** (kiri) | dok kepustakaan di bawah | sidebar kiri, isi sama |
| **Transport** PAT/SONG, BPM project, posisi bar:beat | speed transport, BPM per-asset | tempo project di `TempoMap`, tampil bar:beat:tick |
| **Lane** | inti UI, 14 ribu baris di `studio/timeline/` | tetap di Studio; Composer memakai `PlaylistTrack`: nama, warna, tinggi, mute, kunci |

Aturan FL yang sengaja diikuti persis, karena inilah yang membuat "terasa FL":

- Playlist track **tidak** menentukan bunyi. Pattern clip di track 1 atau
  track 7 berbunyi sama; yang menentukan bunyi adalah channel → insert.
- Satu pattern dipakai berkali-kali di playlist; mengubah pattern mengubah
  semua clip-nya.
- Step sequencer dan piano roll melihat data yang sama: sebuah step adalah
  not sepanjang satu step di piano roll, dan not yang digambar di piano roll
  tampil sebagai step (dengan penanda "ada not di luar grid step" bila perlu).
- Audio clip di playlist adalah channel juga (FL: "Audio Clip channel"), supaya
  ia punya insert, volume, dan bisa di-mute dari Channel Rack.
- Mode PAT memutar pattern aktif berulang; mode SONG memutar playlist.
- Klik pad/step di Channel Rack langsung berbunyi (audisi), tanpa transport.

Yang sengaja **tidak** diikuti persis, dan alasannya:

| Milik FL | Keputusan di sini | Alasan |
|---|---|---|
| Jendela mengambang bebas di atas desktop | Panel dok yang bisa diubah ukurannya; F5–F9 menampilkan/menyembunyikan | Jendela mengambang di halaman web rapuh di layar kecil dan di WebView desktop; toggle F-key sudah memberi ritme kerja yang sama |
| Mixer dengan chain dan routing fleksibel | F6: 4 slot; F11: target 10 slot, bus/send/sidechain + kompensasi latensi | Perlu perubahan kapasitas engine dan kontrak SAB, bukan sekadar UI |
| Plugin eksternal dan instrumen bawaan | Sampler + synth F7, sampler lengkap F12, host plugin native F16 | Hosting native memerlukan jalur audio desktop tersendiri; bukan memuat binary VST dalam WASM |
| Time signature dan tempo berubah | 4/4 konstan untuk fondasi; tempo map dan meter map F13 | Model menyisakan kontrak sejak F1; compiler, ruler, recording, dan stretch harus konsisten |

---

## 2. Keputusan yang mengikat

### 2a. Sequencer hidup di engine Rust, bukan di Web Audio

Alternatif yang dipertimbangkan: scheduler lookahead di JS
(`AudioBufferSourceNode.start(t)`) untuk channel sampler. Ia cukup akurat untuk
sampel, tapi tidak bisa memainkan synth, tidak bisa menjamin preview ≡ export,
dan membuat "jalur sementara" jadi permanen. **Ditolak.**

Keputusan: Composer memakai `EngineClient` + AudioWorklet sejak awal.
Playback Studio yang ada tetap berjalan lewat jalurnya sendiri. F0 membuktikan
fixture audio-clip melalui render realtime dan offline engine yang sama
sebelum menambahkan sequencer not; tidak memerlukan pergantian playback Studio.

### 2b. Waktu musikal: tick

- `PPQ = 960` tick per beat (FL bawaan 96, bisa sampai 960; 960 habis dibagi
  triplet, quintuplet, dan 1/64).
- **Pattern dan Playlist memakai tick.** Audio clip di playlist juga
  diposisikan dalam tick (FL: audio clip ikut bergeser saat tempo berubah,
  kecuali di-stretch). Panjang audio clip dalam sample tetap disimpan
  (`source_len`), panjang tampilannya turunan dari tempo.
- Tick → sample selalu dihitung dari **tick absolut** lewat `TempoMap`
  (bukan akumulasi per step), supaya tidak ada drift antar bar. Ini yang sudah
  dilakukan `rebuild_anchors`; ia diberi API `tick_to_sample(tick) -> u64` dan
  `sample_to_tick`.
- Aturan docs/00 tetap: posisi tidak pernah disimpan sebagai detik float.
  Tick adalah integer.

### 2c. Model tetap satu sumber kebenaran di Rust; TS mirror

Struct baru masuk `crates/timeline-core/src/model.rs` dan
`schema/project.schema.json` (`PROJECT_VERSION = 2`). Tipe TS di
`packages/composer/src/model.ts` mengikuti, dan pemetaan UI → engine tetap **hanya**
di `crates/wasm-bridge/src/studio.rs`. Tidak ada tata letak postcard yang
disalin ke TS.

### 2d. Halaman dan sesi terpisah

Daftarkan `/composer` dan menu **Composer** melalui route/command registry
app desktop. `/studio` dan `/dj` tetap bisa dibuka. Composer memiliki store,
undo history, autosave namespace, project kind (`composer`) dan version sendiri;
Studio mempertahankan format/sesi lamanya. Tidak ada konversi otomatis saat
membuka Studio atau Composer. Konversi §6 adalah aksi **Import from Studio**
yang membuat salinan project baru tanpa menimpa sumber.

Aset bersama memakai registry/ref-count yang sama, dengan asset-root Composer
tersendiri supaya pruning Studio/DJ tidak menghapus aset Composer. Saat pindah
halaman, transport halaman asal berhenti dan melepas voice/input monitoring;
halaman tujuan tidak autoplay. State tersimpan dipulihkan tanpa playback.
Lifecycle engine dan listener dilepas saat unmount untuk mencegah audio ganda.

### 2e. Yang terlihat di layar

```
┌ Header ──────────────────────────────────────────────────────────────────┐
│ [PAT|SONG] ▶ ■ ● │ 120.00 BPM │ 004:02:480 │ Pattern: [Pattern 3 ▾] [+] │
├ Browser ─┬ Area kerja ─────────────────────────────────────────────────┤
│ (F8)     │  Playlist (F5)                                               │
│ kepusta- │  ┌ Track 1 │ ▓▓Pattern 3▓▓  ▓▓Pattern 3▓▓  ░░ audio ░░░░ ┐   │
│ kaan,    │  │ Track 2 │      ▓▓Pattern 1▓▓                          │   │
│ folder,  │  └ ...                                                    ┘   │
│ preset   ├──────────────────────────────────────────────────────────────┤
│          │  Channel Rack (F6)      │  Piano Roll (F7) / Mixer (F9)      │
│          │  ● KICK  [●··●·●··]     │  (panel aktif: tab, bukan jendela) │
│          │  ● SNARE [····●···]     │                                    │
└──────────┴──────────────────────────────────────────────────────────────┘
```

Area kerja adalah grid dua baris yang tingginya bisa ditarik. Baris atas
Playlist; baris bawah dua panel berdampingan. F5–F9 menampilkan atau
menyembunyikan; Alt+F-key memaksimalkan satu panel (memakai mekanisme
`maximize` yang sudah ada di `studio/shell`). Semua shortcut lewat registry
docs/15, chord disimpan per `event.code`.

---

## 3. Model data (Rust, `timeline-core`)

```rust
pub const PPQ: u32 = 960;
pub type Tick = u64;

pub struct Project {
    pub version: u32,                 // 2
    pub sample_rate: u32,
    pub tempo_map: TempoMap,          // yang ada; ditambah tick_to_sample/sample_to_tick
    pub swing: f32,                   // 0..1, global seperti FL
    pub channels: Vec<Channel>,
    pub patterns: Vec<Pattern>,
    pub playlist: Playlist,
    pub mixer: Mixer,
    pub assets: Vec<AssetRef>,        // yang ada
}

pub struct Channel {
    pub id: ChannelId,
    pub name: String,
    pub color: Color,
    pub kind: ChannelKind,
    pub insert: InsertId,             // 0 = Master
    pub volume_db: f32,
    pub pan: f32,
    pub muted: bool,
    pub soloed: bool,
}

pub enum ChannelKind {
    /// One-shot: not memicu asset dari awal; pitch = 2^((key - root)/12).
    Sampler { asset: AssetId, root_key: u8, cut_self: bool, start: SourceSample, len: SourceSample },
    /// Sumber untuk audio clip di playlist (FL "Audio Clip channel").
    AudioClip { asset: AssetId },
    /// F7: osilator sederhana (saw/square/sine), ADSR, polifonik.
    Synth { patch: SynthPatch },
}

pub struct Pattern {
    pub id: PatternId,
    pub name: String,
    pub color: Color,
    /// Not per channel. Step sequencer dan piano roll membaca daftar yang sama.
    pub notes: BTreeMap<ChannelId, Vec<Note>>,
    /// Panjang eksplisit dalam bar; None = otomatis mengikuti not terakhir (FL).
    pub len_bars: Option<u32>,
}

pub struct Note {
    pub start: Tick,
    pub len: Tick,
    pub key: u8,                      // 0..127, C5 = 60 (konvensi FL)
    pub velocity: f32,                // 0..1
    pub pan: f32,
}

pub struct Playlist {
    pub tracks: Vec<PlaylistTrack>,   // visual: nama, warna, tinggi, mute, locked
    pub clips: Vec<PlaylistClip>,
    pub loop_range: Option<(Tick, Tick)>,
}

pub struct PlaylistClip {
    pub id: ClipId,
    pub track: PlaylistTrackId,
    pub start: Tick,
    pub len: Tick,
    pub kind: PlaylistClipKind,
}

pub enum PlaylistClipKind {
    Pattern { pattern: PatternId, offset: Tick },
    Audio {
        channel: ChannelId,           // ChannelKind::AudioClip
        source_start: SourceSample,
        source_len: SourceSample,
        speed_ratio: f32,             // varispeed, dari lane.speedRatio lama
        gain_db: f32,
        fade_in: FadeSpec, fade_out: FadeSpec,
        insert_chain: Vec<FxDef>,     // per-clip FX yang ada, batas MAX_CLIP_CHAINS
    },
}

pub struct Mixer { pub inserts: Vec<Insert> }  // inserts[0] = Master; MAX_BUSES yang ada

pub struct Insert {
    pub id: InsertId,
    pub name: String,
    pub eq: [EqBand; 4],
    pub chain: Vec<FxDef>,            // MAX_CHAIN_LEN
    pub volume_db: f32,
    pub pan: f32,
    pub muted: bool,
}
```

Invariant yang dijaga `normalize()` (seperti `Project::normalize` sekarang):
setiap `Channel.insert` ada; setiap `PlaylistClipKind::Pattern.pattern` ada;
setiap `Audio.channel` bertipe `AudioClip`; not tidak keluar dari
`len_bars` bila eksplisit; `key` ≤ 127.

`Track`, `Clip.track`, dan `Bus` legacy tetap untuk Studio; model Composer
tidak memakai lane. Modul edit Composer
(split/trim/move) dipindah ke tick untuk `PlaylistClip`, dan versi sample-nya
tetap dipakai untuk `source_start/source_len` audio clip.

---

## 4. Engine: sequencer

### 4a. Kompilasi event

`crates/engine` menerima **daftar event yang sudah dikompilasi**, bukan
pattern mentah. Kompilasi terjadi di main thread (di dalam `wasm-bridge`,
Rust):

```
song mode   : ∀ PlaylistClip::Pattern → ∀ Note di pattern → NoteOn(sample, channel, key, vel), NoteOff(sample, ...)
              ∀ PlaylistClip::Audio   → ClipStart(sample, ...)  (yang ada sekarang)
pattern mode: pattern aktif saja, diulang sepanjang len; ClipStart tidak ada
swing       : step ganjil (1/16 ke-2, ke-4, ...) digeser +swing × (1/16 tick / 2) sebelum konversi ke sample
```

Hasilnya `Vec<Event>` terurut sample, dalam struct snapshot yang sama
(`engine/src/snapshot.rs`) yang sekarang dikirim ke export. Ribuan not adalah
angka kecil; kompilasi ulang penuh setiap edit lebih sederhana daripada
patch inkremental, dan itu yang dilakukan sampai terbukti lambat (target:
10.000 not ≤ 5 ms).

### 4b. Pertukaran snapshot ke audio thread

Kendala: audio thread tidak boleh alokasi (aturan emas #2), dan ini bukan
data per-frame (aturan #1 mengizinkan low-rate). Mekanisme: main thread
men-deserialize snapshot ke arena di shared memory, lalu menukar pointer
secara atomik, dengan cara yang sudah dipakai `ProcessPlan` untuk reorder FX
(docs/02 "rebuild ProcessPlan atomik"). Engine yang sedang memutar
mempertahankan posisi sample; voice yang sedang berbunyi selesai apa adanya.
Menambah step saat transport jalan terdengar di bar berikutnya paling lambat
satu blok setelah pertukaran — sama seperti FL.

Detail arena (ukuran, double-buffer, apa yang terjadi saat snapshot lebih
besar dari arena) diputuskan `arsitek` di F2 dengan kendala di atas.

### 4c. Opcode baru di command ring

| Opcode | Kegunaan |
|---|---|
| `NOTE_ON {channel, key, vel}` | audisi: klik pad, keyboard mengetik, MIDI in nanti |
| `NOTE_OFF {channel, key}` | pasangan `NOTE_ON` untuk synth; sampler mengabaikan kecuali `cut_self` |
| `SET_MODE {pattern\|song}` | PAT/SONG |
| `SET_PATTERN {id}` | pattern aktif di mode PAT |
| `SET_INSERT_GAIN/PAN/MUTE`, `SET_CHANNEL_GAIN/PAN/MUTE` | mengganti `SET_GAIN_DB`/`SET_PAN`/`SET_MUTE` per-track |

`TRIGGER_CLIP` tetap untuk audisi audio clip. `STOP_ALL_VOICES` tetap.

### 4d. Voice

`VoicePool` yang ada dipakai apa adanya untuk sampler: `NoteOn` →
`VoiceStart` dengan `speed = 2^((key − root_key)/12) × source_speed`. Yang
ditambahkan: voice bertipe `Synth` (F7) dengan fase osilator + ADSR, dan
`release()` untuk `NoteOff`. Stealing, fade-out, dan meter tidak berubah.

Kanal per **insert**, bukan per track: `render_track` menjadi
`render_insert`, menjumlahkan voice semua channel yang menuju insert itu,
lalu EQ, chain, volume, pan, lalu Master. Per-clip chain audio clip tetap
seperti sekarang.

---

## 5. UI

### 5a. Store dan command

`packages/composer/src/store.ts` memakai `useSyncExternalStore` dengan state
Composer sendiri mengikuti §3. `composerActions` menyediakan: `addChannel`,
`setStep`, `addNote`, `moveNote`, `addPattern`, `clonePattern`,
`paintPatternClip`, `setChannelInsert`, dan seterusnya. Semua mutasi
struktural mengirim snapshot baru lewat `useEngineCommands().commit()` (jalur
`*Commit()` yang ada); parameter kontinu (volume, pan) lewat `*Live()`.

Undo (`studio/undo.test.ts`) tetap satu tumpukan untuk seluruh project.

### 5b. Panel dan dari mana kodenya

| Panel | Dibangun dari | Yang dipakai ulang |
|---|---|---|
| Channel Rack | `ui/panels/StepSequencer.tsx` (shell) | layout pad 16 sel, warna; ditambah tombol nama → Channel Settings, knob vol/pan, LED mute, kolom "step sedang main" dari playhead SAB, graph editor velocity |
| Playlist | `studio/timeline/ClipArea.tsx` → `studio/playlist/` | marquee (docs/12), snap (`clip-snap.ts` → tick), zoom roda, waveform draw, fade draw, ruler (`TimelineRuler` → bar:beat), import drop (`library-drop`, `url-import`, YouTube) |
| Piano Roll | `ui/panels/PianoRoll.tsx` (shell) | keyboard kiri, grid; ditambah gambar/hapus/geser/panjang not, ghost not channel lain, lajur velocity, snap |
| Mixer | toolbar mixer/EQ/master yang ada (`studio/rail`, `studio/fx`) | fader, EQ 4 band, chain FX picker, meter SAB; disusun horizontal per insert |
| Browser | `library/LibraryDock.tsx` | isi sama, pindah ke sidebar kiri; seret ke Channel Rack = channel Sampler baru, seret ke Playlist = channel AudioClip + clip |
| Transport | `shell/TransportButtons.tsx`, `BpmCell.tsx` | PAT/SONG, BPM project (bukan per-asset), pattern selector, bar:beat:tick |

Alat Playlist mengikuti FL: **Draw** (klik = taruh pattern aktif / audio
clip), **Paint** (seret = taruh berulang), **Delete**, **Select**, **Slip**
(geser isi clip). Snap: Line, Cell, 1/2 step … Bar, None.

### 5c. Audio clip di Playlist

Semua yang sudah ada di clip audio hari ini tetap: trim, split, fade,
gain, envelope, beat cut dan loop cut (docs/11), stem (docs/11), FX
per-clip. Yang berubah: posisi dan panjang tampilan dalam tick;
`speedRatio` pindah dari lane ke clip; Clip Detail (`ClipDetailDialog`) tetap
dipanggil dari klik kanan clip.

### 5d. Keyboard

| Chord bawaan | Command |
|---|---|
| F5 / F6 / F7 / F8 / F9 | toggle Playlist / Channel Rack / Piano Roll / Browser / Mixer |
| L | PAT ↔ SONG |
| Space | play/pause; Ctrl+Space play dari awal |
| Ctrl+B | duplicate selection di Playlist/Piano Roll; pattern berikut/sebelum memakai command terpisah |
| Ctrl+Shift+C | clone pattern |
| Z X C V B N M , (baris bawah) dan Q W E R T Y U I (baris atas) | keyboard mengetik → `NOTE_ON` channel terpilih, oktaf ±: command terpisah tanpa bentrok tombol not |

Semuanya lewat `packages/composer/src/commands.ts` (docs/15) supaya bisa di-remap.

---

## 6. Import salinan project Studio ke Composer

Konverter Rust digunakan oleh aksi Import from Studio. Skema Composer
berversi terpisah dengan discriminator `kind: composer`; versi format Studio
bukan versi Composer. Nama v1/v2 pada fixture di bawah hanya menyebut sumber
legacy dan target model baru. Simpan ID baru, sumber tetap utuh, dan laporkan
field yang belum dapat dikonversi sebelum menyimpan salinan. Autosave Studio
serta reader web tidak diubah menjadi format Composer.

| Lama | Baru |
|---|---|
| `Project.tempo_map` (120 konstan) | tetap; tempo project = 120 kecuali user ubah |
| `lane[i]` | `PlaylistTrack[i]` (nama, warna, tinggi) **dan** `Insert[i+1]` (gain, EQ, chain, mute, solo) |
| `lane.speedRatio` | `PlaylistClipKind::Audio.speed_ratio` tiap clip di lane itu |
| `clip` di lane i | satu `Channel{AudioClip, asset}` per pasangan asset + lane/routing asal, `insert = i+1`; satu `PlaylistClip::Audio` di track i, `start = sample_to_tick(clip.start)` |
| `masterGainDb`, chain master | `Insert[0]` |

Migrasi tidak boleh membulatkan onset audio ke tick begitu saja: pada 120 BPM /
48 kHz, 1 tick = 25 sample, sehingga rounding bisa menggeser hingga sekitar
12,5 sample dan merusak null-test. Simpan `SampleAnchor` integer untuk audio
lama (onset dan durasi absolut), plus tick untuk editing musikal. Audio baru
memilih timebase `absolute` atau `musical`; sumber tetap dalam source sample.
Pada tempo asal, migrasi mempertahankan onset, durasi, routing, dan suara.

Project v2 tidak bisa dibuka oleh aplikasi lama; itu perilaku yang sudah ada
(`d.version !== SCHEMA_VERSION → null`) dan pesan "file dari versi lebih baru"
sudah ada di `model.rs`.

---

## 7. Fase

Setiap fase punya branch sendiri, masuk ke `main` lewat PR yang diverifikasi
(tes lolos, definisi "done" terpenuhi). Yang tidak saling bergantung
dikerjakan **bersamaan**.

```
F0 engine realtime ──┐
                     ├─► F2 sequencer engine ──┬─► F3 Channel Rack ─┐
F1 model v2+migrasi ─┘                        ├─► F4 Playlist ─────┼─► F7 synth ─► F8 rilis page
                                              ├─► F5 Piano Roll ───┤
                                              └─► F6 Mixer ────────┘
```

### F0 — Engine realtime Composer (paralel dengan F1)

Harness Composer memutar fixture audio legacy lewat `EngineClient` + worklet
untuk dibandingkan dengan export. Jalur playback Studio tidak diubah.

**Done:**
1. Project 8 lane × 5 clip dengan fade, gain, EQ, dan speed dimainkan lewat
   worklet; rekaman realtime (loopback `MediaStreamDestination` di tes
   integrasi) dibandingkan dengan bounce export: residual < −100 dBFS.
2. Play/pause/seek/loop, mute/solo, fader, EQ live tanpa klik; underrun 0 di
   laptop kelas menengah selama 5 menit (counter SAB yang ada).
3. Mode `st` (desktop macOS `tauri://`, docs/20) tetap berbunyi; degradasi
   yang ada tidak bertambah.

### F1 — Model v2, skema, migrasi, mirror TS (paralel dengan F0)

`timeline-core` §3, `schema/project.schema.json` v2, `migrate` §6, tipe TS
§5a. Store Composer membaca format Composer di balik feature flag;
store dan UI Studio tetap membaca format existing tanpa migrasi otomatis.

**Done:**
1. Property test: `normalize(migrate(v1))` untuk 200 project v1 acak tidak
   panik dan semua invariant §3 terpenuhi.
2. 20 fixture project v1 yang ada di tes: bounce sebelum migrasi vs sesudah
   (lewat export) residual < −100 dBFS dengan onset/durasi integer sample identik (§6);
   tanpa DSP dan perubahan urutan summing, wajib bit-exact.
3. Roundtrip JSON v2 → struct → JSON identik; postcard v2 dibaca engine.

### F2 — Sequencer di engine

§4 seluruhnya kecuali synth: kompilasi event, pertukaran snapshot, opcode
baru, sampler pitch, PAT/SONG, swing, `render_insert`.

**Done:**
1. Pattern 1 bar, kick di step 1/5/9/13, 120 BPM, 48 kHz, mode PAT, bounce 4
   bar: onset terdeteksi tepat di sample 0, 24000, 48000, … (toleransi 0).
2. Swing memakai nilai normalisasi 0..1. Pada 50% (0.5), setiap step
   selang-seling bergeser 0.5 × 240/2 = 60 tick: 1.500 sample pada
   120 BPM / 48 kHz. Uji juga swing 0 dan 1, tanpa drift di batas loop.
3. Sampler `key = root + 12` menghasilkan spektrum yang puncaknya 2× (uji
   FFT pada sine asset).
4. Realtime vs offline null-test untuk song 8 bar dengan 4 pattern clip + 2
   audio clip: residual < −100 dBFS.
5. Mengganti snapshot 20× per detik selama playback: tidak ada alokasi di
   `process()` (tes zero-alloc yang ada), tidak ada underrun, posisi playhead
   monoton.
6. `NOTE_ON` dari ring berbunyi dalam ≤ 1 blok (128 sample).

### F3 — Channel Rack (paralel dengan F4, F5, F6)

**Done:**
1. Seret asset dari Browser → channel Sampler baru; klik pad → berbunyi
   (`NOTE_ON`) tanpa transport.
2. Toggle 16 step, PAT mode play → berbunyi sesuai; kolom step yang sedang
   main mengikuti playhead SAB tanpa `setState` (rAF, aturan docs/08).
3. Knob vol/pan channel → `SET_CHANNEL_*` live; mute LED dan solo bekerja.
4. Pattern selector: buat, ganti nama, clone, pindah; duplicate selection
   memakai Ctrl+B sesuai konteks editor, bukan mengganti pattern.
5. Graph editor velocity per step; velocity tampil di piano roll sebagai
   tinggi bar.
6. Smoke test jsdom + tes interaksi pointer seperti `studio/__tests__`.

### F4 — Playlist Composer (panel baru)

**Done:**
1. Draw/Paint pattern aktif di track mana pun; pattern clip menampilkan
   pratinjau not mini; mengubah pattern memperbarui semua clip-nya.
2. Audio clip: semua kemampuan §5c tetap lolos tes yang ada (`clip-trim`,
   `clip-snap` dalam tick, `fade`, `envelope`, `beat-cut`, `stem`, marquee,
   `wheel-zoom`), dipindah ke `studio/playlist/`.
3. Ruler bar:beat, snap Line/Cell/Step/Beat/Bar/None, loop range SONG.
4. 99 track × 200 clip: scroll/zoom ≥ 55 fps (angka M5 docs/09).
5. Slip tool menggeser `offset`/`source_start` tanpa memindahkan clip.

### F5 — Piano Roll

**Done:**
1. Gambar/hapus/geser/ubah panjang not dengan snap; not tampil sebagai step
   di Channel Rack bila jatuh di grid step.
2. Ghost not channel lain dalam pattern yang sama (redup, tidak bisa dipilih).
3. Lajur velocity; seret mengubah velocity yang terdengar (uji: bounce dua
   velocity → rasio amplitudo sesuai).
4. Klik tuts keyboard kiri → `NOTE_ON/OFF` channel itu.

### F6 — Mixer

**Done:**
1. Insert 0 Master + N insert; memilih channel menyorot insertnya; klik
   insert pada channel terpilih → routing berubah dan terdengar.
2. Setiap insert: EQ 4 band (komponen yang ada), 4 slot FX dari registry,
   fader, pan, mute, meter dari SAB.
3. Dengan FX bypass dan pan/gain unity, routing satu vs dua insert
   mempertahankan hasil dalam toleransi f32 yang ditetapkan. Compressor,
   saturasi, limiter, dan FX stateful diuji terpisah: FX(a+b) tidak harus
   sama dengan FX(a)+FX(b).

### F7 — Synth sederhana + keyboard mengetik

**Done:**
1. Channel Synth (saw/square/sine, ADSR, polifoni 16) dimainkan dari piano
   roll; `NOTE_OFF` memasuki release, stealing tetap benar.
2. Keyboard mengetik (§5d) memainkan channel terpilih; oktaf ±.
3. Realtime vs offline null-test untuk song dengan synth: residual < −100
   dBFS (fase osilator harus deterministik dari sample absolut).

### F8 — Integrasi dan rilis halaman Composer alpha

**Done:**
1. Menu Composer membuka `/composer`; direct navigation, back/forward dan
   refresh route memulihkan halaman yang benar. Studio dan DJ tetap tersedia.
2. `apps/desktop` memuat `packages/composer` untuk route baru dan tetap
   memuat `packages/studio` untuk `/studio`; panel/lane/preview Studio
   tidak dihapus. Composer tidak bergantung pada store/preview Studio.
3. Uji Studio → Composer → DJ → Studio: project, undo, autosave dan pilihan
   aset masing-masing tidak tercampur; tidak ada audio ganda/listener bocor.
4. Import from Studio menghasilkan project Composer baru; file asal tetap
   bisa dibuka di Studio dengan hasil audio yang sama.
5. Asset-root Composer diuji terhadap prune dari Studio/DJ. Build dan tes
   regresi web, desktop, Studio dan DJ lolos; dokumentasi memakai nama Composer.

---

## 8. Cakupan hasil review dan riset

Target adalah kesetaraan **workflow utama**, bukan menyalin seluruh plugin,
format project `.flp`, atau layanan Image-Line. Referensi lintas edisi: fitur
recording, editing, dan plugin tertentu tidak tersedia sama di setiap edisi
([perbandingan resmi](https://www.image-line.com/fl-studio/compare)).
Prioritas di bawah adalah keputusan produk DawOnWeb berdasarkan riset.

| Area referensi FL | Gap plan awal | Target konkret | Fase / prioritas |
|---|---|---|---|
| Channel Rack / step sequencer | Fondasi sudah direncanakan | Multi-bar, panjang channel independen, fill every N, swing per-channel, mute/solo, clone, velocity/pan graph | F3 + F12 / utama |
| Pattern workflow | Belum lengkap | PAT/SONG, shared pattern, make unique, split by channel, merge, rename/color, picker preview | F3–F5 / utama |
| Piano Roll | Hanya edit dasar | Marquee, duplicate, transpose, quantize strength, triplet, scale highlight, chord stamp, ghost notes, velocity/pan, legato | F5 / utama |
| Piano Roll lanjutan | Tidak ada | Arpeggiate, strum, humanize dengan seed, chop/glue, portamento/slide untuk instrumen yang mendukung | F12 + F15 / lanjutan |
| Playlist | Fondasi ada | Audio/pattern/automation, slip/slice/stretch, group/lock, marker, make unique, consolidasi selection | F4 + F9 + F12 + F14 / utama |
| Automation | Ditunda | Clip envelope, kurva, create automation dari parameter, record knob, read/touch/latch, undo | F9 / wajib produksi |
| Rekam MIDI | Ditunda | MIDI device, note/velocity, sustain, pitch bend, CC, count-in, overdub/replace, input quantize opsional | F10 / wajib produksi |
| Rekam audio | Di luar plan | Arm input, monitoring, metronome, count-in, punch/loop takes, kompensasi input latency | F10 / wajib produksi |
| Mixer | Hanya 4 FX dan master | Bus/group, send level, sidechain detector, solo-safe return, wet/dry, reorder/bypass, PDC | F11 / wajib produksi |
| Sampler / drum tools | One-shot sederhana | ADSR, root/tune, reverse, loop points, choke groups, slice-to-notes, drum presets | F12 / wajib produksi |
| Audio editor | Trim/split saja | Crop, normalize, reverse, fade, transient slice; edit menghasilkan asset turunan dan undo | F12 / wajib produksi |
| Stretch / warp ala NewTime | Varispeed saja | Tempo sync tanpa perubahan pitch, pitch tanpa perubahan durasi, warp markers | F12–F13 / wajib produksi |
| Pitch editing ala NewTone | Tidak ada | Deteksi not monofonik, koreksi pitch/formant, render turunan | F15 / lanjutan |
| Tempo dan meter | 4/4 konstan | Tempo points/ramp, meter changes, metronome/ruler konsisten | F13 / wajib produksi |
| Browser dan preset | Library reuse | Search/tag/favorite, preview sync tempo, recent, missing-file relink, preset instrument/FX chain | F3 + F12 + F14 / utama |
| Export dan project | Reuse disebut, workflow kurang | Master/stems, range/tail, WAV/FLAC/MP3/OGG, MIDI, collect assets, autosave/recovery | F14 / wajib produksi |
| Stem separation | Sudah ada pipeline | Integrasikan ke Playlist baru, progress/cancel, alignment hasil dan provenance asset | F4 + F12 / reuse |
| Instrumen dan FX | Synth minimal + registry | Subtractive synth, drum sampler; EQ/comp/limiter/reverb/delay/filter/distortion/chorus; preset | F7 + F11–F12 / utama |
| Plugin eksternal | Ditunda tanpa jalur | VST3 native; AU macOS kandidat setelah feasibility; scan/state/crash isolation | F16 / lanjutan |
| Patcher / Performance Mode | Tidak ada | Graph instrument/FX/macros; clip launching quantized dan rekam arrangement | F17 / lanjutan |
| Cloud, remote, AI assistant | Tidak ada | Backlog opsional setelah workflow lokal lengkap | Bukan gate produksi |

Dasar workflow: [manual workflow](https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/basics_workflow.htm),
[Playlist](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm),
[Piano Roll tools](https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/pianoroll_menu.htm).
Ketiganya menjadi referensi fungsi; interaksi DawOnWeb tetap menyesuaikan panel dok.

## 9. Koreksi kontrak sebelum F1/F2 diimplementasikan

Bagian ini memperluas sketsa §3–§5; sketsa itu belum merupakan skema final.

1. **Lindungi Studio web/desktop dan DJ.** `packages/composer` mempunyai store/model UI
   desktop sendiri; jangan mengubah `packages/studio/src/studio/store.ts`
   menjadi v2 secara global. Decoder Rust membaca versi lama dan baru;
   compiler menurunkan keduanya ke render IR bersama. Model lane legacy
   tetap tersedia bagi web. Penghapusan tipe lama pada §3 hanya berlaku di
   model Composer, bukan API bersama yang masih dipakai web.
2. **Path aktual.** Rujukan `web/src/studio` di bagian awal adalah historis:
   UI lane ada di `packages/studio/src/studio`, asset/waveform/import di
   `packages/studio-core/src`, engine client/worklet/export di
   `packages/engine/src`, shell di `packages/shell`. Jangan membuat jalur
   import baru ke folder historis. Verifikasi docs/25 P2 dan dependensi P4
   di checkout target sebelum mulai; status branch bukan bukti merge/rilis.
3. **Routing migrasi.** Asset sama pada dua lane dengan FX/gain berbeda
   harus menghasilkan channel berbeda. PCM boleh tetap dedup. Simpan solo,
   pan, send, mute dan semua per-clip FX; contoh `Insert` §3 perlu `soloed`
   serta referensi send. Buat fixture khusus kasus ini.
4. **Presisi waktu.** PPQ 960 adalah pilihan kita. `SampleAnchor` menjaga
   audio legacy. Tambahkan `timebase`, `TempoPoint`, `MeterPoint` sejak F1;
   perubahan tempo pada audio absolute tidak memindahkan onset sample,
   audio musical mengikuti tick. Panjang audio musical dikendalikan mode
   stretch; jangan otomatis mengubah pitch. Ganti `len_bars` internal dengan
   `length_ticks` agar meter dan pattern non-satu-bar dapat diwakili.
5. **Identitas.** Note perlu ID stabil; event membawa channel, note ID dan
   instance clip, agar dua clip dari pattern sama tidak saling mematikan not.
   Urutan event sample sama ditetapkan (off sebelum on untuk retrigger).
   Seek/stop/switch PAT–SONG dan disconnect harus melepas not/sustain;
   define chase envelope/automation dan kebijakan note yang melintasi loop.
6. **Sampler.** `one_shot` mengabaikan note-off; `gated` mengikuti envelope.
   `cut_self`/choke group mematikan voice terkait saat trigger baru, bukan
   pengganti note-off. Audisi pad dipisah dari edit step.
7. **Snapshot.** Tetapkan generation/ack dan reclamation arena di non-audio
   thread; jangan menimpa arena yang masih dibaca voice/render. Snapshot
   overflow ditolak dengan error recoverable. Jalur ST menggunakan payload
   bounded tanpa Atomics/SAB; buktikan no-allocation pada render. Snapshot
   aktif di batas blok, event masa lalu tidak diputar ulang; trigger yang
   sudah terlewat menunggu loop berikutnya. Uji delete channel aktif.
8. **Automation.** Tambahkan ID parameter stabil, target channel/insert/FX,
   clip curve + points tick, nilai default dan mapping normalized→unit.
   Tentukan overlap (prioritas track lalu ID stabil), manual override,
   nilai saat seek, recording mode, smoothing, dan bypass. Tempo automation
   masuk tempo map compiler, bukan ditulis sembarang ke knob audio.
9. **Mixer capacity.** Engine saat review: `MAX_BUSES=8`, `MAX_SENDS=4`,
   `MAX_CHAIN_LEN=4` di `crates/engine/src/snapshot.rs`. Jangan memetakan
   seluruh insert langsung ke 8 bus. F11 mendesain kapasitas/graph dan
   versioning SAB; target 64 insert × 10 FX adalah budget produk yang perlu
   benchmark, bukan kapasitas yang sudah tersedia. Tolak feedback cycle
   pada rilis awal dan bedakan audible send dari sidechain input.
10. **Tes yang valid.** Null-test menangkap PCM sebelum perangkat output,
    dengan sample alignment, sample rate/seed identik, warmup/tail dan
    dither dimatikan. Loopback hardware tidak punya jaminan null −100 dBFS.
    PDC diuji pakai impulse di jalur berbeda. Latensi ≤1 blok hanya dari
    event diterima engine ke proses render, bukan dari klik ke speaker.
    Target FPS/xrun harus mencatat mesin, OS, buffer, sample rate, fixture.

Perubahan API/skema/SAB wajib didahului pembaruan docs/00, docs/01,
schema project dan bridge. Jangan menggunakan revisi dokumentasi ini
sebagai klaim bahwa implementasi, benchmark, atau migrasi sudah lulus.

## 10. Fase lanjutan dan release gate

Urutan: **F0+F1 → F2 → F3/F4/F5/F6 → F7 → F8 (alpha)**.
F9 bergantung F2/F4/F6; F10 bergantung F7/F9; F11 bergantung F6/F9;
F12 bergantung F4/F7; F13 bergantung F9/F10/F12; F14 menyatukan F9–F13.
F15–F17 menyusul setelah gate produksi. Pekerjaan independen boleh paralel
sesuai aturan repo saat implementasi; estimasi kalender dibuat setelah spike
F0, recording, stretch dan graph selesai, bukan dari jumlah panel.

### F9 — Automation yang bisa dipakai produksi

Buat automation dari parameter yang dipilih/last tweaked; point/curve editor,
copy/paste, duplicate/make unique, record movement, undo, read/touch/latch.
Event automation pattern dapat dikonversi ke clip. **Done:** sweep filter,
volume dan wet/dry kembali sama setelah save/reopen dan seek di tengah;
realtime/offline residual < −100 dBFS pada fixture deterministik; overlap dan
manual override punya tes, parameter hilang ditampilkan sebagai unresolved.
Referensi: [Event Editor](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/automation_eventeditor.htm).

### F10 — Recording audio dan MIDI

Spike input/output device dan clock lebih dulu. Gunakan kontrak host untuk
MIDI/audio capture desktop; Web MIDI hanya bila runtime benar-benar mendukung,
karena [Web MIDI](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API)
bukan baseline lintas browser. Pisahkan adapter OS dari package Studio.

Audio: input mono/stereo, arm, level, monitoring off/on, count-in/metronome,
punch range, loop take lanes dan pilih potongan take (comp sederhana).
MIDI: note, velocity, sustain, CC learn, pitch bend, overdub/replace,
quantize saat rekam opsional dan simpan timing mentah untuk undo.
Tulis PCM bertahap di worker/native writer, jangan mengumpulkan rekaman panjang
seluruhnya di RAM. Rekaman selesai menjadi asset + audio clip otomatis.

**Done:** rekam audio 10 menit tanpa lost frame, cancel/kehabisan disk/perangkat
tercabut menyelamatkan take parsial; loopback terkalibrasi selisih ≤1 ms pada
mesin uji. MIDI timestamp ke engine diuji terpisah dari latency hardware;
sustain/retrigger/disconnect tidak menyisakan stuck note. Take dan edit comp
pulih setelah restart. Input permission ditolak menghasilkan status actionable.
Referensi: [Recording](https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/recording.htm),
[audio recording](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/recording_audio.htm).

### F11 — Mixer produksi dan latency compensation

Implementasikan bus/send, pre/post fader sebagai pilihan produk, sidechain
compressor, routing graph tanpa siklus, chain reorder, wet/dry dan preset.
Tambahkan limiter, saturation/distortion, chorus bila belum ada di registry;
fitur disebut selesai hanya setelah DSP dan UI keduanya berfungsi.
Setiap node melaporkan latency/tail untuk PDC dan export.

**Done:** kick men-duck bass tanpa suara kick bocor lewat sidechain; return
reverb tetap benar saat solo-safe; impulse paralel sejajar ≤1 sample setelah
PDC. Perubahan routing/latency tidak klik. Ukur target 64 insert × 10 slot
(pakai kombinasi FX yang dinyatakan, bukan asumsi seluruh FX berat) dengan
xrun 0 selama 10 menit; jika gagal, tetapkan limit hasil ukur secara eksplisit.
Referensi: [Mixer](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/mixer.htm),
[PDC](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/mixer_trackprops.htm).

### F12 — Sampling, instrumen, audio editing dan stretch

Lengkapi sampler/drum rack dan tool Piano Roll pada matriks; preset mencakup
kick/snare/hihat, bass, pad dan lead dengan aset yang boleh didistribusikan.
Editor menghasilkan asset turunan, menyimpan sumber dan recipe edit.
Slice ke pad/not, reverse, normalize, loop/choke, envelopes dan tuning.
Stretch berkualitas dikerjakan worker/native job dengan cache berversi;
preview dan export memakai PCM hasil job yang sama. Jangan mengganti tempo
preserving-pitch dengan playbackRate. Stem separation reuse pipeline yang ada.

**Done:** loop 100 BPM masuk project 128 BPM, durasi tepat dalam ≤1 sample
pada panjang target; sine uji mempertahankan pitch ±5 cent. Materi drum/vokal
ikut listening test untuk transient/smearing, bukan hanya sine. Cancel,
cache invalidation, undo, reopen dan missing source tidak merusak asset asli.
Referensi: [NewTime](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Newtime.htm).

### F13 — Tempo map, meter map, warp

Tempo points/ramp dan perubahan 4/4→3/4; warp marker source sample→tick.
Bangun konversi absolut teruji, jangan menjumlah pembulatan per beat.
**Done:** song 120→140 BPM dengan perubahan meter, pattern, automation dan
rekaman tetap sinkron; roundtrip tick/sample ≤1 sample pada domain yang
representable. Audio absolute tetap pada sample asal, audio musical mengikuti
map, waveform dan export cocok; undo mengembalikan semua anchor.

### F14 — Project, export dan release produksi

Autosave/version history/recovery sejak fondasi; fase ini menjadi gate ketahanan.
Portable project dengan collect assets, relink file hilang, preset/metadata,
MIDI import/export, consolidate/freeze/unfreeze dan render master/stems.
WAV 16/24/32-float, FLAC/MP3/OGG memanfaatkan encoder yang tersedia setelah
verifikasi capability; pilih range, sample rate, dither, normalization dan
cut/leave tail secara eksplisit. Stem per insert memasukkan dependensi sidechain;
shared return dan nonlinear master diberi opsi render yang jelas.

**Done:** project dipindah ke mesin lain dan berbunyi sama; paksa crash saat
save tidak merusak versi terakhir; freeze/unfreeze memenuhi null-test.
Stem sejajar sample dan panjang/tail sesuai; penjumlahan stem hanya wajib
null terhadap master untuk fixture linear tanpa master nonlinear/shared return
yang terhitung dua kali. Reimport MIDI menjaga not/tempo/meter yang didukung;
fitur tak terwakili dilaporkan. Tidak menjanjikan buka/simpan `.flp`.

Gate user: buat beat dari nol → bass/chord → susun lagu → rekam vokal/MIDI →
edit timing → automation build-up → sidechain dan mix → export master/stems →
save/reopen. Seluruh alur wajib lulus di desktop macOS dan Windows yang ditargetkan.
F8 hanya alpha beat-maker; label produksi lengkap menunggu F14.

### F15–F17 — Perluasan setelah produksi stabil

- **F15:** pitch correction monofonik/formant, Piano Roll generators lanjutan,
  multisample/velocity layers dan modulation matrix. Gate: undoable edit,
  preset roundtrip, deterministic bounce dan listening test vokal.
- **F16:** spike VST3 native terlebih dulu: realtime + offline host, GUI,
  scan/quarantine, state save/restore, parameter automation, MIDI, latency,
  multi-output dan crash isolation. AU hanya setelah jalur macOS terbukti.
  Bukan janji menjalankan plugin desktop di AudioWorklet WASM. Gate minimal:
  satu instrumen dan satu efek dari vendor berbeda, restore project dan
  crash terisolasi tanpa kehilangan project; plugin nondeterministik punya
  toleransi tes tersendiri. Evaluasi SDK, lisensi dan packaging saat spike.
- **F17:** patch graph/macros dan performance clip launcher dengan quantized
  launch/stop, scene, controller mapping dan record performance ke Playlist.
  Gate: launch tepat batas bar, tidak stuck note, arrangement rekaman memutar
  urutan event yang sama. `/dj` tetap produk terpisah.

## 11. Sumber dan batas riset

Ditinjau 10 September 2026 dari dokumentasi resmi; tidak memakai rumor versi
atau menganggap semua edisi punya plugin yang sama. Link inline §8–§10 adalah
sumber fungsi pembanding. Angka kapasitas/performa dan fase DawOnWeb adalah
usulan engineering, bukan spesifikasi FL Studio.

- [FL Studio features](https://www.image-line.com/fl-studio/features): cakupan
  umum produksi, mixing, recording dan stem separation.
- [Compare editions](https://www.image-line.com/fl-studio/compare): perbedaan
  edisi, instrumen/efek serta alat audio editing; bukan target harga produk ini.
- [Piano Roll](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm):
  not, channel, scale dan hubungan dengan pattern.
- [Plugin Wrapper](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/wrapper.htm):
  acuan kebutuhan integrasi plugin, routing dan sidechain.
- [AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet):
  pemrosesan audio di thread terpisah; dukungan runtime tetap harus diuji.

Review kode lokal terbatas pada struktur paket, dokumen arsitektur dan konstanta
engine; bukan audit implementasi seluruh fitur. Tes/build tidak dijalankan
untuk revisi plan ini. Checklist done di atas baru dijalankan saat implementasi.
