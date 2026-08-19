# 03 — Tata letak & peta komponen

Format tabel mapping-nya meniru [`docs/08-ui-mapping.md`](../docs/08-ui-mapping.md):
kolom **State** menjawab *di mana kebenarannya hidup*.
`DJ` = `web/src/dj/store.ts` · `STUDIO` = `studio/store.ts` (kepustakaan asset) ·
`TURUNAN` = dihitung di `deck-view.ts`/`model.ts`, tidak disimpan di mana pun ·
`UI` = state React murni.

---

## Lima baris, 100vh, tidak menggulir

```
auto              header  (judul · MASTER · QUANTIZE · badge status · tutup)
minmax(…,18vh)    waveform besar dua deck, bertumpuk
minmax(0,1fr)     DECK A · MIXER · DECK B     ← satu-satunya yang melar
auto              Beat FX + baris status
minmax(…,24vh)    Collection                  ← satu-satunya yang menggulir
```

`StudioLayout` sengaja membiarkan dokumen menggulir supaya toolbar `sticky`-nya
bekerja. Di sini itu salah, dan tiga alasannya berdiri sendiri-sendiri:

1. Selama mixing, tangan tidak bisa mencari kontrol di luar layar. Tombol yang
   perlu digulir untuk dicapai sama saja tidak ada.
2. `ScrollingWave` memetakan `windowLen` ke LEBAR canvas. Ukuran yang berubah
   saat halaman digulir mengubah skala px-per-detik **di tengah mix** — mata
   kehilangan acuan yang justru jadi seluruh guna tampilan itu.
3. `wheel` di atas jog atau fader akan menggulir halaman alih-alih menggerakkan
   kontrolnya.

**`minmax(0, …)` ada di setiap baris dan kolom**, `minHeight: 0` di setiap anak.
Alasannya sama dengan catatan di `StudioLayout.tsx`, tapi gejalanya di halaman
`overflow: hidden` lebih buruk: isinya terpotong **tanpa scrollbar**, jadi tidak
ada petunjuk apa pun bahwa ada yang hilang. Dijaga `dj-layout.test.tsx`.

### Degradasi

Tidak ada media query — seluruh styling repo ini objek `CSSProperties` inline.
`useViewport()` mengembalikan **primitif** `'compact' | 'normal' | 'tall'`
(<700 / 700–899 / ≥900); mengembalikan `innerHeight` mentah akan me-render
halaman di setiap piksel tarikan jendela.

Urutan yang dikorbankan: overview lagu-penuh dan browser menyusut lebih dulu,
lalu browser runtuh. **Pad, fader, dan jog tidak pernah menyusut** — itu sasaran
sentuh, dan mengecilkannya membuat alatnya salah sasaran, bukan lebih ringkas.
Di bawah 560 px tinggi dan 1024 px lebar, halaman **mengatakannya** lewat badge,
bukan menata ulang diam-diam.

---

## Deck adalah SATU komponen, dirender dua kali

Pencerminan dinyatakan hanya lewat tiga hal: `flexDirection` (`row` ↔
`row-reverse`), `textAlign`, dan satu CSS variable `--dj-deck-accent` yang diset
di elemen akar deck sehingga seluruh anak DOM cukup menulis
`var(--dj-deck-accent)` tanpa tahu ia deck mana. Satu helper `mir(a, b)` dipakai
untuk SELURUH pencerminan; dua tempat pasti menyimpang saat tata letak berubah.

**`transform: scaleX(-1)` tidak dipakai, dan itu bukan selera.** Ia membalik
teks, membalik arah drag (fader tempo jadi terbalik tanpa satu baris kode yang
mengatakannya), dan membuat `getBoundingClientRect` di `useDrag` menghasilkan
fraksi terbalik — bug yang hanya muncul di satu deck dan mustahil ditebak dari
kodenya.

Canvas tidak bisa membaca custom property CSS dengan murah, jadi `accent` tetap
diteruskan sebagai prop — **tapi hanya ke penggambar canvas**.

`ChannelStrip` **tidak** dicerminkan: di mixer sungguhan pun kedua strip identik,
yang berbeda hanya labelnya.

---

## Peta komponen

| Berkas | Isinya | Memakai ulang |
|---|---|---|
| `DjPage.tsx` | tick, muat kepustakaan, daftar akar retensi, susun lima baris | `loadLibraryIntoStore`, `registerAssetRoot` |
| `layout/DjLayout.tsx` | grid 100vh | — |
| `layout/useViewportBand.ts` | pita tinggi/lebar sebagai primitif | — |
| `header/DjHeader.tsx` | judul, MASTER, QUANTIZE, badge jujur, tutup | `ui/cyber` |
| `wave/WaveRow.tsx` | dua jendela bergeser, bertumpuk | — |
| `wave/DeckScrollingWave.tsx` | **adaptor** DeckView → props ScrollingWave | `studio/timeline/ScrollingWave` |
| `wave/DeckOverview.tsx` | lagu penuh + penanda cue/loop + posisi | `drawAssetWave`, `useCanvasDraw` |
| `deck/Deck.tsx` | susunan satu deck; pencerminan | — |
| `deck/DeckReadout.tsx` | judul, waktu, KEY, BPM | `formatDeckTime` |
| `deck/DeckTransport.tsx` | CUE (pointerdown/up) + PLAY | — |
| `deck/DeckTempo.tsx` | fader, rentang, MT (mati), SYNC, MASTER | `mixer/Fader` |
| `deck/DeckPads.tsx` | 8 pad × 4 mode | — |
| `deck/DeckLoop.tsx` | IN/OUT/EXIT‑RELOOP/÷2/×2/Q | `ui/cyber/Button` |
| `deck/Jog.tsx` | piringan, cincin posisi, BPM besar | `useCanvasDraw`, `useDrag` |
| `mixer/MixerSection.tsx` | dua strip + master + crossfader | — |
| `mixer/ChannelStrip.tsx` | TRIM → EQ → COLOR → CUE → fader | — |
| `mixer/Knob.tsx` | knob rotari | **pola** `ui/panels/PluginKnobs.tsx`, `useDrag` |
| `mixer/Fader.tsx` | fader tegak & mendatar (satu komponen) | `useDrag` |
| `mixer/Crossfader.tsx` | crossfader + pembacaan gain | `crossfaderGains` |
| `mixer/LevelMeter.tsx` | skala kosong `NO SIGNAL` | — |
| `fx/BeatFxBar.tsx` | Beat FX dari katalog Rust + baris status | `useFxCatalog`, `fx-catalog` |
| `browser/CollectionBrowser.tsx` | daftar lagu + drop zone | `studioStore.assets` |
| `browser/collection.ts` | saring + urut (murni) | `resolveBeatGrid` |
| `browser/dj-import.ts` | drop → asset → deck | `importFileToAsset` |

`Knob` menyalin **pola** `PluginKnobs.tsx`, bukan komponennya: berkas itu terikat
store lama `src/state/**` yang `store-adapter.ts` sendiri sebut sebagai "sisa UI
lama yang sedang dirombak".

---

## Mapping elemen rekordbox → model → aksi → state

### Deck

| Elemen rekordbox | Data model | Aksi | State |
|---|---|---|---|
| `▶/‖` | `DeckState.playing` | `togglePlay` | DJ |
| `CUE` | `TrackCues.cuePoint`, `DeckState.cueHeld` | `cuePress` / `cueRelease` | DJ |
| Jog (scrub) | `DeckState.playhead` | `seek` | DJ |
| Tempo fader | `DeckTempo.fader` | `setTempoFader` | DJ |
| `±6/±10/±16/WIDE` | `DeckTempo.rangePct` | `setTempoRange` | DJ |
| Angka `%` | — | `resetTempo` (klik-ganda) | TURUNAN (`tempoPercent`) |
| `MT` | `DeckTempo.keyLock` | — (**mati**, Utang 2) | DJ |
| `SYNC` | `DeckState.sync` | `applySync` | DJ |
| `MASTER` | `DjState.masterDeck` | `setMasterDeck` | DJ |
| BPM besar | — | — | TURUNAN (`effectiveBpm`) |
| Waktu berjalan/sisa | — | — | TURUNAN (`deckRemainingSec`) |
| `KEY` | — | — | **tidak ada sumbernya** (Utang 1) |
| Pad A–H | `TrackCues.hotCues` | `triggerHotCue` / `clearHotCue` | DJ (per **asset**) |
| `IN`/`OUT` | `LoopState.inAt/outAt` | `setLoopIn` / `setLoopOut` | DJ |
| Beat loop 1/4…32 | `LoopState.beats` | `setBeatLoop` | DJ |
| `÷2` / `×2` | `LoopState.outAt` | `halveLoop` / `doubleLoop` | DJ |
| `EXIT` / `RELOOP` | `LoopState.active` | `exitLoop` / `reloop` | DJ |
| `Q` | `DeckState.quantize` | `toggleQuantize` | DJ |
| Beat grid di waveform | `BeatGrid` | — | STUDIO (`resolveBeatGrid`) |

### Mixer

| Elemen | Data model | Aksi | State |
|---|---|---|---|
| `TRIM` | `ChannelState.trimDb` | `setTrim` | DJ |
| `HI`/`MID`/`LOW` | `ChannelEq` | `setEqBand` | DJ |
| Klik LABEL band | idem | `toggleEqKill` | DJ |
| `COLOR` | `ChannelState.filter` | `setFilter` | DJ |
| `CUE` | `ChannelState.cue` | `toggleCue` | DJ |
| Channel fader | `ChannelState.fader` | `setChannelFader` | DJ |
| Crossfader | `MixerState.crossfader` | `setCrossfader` | DJ |
| Kurva | `MixerState.curve` | `setCrossfaderCurve` | DJ |
| Gain A/B di sisi crossfader | — | — | TURUNAN (`crossfaderGains`) |
| `MASTER` | `MixerState.masterDb` | `setMasterDb` | DJ |
| `CUE MIX` | `MixerState.cueMix` | `setCueMix` | DJ |
| Meter | — | — | **belum ada sumbernya** (`NO SIGNAL`) |

### Beat FX & browser

| Elemen | Data model | Aksi | State |
|---|---|---|---|
| Pilih efek | `FxState.kind` | `setFxKind` | DJ (daftar dari katalog Rust) |
| `CH A`/`CH B`/`MASTER` | `FxState.target` | `setFxTarget` | DJ |
| Pembagian beat | `FxState.beats` | `setFxBeats` (**mati**, Utang 4) | DJ |
| Knob besar | `FxState.level` | `setFxLevel` | DJ |
| `ON/OFF` | `FxState.on` | `toggleFx` | DJ |
| Baris status | `DjState.notice` | `setNotice` | DJ |
| Daftar lagu | — | — | STUDIO (`assets`) |
| Cari | `BrowseState.query` | `setBrowseQuery` | DJ |
| Urut kolom | `BrowseState.sort` | `setBrowseSort` | DJ |
| `A`/`B` per baris | `DeckState.assetId` | `loadDeck` | DJ |
