# Bagian 9 — Mapping Komponen Design → Data Model → Engine Command

Design source: project Claude Design `4100dc75-…`, file **`DAW Components.dc.html`**
(design system: CyberUI / cyberpunk-dashboard-kit, tema hitam + amber `#ffd400`,
font Rajdhani + JetBrains Mono, sudut notched via `clip-path`).

Aturan implementasi yang mengikat:

1. **Ikuti struktur, styling, dan token dari design file.** Tidak ada improvisasi
   visual. Semua warna lewat variabel `--cy-*` yang disalin persis dari blok
   `<helmet><style>` design file ke `web/src/ui/cyber/theme.css`.
2. Komponen React bersifat **presentational**. Tidak ada logika edit di dalamnya.
   Semua mutasi keluar sebagai command lewat satu hook `useEngineCommands()`.
3. Panel yang butuh performa (waveform, arrangement, meter, analyzer) boleh
   diganti `<canvas>` **di dalam shell Card dari design**, selama hasil visualnya
   sama.
4. Data yang bergerak cepat (meter, playhead, analyzer) **tidak pernah** lewat
   React state — dibaca langsung dari SAB di dalam satu rAF loop bersama dan
   digambar ke canvas.

## k) Tabel mapping

Kolom **State** menjawab: di mana kebenarannya hidup.
`RUST` = `ProjectModel`/`Engine` (lihat [docs/06 §6a](06-timeline-clips.md)),
`SAB` = dibaca langsung dari shared memory tiap rAF,
`UI` = state UI murni yang memang boleh tinggal di React.

### Transport Bar

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| Tombol play/pause (`playIcon`) | `Transport.playing` | `Cmd::Play` / `Cmd::Pause` | RUST |
| Tombol stop `■` | `Transport.playing`, `playhead` | `Cmd::Stop` (pause + seek ke `loop_start` atau 0) | RUST |
| Tombol record `●` | `Transport.recording` | `Cmd::RecordArm` — **fase 3**, di MVP hanya toggle visual + disabled | RUST |
| Tombol loop `⟲` | `Transport.loop_range: Option<(TimelineSample, TimelineSample)>` | `Cmd::SetLoopEnabled` | RUST |
| Display `posLabel` (bar.beat.tick) | `Transport.playhead` → `sample_to_tick(tempo_map)` → bar/beat/tick | (read-only) | SAB (blok TRANSPORT, SeqLock) |
| `bpm` | `TempoMap.segments[i].micros_per_qn` | `Cmd::SetTempo { micros_per_qn }` | RUST |
| Signature `4/4` | `Project.time_signature` | `Cmd::SetTimeSignature` | RUST |
| Key `F min` | `Project.key` — metadata murni, tidak dipakai engine | `Cmd::SetKey` | RUST |
| Badge `REC ARM` (`recTone`) | `Transport.recording` | — (derived) | RUST |
| Badge `METRONOME` | `Project.metronome_enabled` | `Cmd::SetMetronome` — fase 2 | RUST |
| Badge `LATENCY 6.2 ms` | `ctx.baseLatency + ctx.outputLatency` (Web Audio) | — | UI |
| Badge `48 kHz / 24-bit` (header) | `ctx.sampleRate` + `Project.export_bit_depth` | — | UI + RUST |

Catatan: `posLabel` di design berformat `000.4.03`. Konversi
sample → bar.beat.tick memakai `sample_to_tick()` dari `daw-timeline`
([docs/02 §2c](02-dsp-engine.md)), **bukan** aritmetika float di JS.

### Waveform Display (detail satu clip / satu asset)

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| Bar-bar waveform (`waveMain`, 180 `<div>`) | `Asset.pyramid` → **diganti `<canvas>`** | — | RUST (pyramid di WASM memory) |
| Region terang (`left:34%; width:22%`) | `Selection { start, end: TimelineSample }` | `Cmd::SetSelection` | UI (selection murni tampilan sampai dipakai operasi) |
| Garis tengah 0-crossing | konstan visual | — | — |
| Playhead putih (`pos`) | `Transport.playhead` | `Cmd::Seek` saat diklik | SAB |
| Label waktu `0:00 … 0:48` | `Viewport` → detik | — | UI |
| Tombol `ZOOM` | `Viewport.px_per_sample` | — (murni viewport, tidak menyentuh engine) | UI |
| Tombol `FADE IN` | `Clip.fade_in` | `Edit::SetFade { clip, side: In, len, curve }` | RUST |
| Tombol `NORMALIZE` | `Clip.gain` | `Edit::SetGain` — nilainya dihitung dari `Asset.pyramid` peak, **bukan** memodifikasi PCM | RUST |
| Tombol `REVERSE` | `Clip.reversed: bool` (tambahan pada model) | `Edit::SetReversed` — voice membaca cursor mundur; **non-destruktif** | RUST |
| `SEL 00:08.412 → 00:14.006 · 5.594 s` | `Selection` | — | UI |

**Catatan mapping:** design menggambar waveform dengan ~180 `<div>`. Untuk satu
panel itu masih layak, tapi kita tetap memakai canvas supaya jalur kodenya sama
dengan arrangement (satu fungsi `drawWaveform(ctx, pyramid, viewport, color)`),
dan supaya zoom tidak memicu rekonsiliasi 180 node.

### Clip Thumbnail

| Elemen design | Data model | Command | State |
|---|---|---|---|
| Waveform mini (`waveAlt`) | `Asset.pyramid` level tertinggi | — | RUST |
| `KICK_909_A.wav` | `Asset.name` | — | RUST |
| `0.62 s` | `Asset.len / sample_rate` | — | RUST |

### Master Meter

| Elemen design | Data model | Command | State |
|---|---|---|---|
| Bar L/R (`meterL`, `meterR`) | blok METER slot 32 (master): `peak_l/r`, `rms_l/r` | — (audio thread menulis) | **SAB** |
| Label `-6.2 dB` / `-7.8 dB` | `lin_to_db(peak)` | — | SAB |
| Skala `-60 … 0` | konstan | — | — |

Dibaca di rAF loop bersama, ballistics berbasis waktu ([docs/05](05-failure-modes.md)),
digambar ke canvas. Setelah membaca, UI menulis `Atomics.store(ack)` supaya audio
thread me-reset akumulator peak ([docs/07](07-gain-speed.md)).

### Arrangement / Timeline

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| Ruler bar (`ruler`: 1,5,9,…) | `TempoMap` + `Viewport` | — | RUST + UI |
| Baris track (`tracks`) | `Project.tracks: Vec<Track>` | `Cmd::AddTrack`/`RemoveTrack`/`ReorderTrack` | RUST |
| `tr.color` (strip 3px) | `Track.color` | `Cmd::SetTrackColor` | RUST |
| `tr.name` | `Track.name` | `Cmd::RenameTrack` | RUST |
| `tr.kind` (AUDIO/MIDI/GROUP) | `Track.kind: TrackKind` | — | RUST |
| Tombol `M` | `Track.muted` | `Cmd::SetMute { track, on }` | RUST |
| Tombol `S` | `Track.soloed` | `Cmd::SetSolo { track, on }` | RUST |
| Klik lane track (`tr.on`) | `selection.track` | `Cmd::SelectTrack` | UI |
| Clip (`cl.l`, `cl.w`, `cl.label`) | `Clip.timeline_pos`, `timeline_len()`, `Clip.name` | drag → `Edit::MoveClip`, `Edit::TrimLeft/Right` | RUST |
| Waveform mini di dalam clip | `Asset.pyramid` (stride × `speed_ratio`) | — | RUST |
| Grid `repeating-linear-gradient` | `Grid` + `TempoMap` | — | UI (digambar ke canvas) |
| Badge `SNAP 1/16` | `Editor.snap: Grid` | — | UI |
| Badge `GRID: BARS` | `Editor.grid_display` | — | UI |
| Badge `SELECTED: {selId}` | `Selection.clip` | — | UI |
| Hint `DRAG TO MOVE · ALT-DRAG TO DUPLICATE · CMD-L TO LOOP` | — | `Edit::Duplicate`, `Cmd::SetLoopFromSelection` | — |

**Implementasi:** kolom header track tetap DOM (teks, tombol M/S — jarang berubah,
butuh aksesibilitas). Lane clip menjadi **satu canvas** yang mencakup semua track,
dengan virtualisasi + cache per-clip ([docs/06 §6c](06-timeline-clips.md)).
Ghost clip saat drag digambar di canvas overlay terpisah.

### Mixer / Channel Strips

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| `ch.name` | `Track.name` | `Cmd::RenameTrack` | RUST |
| `ch.fx` (`COMP · SAT`) | `Track.insert_chain` → ringkasan nama | — | RUST |
| Knob pan (`ch.knob` rotate, `ch.panLabel`) | `Track.pan: f32` (-1..1) | `Cmd::SetPan { track, value }` | RUST |
| Fader (`ch.top`, drag `ch.onTrack`) | `Track.fader` (travel 0..1) → `fader_to_db` → linear | `Cmd::SetFader { track, travel }` | RUST |
| Level meter di samping fader (`ch.lv`) | blok METER slot `track_index` | — | **SAB** |
| Label `{ch.db} dB` | `fader_to_db(Track.fader)` | — | RUST |
| Tombol `M` (`ch.muteColor`) | `Track.muted` | `Cmd::SetMute` | RUST |
| Tombol `S` | `Track.soloed` | `Cmd::SetSolo` | RUST |
| Strip MASTER | `Project.master: Bus` | `Cmd::SetMasterFader`, `SetMasterPan` | RUST |
| `LIMITER` di master | safety stage ([docs/07](07-gain-speed.md)) | `Cmd::SetSafetyStage { mode }` | RUST |
| `-0.3 dB` master | METER slot 32 | — | SAB |
| `LUFS -9.4` | integrated loudness — **fase 3**, tampilkan `—` di MVP | — | SAB |

**Catatan:** design memakai `onClick` pada track fader untuk men-set level dari
posisi klik. Kita mempertahankan perilaku itu **dan** menambahkan drag dengan
`setPointerCapture` — klik adalah kasus khusus drag dengan delta nol. Nilai
dikirim sebagai `travel` (0..1) mentah; konversi taper terjadi di Rust supaya
UI dan engine tidak bisa berbeda pendapat soal kurva.

### Parametric EQ

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| Kurva `eqPath` (SVG) | `EqBand[4] { freq, q, gain_db, kind }` → magnitude response dihitung dari `Coeffs` | — | RUST (dihitung di Rust, digambar di canvas) |
| Node `eqNodes` (4 titik berwarna) | `EqBand[i].freq → x`, `gain_db → y` | drag → `Cmd::SetEqBand { track, band, freq, q, gain_db }` | RUST |
| Spectrum analyzer (`spectrum`, 48 bar) | FFT dari tap post-EQ | — | **SAB** (blok analyzer, fase 2) |
| Label `30 Hz … 18 kHz` | skala log konstan | — | — |

Kurva EQ digambar dari **magnitude response biquad yang sebenarnya**
(`|H(e^{jω})|` dihitung dari koefisien di `daw-dsp::biquad`), bukan dari
aproksimasi bell seperti di design mock. Ini penting: kurva harus mencerminkan
apa yang benar-benar terjadi pada audio, termasuk interaksi antar band.

Analyzer spectrum adalah **fase 2** dan merupakan hal pertama yang dimatikan
saat CPU tinggi (degradation level 1, [docs/05](05-failure-modes.md)). Di MVP,
render bar statis sesuai design tanpa data.

### Plugin Knobs

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| Knob (`kb.rot`, `kb.pct`) | `FxNode.params[i]: f32` (0..1 normalized) | `Cmd::SetFxParam { fx, param, value }` | RUST |
| Label `DRIVE/TONE/MIX/WIDTH` | `FxDescriptor.param_names` | — | RUST (statis per tipe efek) |

Knob adalah komponen generik: menerima `value: 0..1`, `label`, `format(value)`.
Rotasi `-135°…+135°` persis seperti design (`val * 2.7 - 135`).
Drag vertikal dengan pointer capture; `Shift` = fine mode (÷10);
double-click = reset ke default.

### FX Rack

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| Item rack (`rack`: GATE, COMP 1176, …) | `Track.insert_chain: Vec<FxId>` | `Cmd::AddFx`, `RemoveFx`, `ReorderFx` | RUST |
| Badge dot (`fx.dot`: success/default) | `FxNode.enabled` | `Cmd::SetFxEnabled` | RUST |
| `fx.opacity` (0.45 saat off) | derived dari `enabled` | — | — |
| `fx.val` (`RATIO 4:1`) | ringkasan parameter utama efek | — | RUST |
| Handle `⋮⋮` drag-reorder | urutan `insert_chain` | `Cmd::ReorderFx { track, from, to }` | RUST |
| `+ ADD INSERT` | — | `Cmd::AddFx { track, kind }` | RUST |

**Reorder memicu rebuild `ProcessPlan`** ([docs/02 §2a](02-dsp-engine.md)) —
dilakukan di Rust main-thread instance, plan baru di-swap secara atomik.
Efek yang dipindah **me-reset state DSP-nya** (reverb tail terpotong) — ini
perilaku yang benar dan sama dengan DAW lain, tapi UI harus meng-crossfade
20 ms agar tidak klik.

### Sample Browser

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| Item (`it.name`, `it.meta`, `it.tag`) | `Library.entries: Vec<LibraryEntry>` (OPFS + File System Access) | — | UI (bukan bagian project) |
| Tombol `▶` preview | — | `Cmd::PreviewAsset { asset }` (voice khusus di luar arrangement) | RUST |
| Drag item ke arrangement | — | `Edit::InsertClip { track, pos, asset }` setelah import selesai | RUST |

Library **bukan** bagian dari project model — ia state aplikasi. Drag dari
browser memicu pipeline import ([docs/06 §6b](06-timeline-clips.md)) kalau
asset belum ada di pool.

### Automation Lane

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| Kurva `autoPath` | `Automation { target: ParamRef, points: Vec<AutoPoint> }` | — | RUST |
| Titik `autoPoints` (belah ketupat) | `AutoPoint { at: TimelineSample, value: f32, curve }` | `Edit::AddAutoPoint`, `MoveAutoPoint`, `DeleteAutoPoint` | RUST |
| Judul `filter cutoff` | `ParamRef` yang sedang ditampilkan | `Cmd::SelectAutomationTarget` | UI |

Otomasi di-render engine sebagai **ramp segment**, bukan event per sample
([docs/02 §2c](02-dsp-engine.md)).

### Render / Bounce

| Elemen design | Data model | Engine command | State |
|---|---|---|---|
| ProgressBar `Master · WAV 24-bit`, `value=64` | `ExportJob { rendered, total, stage }` | — (dari export worker via postMessage) | UI |
| Tombol `EXPORT` | `ExportSettings { format, bit_depth, range, dither, normalize }` | `startExport(settings)` → spawn export worker | UI → Worker |
| Tombol `CANCEL` | — | `Atomics.store(flags, EXPORT_CANCEL, 1)` | SAB |
| `ETA 00:11` | EMA throughput dari worker | — | UI |

Ini satu-satunya panel yang **tidak** berbicara ke audio thread sama sekali —
ia berbicara ke export worker ([docs/03](03-export.md)). Perlu diperluas dari
design: dropdown format (WAV/MP3/OGG), bit depth, dan rentang (seluruh project /
selection / loop range). Tambahan ini memakai komponen `Button`/`Badge` yang
sudah ada supaya tetap konsisten dengan design.

### Piano Roll & Step Sequencer — DITUNDA

Kedua panel ini ada di design dan menyiratkan fitur **MIDI**, yang berada di
luar lingkup DAW berbasis audio-clip yang sedang dibangun (BAGIAN 6–8 semuanya
tentang clip audio).

Keputusan: **implementasikan sebagai shell presentational** yang match dengan
design (grid, keyboard, note block, step cell — semuanya statis / state lokal
saja), dengan komentar `TODO(phase-3)` yang menjelaskan bahwa mengaktifkannya
butuh: instrumen sintesis di engine, event MIDI di command ring (`op: NoteOn`
sudah dicadangkan di `Command`), clip tipe MIDI di model, dan voice allocator
polifonik.

Menampilkannya sebagai shell — bukan menyembunyikannya — adalah pilihan sadar:
design menampilkannya, dan menghapusnya akan membuat implementasi tidak match
dengan design file.

## Ringkasan arus state

```
       ┌──────────────── React (presentational) ─────────────────┐
       │  useEngineCommands()  ← SATU-SATUNYA tempat dispatch    │
       │  useProjectSnapshot() ← derived state dari Rust         │
       │  useMeterFrame()      ← satu rAF, baca SAB, gambar canvas│
       └──────┬───────────────────────────────────┬──────────────┘
              │ command                           │ (tanpa React state)
              ▼                                   ▼
       ProjectModel (Rust, main thread)      SAB: METER + TRANSPORT
              │  build_plan()                     ▲
              │  snapshot() ──► export worker     │ ditulis audio thread
              ▼                                   │
        SPSC command ring ─────────────► Engine (audio thread)
```

Tiga aturan yang menegakkannya di kode:

1. Tidak ada `useState` yang menyimpan data project. Lint rule + review.
2. Semua `dispatch` melewati `useEngineCommands()`. Komponen tidak meng-import
   `EngineClient` langsung.
3. Data 60 Hz (meter, playhead, analyzer) tidak pernah menyentuh `setState` —
   digambar langsung ke canvas dari rAF.
