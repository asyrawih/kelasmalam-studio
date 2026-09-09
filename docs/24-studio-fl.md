# 24 — Studio ala FL Studio: Channel Rack, Pattern, Playlist, Piano Roll, Mixer

Rencana mengganti paradigma Studio dari **"lane = track = mixer channel, clip
menempel ke lane"** menjadi paradigma FL Studio: sumber bunyi adalah
**Channel** di Channel Rack, not/step dikumpulkan dalam **Pattern**, Pattern dan
audio clip disusun bebas di **Playlist**, dan setiap Channel dialirkan ke
**Insert** di Mixer. Lane sebagai konsep dihapus; tidak ada dua paradigma yang
hidup berdampingan.

Dokumen ini adalah keputusan dan fase. Kode datang setelahnya, per fase, lewat
`pengoding` (AGENT.md), dengan fase yang tidak saling bergantung dikerjakan
paralel di worktree terpisah.

> **Lingkup: desktop saja.** Web tetap web — `apps/web` mempertahankan Studio
> lane yang ada hari ini tanpa batas waktu. Studio ala FL dibangun sebagai
> `packages/studio-fl` dan dipakai `apps/desktop`. Pemisahan web/desktop yang
> membuat itu mungkin ada di [docs/25](25-pisah-web-desktop.md); **F0 di sini
> baru dimulai setelah docs/25 P2 selesai**, dan F8 mencabut lane dari
> desktop, bukan dari web. Bagian yang menyebut "Studio" di bawah ini
> berarti Studio desktop, dan bagian yang dipakai bersama dua Studio
> (waveform, import, BPM, stem, export) hidup di `packages/studio-core`
> (docs/25 P4).

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

| Konsep FL Studio | Sekarang di Studio | Sesudah revamp |
|---|---|---|
| **Channel** (sumber bunyi: sampler, audio clip, instrumen) | tidak ada; clip audio langsung di lane | `Channel` di model Rust; jenis `Sampler`, `AudioClip`, `Synth` |
| **Channel Rack** (daftar channel + 16 step per bar) | shell statis `StepSequencer.tsx` | panel nyata, state dari store, step = `Note` panjang 1 step |
| **Pattern** (kumpulan not semua channel) | tidak ada | `Pattern` di model; pattern selector di toolbar; PAT/SONG mode |
| **Playlist** (susunan pattern clip + audio clip di track visual) | timeline per lane, clip terikat lane | `Playlist` dengan `PlaylistTrack` (visual saja) dan `PlaylistClip` |
| **Piano Roll** (not per channel per pattern) | shell statis `PianoRoll.tsx` | panel nyata |
| **Mixer Insert** (slot FX, EQ, volume, pan, routing) | lane punya gain/EQ/chain sendiri | `Insert` di `Mixer`; channel → satu insert; insert 0 = Master |
| **Browser** (kiri) | dok kepustakaan di bawah | sidebar kiri, isi sama |
| **Transport** PAT/SONG, BPM project, posisi bar:beat | speed transport, BPM per-asset | tempo project di `TempoMap`, tampil bar:beat:tick |
| **Lane** | inti UI, 14 ribu baris di `studio/timeline/` | **dihapus**; `PlaylistTrack` hanya baris visual: nama, warna, tinggi, mute, kunci |

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
| 10 slot FX per insert, routing insert → insert bebas | 4 slot (`MAX_CHAIN_LEN`), routing channel → insert → master | Batas engine yang ada; multi-routing masuk utang terbuka §8 |
| Plugin VST/AU, instrumen FL bawaan | Sampler + satu synth osilator sederhana (§7 F7) | Tidak ada jalur plugin di WASM; synth kecil cukup untuk membuktikan jalur not |
| Time signature bebas, tempo automation | 4/4 tetap, tempo konstan per project | `TempoMap` sudah bisa menampung perubahan tempo; UI-nya menyusul (§8) |

---

## 2. Keputusan yang mengikat

### 2a. Sequencer hidup di engine Rust, bukan di Web Audio

Alternatif yang dipertimbangkan: scheduler lookahead di JS
(`AudioBufferSourceNode.start(t)`) untuk channel sampler. Ia cukup akurat untuk
sampel, tapi tidak bisa memainkan synth, tidak bisa menjamin preview ≡ export,
dan membuat "jalur sementara" jadi permanen. **Ditolak.**

Keputusan: jalur realtime Studio dipindah ke `EngineClient` + AudioWorklet
(`web/src/audio/engine-client.ts`, yang hari ini hanya dipakai export dan
tes integrasi). Preview Web Audio dicabut pada fase terakhir (§7 F8).
Prasyaratnya adalah F0: project audio-clip yang ada hari ini harus berbunyi
lewat worklet dan null-test terhadap export sebelum satu not pun ditambahkan.

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
`web/src/studio/model.ts` mengikuti, dan pemetaan UI → engine tetap **hanya**
di `crates/wasm-bridge/src/studio.rs`. Tidak ada tata letak postcard yang
disalin ke TS.

### 2d. Lane dihapus, bukan disembunyikan

`StudioLane`, `LaneHeaders`, `lane-import`, `lane-speed`, `LaneColorModal`,
dan tes-tesnya dicabut di F8. Sebelum itu, kode lane tetap jalan di `main`
supaya branch fase bisa masuk satu per satu tanpa memutus produk. Project
lama dimigrasi (§6), bukan dibaca oleh dua jalur.

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

`Track`, `Clip.track`, dan `Bus` lama dihapus dari model v2. `edit.rs`
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

`web/src/studio/store.ts` (`useSyncExternalStore`) tetap, `StudioState`
berubah bentuk mengikuti §3. `studioActions` bertambah: `addChannel`,
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
| Ctrl+B | pilih pattern berikutnya; Ctrl+Shift+B sebelumnya |
| Ctrl+Shift+C | clone pattern |
| Z X C V B N M , (baris bawah) dan Q W E R T Y U I (baris atas) | keyboard mengetik → `NOTE_ON` channel terpilih, oktaf ±: `,` `.` |

Semuanya lewat `studio/commands.ts` (docs/15) supaya bisa di-remap.

---

## 6. Migrasi project lama (skema 1 → 2)

Konverter di Rust (`timeline-core::migrate`) supaya dipakai persis sama oleh
persist browser (`web/src/studio/persist/persistence.ts`, `SCHEMA_VERSION`
1 → 2), kepustakaan (`library/projects.ts`), dan desktop lokal (docs/21).

| Lama | Baru |
|---|---|
| `Project.tempo_map` (120 konstan) | tetap; tempo project = 120 kecuali user ubah |
| `lane[i]` | `PlaylistTrack[i]` (nama, warna, tinggi) **dan** `Insert[i+1]` (gain, EQ, chain, mute, solo) |
| `lane.speedRatio` | `PlaylistClipKind::Audio.speed_ratio` tiap clip di lane itu |
| `clip` di lane i | satu `Channel{AudioClip, asset}` per asset (dibagi antar clip yang assetnya sama), `insert = i+1`; satu `PlaylistClip::Audio` di track i, `start = sample_to_tick(clip.start)` |
| `masterGainDb`, chain master | `Insert[0]` |

Pembulatan `sample_to_tick` pada 120 BPM / 48 kHz: 1 tick = 26,04 sample,
jadi posisi bisa bergeser ≤ 13 sample (0,27 ms). Diterima dan dinyatakan;
uji null di §7 F1 memakai ambang, bukan bit-exact.

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
F1 model v2+migrasi ─┘                        ├─► F4 Playlist ─────┼─► F7 synth ─► F8 cabut lane
                                              ├─► F5 Piano Roll ───┤
                                              └─► F6 Mixer ────────┘
```

### F0 — Engine realtime menggantikan preview Web Audio (paralel dengan F1)

Studio memutar project **yang ada sekarang** (lane, clip audio) lewat
`EngineClient` + worklet, memakai pemetaan `wasm-bridge/studio.rs` yang sudah
dipakai export. Preview Web Audio masih ada di balik flag untuk perbandingan.

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
§5a. Belum ada UI baru: `store.ts` membaca v2 dan menyajikan proyeksi yang
masih dipakai UI lane, supaya F0/F1 bisa masuk `main` tanpa mengubah layar.

**Done:**
1. Property test: `normalize(migrate(v1))` untuk 200 project v1 acak tidak
   panik dan semua invariant §3 terpenuhi.
2. 20 fixture project v1 yang ada di tes: bounce sebelum migrasi vs sesudah
   (lewat export) residual < −90 dBFS (ambang pembulatan tick §6).
3. Roundtrip JSON v2 → struct → JSON identik; postcard v2 dibaca engine.

### F2 — Sequencer di engine

§4 seluruhnya kecuali synth: kompilasi event, pertukaran snapshot, opcode
baru, sampler pitch, PAT/SONG, swing, `render_insert`.

**Done:**
1. Pattern 1 bar, kick di step 1/5/9/13, 120 BPM, 48 kHz, mode PAT, bounce 4
   bar: onset terdeteksi tepat di sample 0, 24000, 48000, … (toleransi 0).
2. Not yang sama dengan swing 50%: step ganjil bergeser tepat
   `tick_to_sample(1/32 bar)` sample.
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
4. Pattern selector: buat, ganti nama, clone, pindah; Ctrl+B.
5. Graph editor velocity per step; velocity tampil di piano roll sebagai
   tinggi bar.
6. Smoke test jsdom + tes interaksi pointer seperti `studio/__tests__`.

### F4 — Playlist (menggantikan `studio/timeline/`)

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
3. Bounce dua channel ke insert yang sama vs ke dua insert identik: bit-exact.

### F7 — Synth sederhana + keyboard mengetik

**Done:**
1. Channel Synth (saw/square/sine, ADSR, polifoni 16) dimainkan dari piano
   roll; `NOTE_OFF` memasuki release, stealing tetap benar.
2. Keyboard mengetik (§5d) memainkan channel terpilih; oktaf ±.
3. Realtime vs offline null-test untuk song dengan synth: residual < −100
   dBFS (fase osilator harus deterministik dari sample absolut).

### F8 — Cabut lane dan preview Web Audio dari desktop, dokumen

**Done:**
1. `apps/desktop` tidak lagi mengimpor `packages/studio` (lane) maupun
   preview Web Audio; `ui/panels/*` shell lama dan flag F0 dihapus.
   `packages/studio` tetap utuh untuk `apps/web`.
2. docs/06, 07, 08, 09, 12, 13 diperbarui: "lane/track" → channel / insert /
   playlist track; docs/08 §8c dihapus (bukan lagi DITUNDA).
3. Desktop (docs/20) dan `/dj` tidak tersentuh dan tesnya lolos.

---

## 8. Utang yang dinyatakan terbuka

Bukan bagian dari rencana ini, dicatat supaya tidak diminta diam-diam:

- **Automation clip** di playlist (FL) — model `Automation` sudah ada di
  `timeline-core`; UI dan kompilasi eventnya fase berikutnya.
- **Routing insert → insert, send** — `SendDesc`/`MAX_SENDS` ada di engine;
  UI belum.
- **Perubahan tempo di tengah lagu, time signature ≠ 4/4** — `TempoMap` bisa;
  UI dan Playlist ruler belum.
- **MIDI hardware in** — `NOTE_ON/OFF` sudah menjadi pintu; Web MIDI di
  app-shell (docs/15 "MIDI") menyusul.
- **Plugin VST/AU** — tidak ada jalur di WASM; desktop v2 (cpal, docs/20 §1b)
  mungkin membukanya.
- **Rekam audio** — tidak ada di paradigma ini maupun sebelumnya.
- **Stretch audio clip mengikuti tempo** (FL "stretch" mode) — sekarang hanya
  varispeed; time-stretch ada di docs/07 fase 2.
