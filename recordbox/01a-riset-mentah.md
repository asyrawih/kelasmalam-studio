> **Catatan repo.** Berkas ini adalah **laporan riset mentah**, sengaja
> dibiarkan dalam bahasa Inggris dan apa adanya, lengkap dengan daftar sumber di
> bagian akhir. Ia BUKAN dokumen keputusan — yang mengikat adalah
> `recordbox/01-fitur-rekordbox.md` dan `recordbox/00-plan.md`.
>
> Sebagian besar isinya adalah **teks manual AlphaTheta secara harfiah**: PDF
> manualnya ter-enkripsi AES sehingga tidak bisa dibaca lewat pengambilan biasa,
> dan didekripsi lokal lebih dulu. Bagian yang TIDAK terverifikasi ditandai
> sendiri dengan ⚠️ di dalam teks — hormati tanda itu.

---

# rekordbox Performance Mode — Research Report for a Web-Based 2-Deck Mixing Page

Research basis: rekordbox 7 (current shipping line as of Aug 2026 is **7.2.18**), official AlphaTheta/Pioneer DJ manuals, plus CDJ-3000X / CDJ-2000NXS2 / DJM-900NXS2 manuals (rekordbox's decks and FX are direct software models of these).

rekordbox convention: on-screen button/menu names are written in `[SQUARE BRACKETS]`.

---

## 1. Top-level layout of PERFORMANCE mode

### 1.1 The five screen layouts

rekordbox 7 advertises **"5 types of screen layout"**. In PERFORMANCE mode the player-mode selector offers:

| Layout | Description |
|---|---|
| `2Deck Horizontal` | 2 decks, enlarged waveforms **stacked** one above the other, mixer strip **between** them horizontally |
| `2Deck Vertical` | 2 decks, enlarged waveforms **side by side** running vertically, mixer column **between** the two decks |
| `4Deck Horizontal` | same, 4 decks |
| `4Deck Vertical` | same, 4 decks |
| `BROWSE` | library-dominant layout, decks collapsed to a strip |

Horizontal is the common mixing choice because waveforms are fully displayed across the screen width; vertical mimics a CDJ-pair/Serato "side by side" reading.

Enlarged-waveform size is adjustable: hover the **left edge** (horizontal layout) or **top edge** (vertical layout) to reveal zoom in/out buttons. The browser area is resizable, and the mixer, effect, sampler, REC and lighting panels can each be shown/hidden.

### 1.2 Panel inventory (top to bottom)

**Global / command panel (top bar)**
- Mode switcher: `EXPORT` / `PERFORMANCE` / `LIGHTING` / `EDIT`
- Layout selector (the 5 modes above)
- Panel toggles: mixer, effects (FX/CFX), sampler, REC, lighting
- `LINK` (Ableton Link) enable/disable
- PAD EDITOR and MIDI LEARN windows
- Master volume + master VU, CPU meter, clock, Preferences (gear)

**Deck / player section (×2)**
- *Track information panel*: artwork; title / artist / original BPM / key; elapsed + remaining time; `KEY SYNC`; semitone −/+; `BEAT SYNC`; `SYNC RATE` (`×1` / `×2` / `×1/2`); current cue position; `MASTER`; **full-track overview waveform** (click to jump) showing cue point, memory cues, hot cues, phrases and Lighting scenes; current key + difference from original key
- *JOG panel* (virtual platter): current BPM, tempo change %, `TEMPO RANGE`, `MT` (becomes `KEY RESET` when the key is shifted), `Q` (quantize), `SLIP`, `AU`/`MA` loop mode switch, DVS mode (`INTERNAL` / `RELATIVE` / `ABSOLUTE`), CUE, PLAY/PAUSE, pitch-bend
- *Enlarged (zoomed, scrolling) waveform panel*: zoom ratio + `RST`, memory-cue and hot-cue markers, beat count, MIX POINT LINK match button, `CAPTURE`, phrase, vocal parts. Playhead is a **red centre line** (position configurable `CENTER` / `LEFT` on CDJ).
- *Performance pads* with a pad-mode selector
- *STEMS row* (7.2.8+): `VOCAL` / `INST` / `BASS` / `DRUMS` mute toggles

**Two waveform displays — the distinction matters for the build**
- **Full/overview waveform** — whole track, fixed width, static; carries cue markers, phrase bars, playhead. Rendered once per track from analysis data.
- **Enlarged waveform** — zoomed, scrolls at playback rate past a fixed playhead, beat-grid ticks (red triangle = first beat of bar, white = other beats), hot-cue and memory-cue flags, loop region. Redrawn every frame.

**Mixer panel** — sits horizontally mid-screen (horizontal layout) or vertically between the decks (vertical layout). See §4.

**Effect panels** — `FX1`, `FX2` (Beat FX units) and `CFX` (Sound Color FX). See §5.

**Sampler panel** — 4 banks × 16 slots (64 samples), per-slot waveform, one-shot / repeat / gate, master tempo, sync, gain, start point, BPM halve/double; sampler master gain + fader, cue, BPM, quantize, sync, `MASTER` designation; sequencer with record/play, metronome, bank navigation, bar length (1/2/4).

**REC panel** — recording source (default Master Out), record level, VU, REC button, elapsed + remaining time. Records to **WAV** (AIFF selectable). Disabled while streaming-service tracks are loaded.

**Lighting panel** — DMX, ambient mode, AUTO/MANUAL deck targeting, DIMMER, mood, bank change, colour, strobe, `BLACKOUT`.

**Browser / library** — tree (Collection, Playlists, Related Tracks, Track Suggestion, Sampler, iTunes, streaming services, Explorer/device, Histories, Recordings), Playlist Palette (3 pages × 4 slots), track list with configurable columns, search bar, filter row, sub-browser, My Tag panel, track info editor, preview player.

Keyboard-shortcut sanity check (rekordbox 7 default): Deck1 play/pause `Z`, cue `A`, loop in `D`, loop out `F`, reloop/exit `G`, beat sync `Q`, sync master `SHIFT+Q`; Deck2 play/pause `N`, cue `H`, loop in `K`, loop out `L`, reloop/exit `;`, beat sync `Y`. Hot cues A–D on `1`–`4` (deck 1) and `6`–`9` (deck 2).

---

## 2. Deck controls

### 2.1 PLAY/PAUSE and CUE

- **CUE (current cue)** — one per deck, temporary. Pause → click `CUE` sets the cue (orange mark on the enlarged waveform). During playback, `CUE` = **back-cue**: jump to the cue point and pause. **Click and hold** `CUE` at the cue point = **Cue Point Sampler** (preview while held; release returns and pauses).
- **Real-Time Cue** — press `IN` during playback to drop a cue on the fly (quantized if `Q` is on).
- Setting a new cue deletes the old one; loading a different track clears it unless saved as a memory cue.
- Optional preference: `[View]` → `[Display Type]` → `[Click on the waveform for PLAY and CUE]` (left-click waveform = play/pause, right-click = set/play from cue).

**CUE vs hot cue**

| | CUE | Hot Cue |
|---|---|---|
| Count | 1 per deck | **16 per track in rekordbox (A–P)**; 8 (A–H) on CDJ hardware |
| Persistence | Temporary | Stored in library/device DB |
| Trigger | back-cue + pause; hold = preview | instant jump + play |
| Extras | feeds Auto Cue + beat countdown | colour, comment, can store a loop, can be an Active Loop |

### 2.2 Jog wheel / platter

- **VINYL mode** — pressing the platter top stops playback; turning while pressed **scratches**.
- **CDJ mode** — the platter neither stops playback nor scratches.
- **Pitch bend** — turn the outer ring during playback (or, in CDJ mode, turn while pressing the top).
- **Frame search** — turn while paused. **Super fast search** — turn while holding `SEARCH ◀/▶`.
- `JOG FEEL` (platter weight) and **Vinyl Speed Adjust** (`Touch&Release` / `Touch` / `Release`) control brake/start ramp times. In rekordbox: Preferences → `[Controller]` → `[Deck]` → `[Vinyl Speed Adjust]` → `[Touch/Brake]` and `[Release/Start]`.
- **Jog display modes** (Preferences → `[View]` → `[Display Type]` → `[Switch JOG Display]`):
  - `[Current CUE / SLIP]` — red marker = cue position; when `SLIP` is on the inner ring turns red and a yellow marker shows the cue.
  - `[HOT CUE COUNTDOWN]` — distance to the next hot cue within 5 platter revolutions.
- **Needle search** — touch the overview waveform to jump. `[Needle Lock]` preference can disable it during playback. CDJ-2000NXS2 has a dedicated needle-search strip; CDJ-3000/3000X uses the touchscreen overview waveform. CDJ-3000X adds **Touch Cue** (monitor the touched point in headphones without affecting output).

### 2.3 Tempo / pitch fader

One button cycles `±6` → `±10` → `±16` → `WIDE`.

| Range | Step (CDJ-2000NXS2 / CDJ-3000X) | Step (rekordbox software) |
|---|---|---|
| ±6 % | 0.02 % | 0.02 % |
| ±10 % | 0.05 % | **0.04 %** |
| ±16 % | 0.05 % | **0.04 %** |
| WIDE | 0.5 % | 0.5 % |

- **WIDE is ±100 %**, not a wider fixed percent. At −100 % the track stops.
- Hardware default at power-on: ±10 %.
- **Tempo reset**: rekordbox — double-click the rate (%) readout. Hardware — `TEMPO RESET` button/LED.
- Note the documented divergence: rekordbox says 0.04 % for ±10/±16; the CDJ manuals say 0.05 %.

### 2.4 MASTER TEMPO (MT) / key lock, KEY SYNC, KEY SHIFT

- **`MT`** = key lock. Click `MT` on the platter (lights red); on CDJ the waveform screen shows `MT`. Manuals warn sound quality may change because the audio is digitally reprocessed.
- **With MT off**, pitch and key move together — including when `BEAT SYNC` changes the tempo.
- **`KEY SYNC`** shifts this deck's key to match the other deck(s). On CDJ-3000X it picks the smallest change among: same key, dominant, subdominant, relative, relative-of-dominant, relative-of-subdominant. `KEY RESET` restores the original key; pressing `MASTER TEMPO` also resets it.
- **Key shift** — semitone −/+ buttons in the track info panel, plus the `KEY SHIFT` pad mode with values **−12 … +12**, `KEY SYNC`, `SEMITONE UP/DOWN`, `KEY RESET`. When the key is shifted, the platter's `MT` label changes to `KEY RESET`.
- **Key display format**: Preferences → `[View]` → `[Display Type]` → `[Key display format]` = `[Classic]` (Am, F#m) or `[Alphanumeric]` (Camelot: 8A, 5B). **rekordbox does not ship an Open Key (1m/1d) option natively** — that requires third-party tagging. `[Traffic Light]` highlights harmonically compatible keys green in the browser. On CDJ-3000X the key is shown **green** when it is a related key to the sync master's track.

### 2.5 SLIP mode

"Even when you change the playback position, such as by scratching, playback continues in the background. When you finish your performance in the slip mode, the track resumes to play in the foreground."

Slip-able operations: **slip hot cue**, **slip scratch**, **slip pause**, **slip auto loop / slip manual loop**, **slip reverse** (8 beats), **slip beat loop**.

Visuals: `SLIP` lights when armed and **blinks while slip is active**; the platter's red ring rotates at the background rate; the background playback position is drawn as a line on the waveform (current/slip = yellow line, background = white line on the overview).

Auto-cancel timings on CDJ-2000NXS2: slip hot cue auto-cancels **4 beats** after the hot cue starts; slip reverse auto-cancels **8 beats**. Loading a track turns Slip off.

### 2.6 REVERSE vs CENSOR

Pioneer does **not** use the word "CENSOR" for a transport control. The two controls are:

- **REVERSE** — *latching* reverse playback. Jog acceleration/deceleration is also reversed. You genuinely lose your place in the track.
- **SLIP REVERSE** — this is the censor function. Reverse plays while normal playback continues underneath; releasing rejoins where the track would have been. **Auto-cancels after 8 beats**, and works **whether or not `SLIP` is on**.

Both are assignable software functions (`Reverse`, `Slip Reverse` in the keyboard-shortcut reference). rekordbox's quantize settings include a `[REVERSE]` entry so reverse doesn't knock the beat off.

⚠️ Do not confuse either with **ACTIVE CENSOR**, an unrelated *pad mode* that auto-applies an effect over pre-marked ranges (e.g. to mask an expletive).

### 2.7 SYNC — BEAT SYNC vs BPM SYNC, master deck

Preferences → `[Controller]` → `[Deck]` → `[BEAT/BPM SYNC]` → `[Sync Type]`:

- **`[BEAT SYNC]`** — syncs **BPM *and* beat position (phase)**.
- **`[BPM SYNC]`** — tempo only, no phase lock. (This is what people call "tempo sync"; rekordbox's label is `BPM SYNC`, not "TEMPO SYNC".)
- Also: `[Allow BEAT/BPM SYNC with double/half BPM.]`

**Master deck**: click `MASTER` in a deck's track info panel; then `BEAT SYNC` on the other deck. Clicking `MASTER` on the other deck moves the master. **The sync master hands off automatically when the master's track is changed or unloaded.** The sampler deck can also be the master.

**`SYNC RATE`** (visible only while `BEAT SYNC` is on, and hidden on the master deck): `×1` → `×2` → `×1/2` of the master BPM. `×2` is skipped if it would exceed +100 %.

On hardware: a synced non-master player's TEMPO slider is disabled; pitch-bending a synced player drops it from beat sync to BPM-only sync. Beat sync requires rekordbox-analysed tracks (beat grid).

**Quantize interactions that disable sync**: when the quantize beat is a fraction (1/16, 1/8, 1/4, 1/2), `BEAT SYNC` is disabled; when a fraction loop (1/32–1/2) is set, `BEAT SYNC` is disabled.

**There is no "phrase sync" in rekordbox.** The phrase-aware features are:
- **`PHASE METER`** (CDJ-3000/3000X/2000NXS2) — displays bar and beat deviation from the sync master.
- **`MIX POINT LINK`** (rekordbox 6.7+/7) — set `MIX IN` / `MIX OUT` points on two decks and link them so they arrive together; includes `[Automatically changes the BEAT/BPM SYNC setting]` (falls back from Beat Sync to BPM Sync for tracks with inconsistent BPM).
- **`Dual Player`** — links two players so play/pause, waveform navigation and beat jump apply to both.
- **Ableton Link** (`LINK` in the global panel) is the separate network tempo-sync mechanism.

### 2.8 QUANTIZE

**On hardware**: cue points, loop-in, loop-out and hot cue points snap to the nearest beat. `[Quantize Beat Value]` = **1/8, 1/4, 1/2, 1 Beat** (factory default **1 Beat**).

**In rekordbox software**: click `Q` per deck (the sampler has its own). Configuration at Preferences → `[Controller]` → `[Others]`:

| Setting | Meaning |
|---|---|
| `[Type]` → `[SNAP]` | Snap the position where a **hot cue is set** or an **auto beat loop starts** to the nearest beat; beat length selectable |
| `[Type]` → `[QUANTIZE]` | Sub-toggles `[HOT CUE]`, `[LOOP/SAMPLER(LOOP)]`, `[REVERSE]`, `[SEQUENCER]` — keeps the beat from shifting when these fire **during playback** |
| `[Mode]` | Checked = the function fires immediately (playback position adjusted so the beat doesn't shift); unchecked = fires on the next beat |
| `[Setting]` | `[All Decks]` toggles quantize globally |

rekordbox's fraction set goes one step finer than the CDJs: **1/16, 1/8, 1/4, 1/2, 1**.

### 2.9 Deck readouts

Track info panel: artwork, title, artist, original BPM, key, elapsed + remaining time, current cue position, key difference from original.

Enlarged waveform panel: zoom ratio, memory-cue and hot-cue markers, **beat count**, phrase, vocal parts.

Beat count display mode — Preferences → `[View]` → `[Display Type]` → `[Beat Count Display]`:
- `[Current Position (Bars)]`
- `[Count to the next MEMORY CUE (Bars)]`
- `[Count to the next MEMORY CUE (Beats)]`

---

## 3. Hot cues, memory cues, loops and pad modes

### 3.1 Hot Cues

- **16 per track in rekordbox (pads `A`–`P`)**; 8 (`A`–`H`) on CDJ-3000/3000X/2000NXS2. Controllers page between A–H and I–P.
- **Set** by clicking an empty pad. A pad that already holds a cue must be deleted first (hover → `X`).
- **HOT CUE LOOP** — clicking a hot cue pad *during loop playback* stores the loop in that slot. A loop icon appears; **click the icon to make it an Active Loop — it turns red**.
- **Colours & comments** — right-click a pad to enter a comment and change colour. Global palette: Preferences → `[View]` → `[Color]` → `[HOT CUE color]` = `[CDJ]` (hot cues green, hot loops amber), `[COLD1]` (blue/green), `[COLD2]` (blue gradation), `[COLORFUL]`. Hot cues address a 64-colour palette internally, 16 exposed in the UI.
- **Gate playback** — Preferences → `[Controller]` → `[Deck]` → `[HOT CUE]` → "During Pause, GATE playback is applied": hold to play from the hot cue, release returns and pauses.
- **Hot Cue Auto Load**, **Convert Memory Cues to Hot Cues** (right-click a track), and **Hot Cue Bank Lists** (8 banks A–H holding cues from *different* tracks) round it out.

### 3.2 Memory cues

- **10 cue points and 10 loop points saved per track.** Saved with `MEMORY`; recalled with `CUE/LOOP CALL ◀ ▶` on hardware, or by left-clicking the time in the `[MEMORY CUE]` panel (jump + pause). Right-click the time to add a comment; the marker colour is changeable.
- **MEMORY LOOP → Active Loop**: click the loop icon next to a saved loop; it turns red.
- On the waveform, memory cues show as **white triangles when approaching, red when passed**.
- `[Memory Cue Call Lock]` prevents calling memory cues during playback.
- **Intelligent Cue Creation** (Preferences → `[Analysis]` → `[CUE Analysis]`) auto-places hot/memory cues at analysis time; you choose type, count, bar spacing, overwrite protection and auto-comments.

**Storage difference, plainly**: both are stored per track in the library DB and survive reloads. The difference is *addressing and behaviour* — memory cues are an ordered list stepped through with CALL (jump + pause; they also drive Auto Cue and the beat countdown), hot cues are directly addressed by pad letter and fire instantly into playback.

### 3.3 Loops

**Manual loop** (`MA` mode): `IN` sets the loop-in point (**and also sets the cue point**), `OUT` sets loop-out and starts looping; `RELOOP` becomes `EXIT`. `EXIT` cancels; `RELOOP` recalls the last loop. Pressing IN/OUT during a loop enters **loop adjust mode** (times out after 10 s).

**Auto Beat Loop** (`AU` mode): choose the beat length with `<` / `>`, click the beat count to start.

- **Documented range: 1/64 to 512 beats** ("according to the BPM of the track").
- **Verified selectable set (PAD EDITOR, BEAT LOOP category): 1/64, 1/32, 1/16, 1/8, 1/4, 1/2, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512.**
- CDJ hardware exposes a narrower set: 1/4, 1/2, 1, 2, 4, 8, 16, 32.
- Default length for a hardware auto-beat-loop button: Preferences → `[Controller]` → `[Deck]` → `[AUTO BEAT LOOP]`.

**4/8 BEAT LOOP**: CDJ-3000X has separate `4 BEAT LOOP (1/2X)` and `8 BEAT LOOP (2X)` buttons. CDJ-2000NXS2 has one `4/8BEAT (LOOP CUTTER)` button (press = 4 beats, hold >1 s = 8 beats, press during a loop = halve). If BPM can't be detected it assumes **130**.

**LOOP CUT / DOUBLE**: halve/double from the loop-in point (`<` / `>` in rekordbox; `CUE/LOOP CALL ◀ ▶` or the 1/2X / 2X buttons on hardware).

**ACTIVE LOOP**: a saved loop flagged red. On load, once playback passes the point, loop playback starts automatically. Only one stored loop can be the active loop.

**LOOP MOVE = BEAT JUMP during a loop.** CDJ-3000X's manual section is literally titled "Beat Jump/Loop Move": "If you do this during loop playback, the loop moves."

**Emergency Loop** (hardware): auto-plays a 4-beat loop if the next track can't start, to avoid dead air.

⚠️ Build-relevant restriction: "**When a supported DJ controller is connected, you cannot operate the loop play on rekordbox.**"

### 3.4 Beat Jump

- rekordbox `[BEAT JUMP]` pad mode sizes: **`FINE` (= 5 ms), 1/8, 1/4, 1/2, 1, 2, 4, 8, 16, 32, 64, 128 beats**, each forward and reverse.
- CDJ-3000/3000X `[Beat Jump Beat Value]`: 1/2, 1, 2, 4, 8, **16 (default)**, 32, 64 beats.

### 3.5 Slicer

- The specified range is divided into **8 sections** assigned to the 8 pads. Hold a pad → that slice **loops**; normal playback continues underneath; on release, playback resumes from where it would have been. (Slicer is inherently slip-behaved.) **Requires a beat grid.**
- Controls: roll-while-held, re-play the same slice, shift the slicer range, **`LENGTH`** (slice range) and **`ROLL`** (roll length).
- **`ROLL` can be set from 1/64 to 1/8 of `LENGTH`.**
- **SLICER vs SLICER LOOP**: in *slicer mode*, when playback reaches the end of a range, the window advances to the **next** 8-slice range (rolling window that follows the track). In *slicer loop mode*, playback **returns to the start of the same range** (an 8-slice loop).
- Legacy naming (rekordbox dj / DDJ-SX era): **quantization** = 1/8, 1/4, 1/2, 1 and **domain** = 2, 4, 8, 16, 32, 64 beats — these are what rekordbox 6/7 now calls `ROLL` and `LENGTH`.
- **SLICER CAPTURE**: `SHIFT` + `CAPTURE` loads the whole slicer range into 8 sampler slots.

### 3.6 Pad modes (complete list)

| Pad mode | What it does | Where |
|---|---|---|
| `HOT CUE` | Set/trigger hot cues A–P; right-click for comment + colour; loop icon → Active Loop | Software + hardware |
| `PAD FX` (`PAD FX 1` / `PAD FX 2`) | Hold to apply the assigned FX; Release FX toggles on click. Assignable: `[BEAT FX]`, `[SOUND COLOR FX]`, `[SCENE FX]`, `[RELEASE FX]`. Release FX pads have `[HOLD ON/OFF]`. 2 banks × 16 | Software + hardware |
| `BEAT LOOP` | Beat-length loop from the current position; 1/64…512 | Software + hardware |
| `BEAT JUMP` | FINE (5 ms), 1/8…128 beats, fwd/rev; moves the loop during loop play | Software + hardware |
| `SLICER` | 8-slice roll; `LENGTH` + `ROLL`; slicer / slicer-loop | Software; hardware only on models with a SLICER button |
| `KEYBOARD` | Play a chosen hot cue transposed by semitone (−12…+12) — melodic cue juggling | Software + hardware |
| `KEY SHIFT` | Shift the deck key: −12…+12, plus `KEY SYNC`, `SEMITONE UP/DOWN`, `KEY RESET` | Software + hardware |
| `SEQ. CALL` (Sequence Call) | Play saved sampler sequences (up to 8); same pad restarts from the beginning | Software + hardware |
| `ACT. CENSR` (Active Censor) | Mark IN/OUT ranges; the effect fires automatically when playback reaches them. Effects: `REV ROLL`, `TRANS 1/8` or `TRANS 1/4`, `ECHO`, `V.BRAKE 1/16–32`. Not applied during reverse playback | Software + hardware |
| `MEMORY CUE` | Save / list / jump to memory cues and loops; marker colour; MEMORY LOOP → Active Loop | **Software-only pad mode** (hardware uses MEMORY + CUE/LOOP CALL transport buttons) |
| `SAMPLER` | Play sampler slots 1–16 (4 banks × 16) | **Hardware pad mode**; in software the sampler is its own deck panel |
| `SP.SCRATCH` (Sample Scratch) | Loads a sampler slot onto the deck so you can scratch it | rekordbox function with no on-screen pad-mode button; assign via MIDI Learn / keyboard |
| `STEMS` | Part-based pads | Hardware-only, STEMS-capable gear |

PAD EDITOR also exposes `USER 1`–`USER 8` slots and `LIGHTING` / `TRANSPORT` templates (the transport template includes `PLAY/PAUSE`, `CUE`, `PITCH BEND ±`, `CUE/LOOP CALL`, `TEMPO RESET`, `SLIP`, `PREVIOUS/NEXT TRACK`, `ACTIVE LOOP`, `BPM ±`).

**"TRANS PAD" does not exist in rekordbox** — it is a Serato DJ Pro pad mode on the DJM-S series. rekordbox's nearest equivalents are the `TRANS` Beat FX and the `TRANS` effect inside Active Censor.

**Sequencer**: records sampler-slot presses (overdub), selectable length (1/2/4 bars), up to 8 saved sequences, mute/erase modes, metronome, beat counter. Only records slots in one-shot play mode. A sequence can be dragged onto a deck as a track named `PATTERN *(*)`.

---

## 4. Mixer

Quotes marked "manual" are verbatim from the official rekordbox 7 Instruction Manual.

### 4.0 When the mixer exists at all

- Toggled from the Global section. Manual: *"When you connect your computer to a DJ controller, the mixer panel is automatically hidden."*
- It only processes audio when Preferences → `[Audio]` → `[Input/Output]` → **`[Mixer Mode]` = `[Internal]`**. `[External]` gives *"a six-way output: track decks 1 through 4, sampler deck, and preview"* and bypasses rekordbox's mixer entirely.

### 4.1 The 9 mixer-panel controls (manual, verbatim)

1. **Channel level indicator** — *"The sound of the respective channels **before passing through the channel faders** is indicated."* → pre-fader, post-TRIM/EQ/CFX, exactly the DJM topology.
2. **TRIM** — *"Adjust the audio input level for each channel."*
3. **EQ/ISO** — *"Adjust the volume of each frequency band. **Click to change the value to `[0]`**."*
4. **CUE** — *"Monitor the clicked channel through your headphones."*
5. **Channel fader** — *"Adjusts the audio level for each channel."*
6. **Headphones MIX** — *"Adjust the monitor volume of the channel for which the `[CUE]` button is clicked, and the sound of the `[MASTER]` channel."*
7. **Headphones LEVEL**
8. **Crossfader assign** — *"Assign the channel output to either the left or right of the crossfader."*
9. **Crossfader** — governed by `[Preferences]` → `[Controller]` → `[Mixer]` → `[CROSSFADER Curve]`.

(Pioneer's own manual erroneously cites `[CROSSFADER Curve]` for item 5; the channel fader is governed by the separate `[Channel Fader Curve]` preference.)

### 4.2 EQ — 3-band, and it models two named DJMs

**rekordbox is 3-band `[HIGH]` / `[MID]` / `[LOW]`. There is no 4-band mode** (4-band belongs to the DJM-V10).

Manual, *"To switch the function of `[EQ/ISO (HI, MID, LOW)]` controls"* — Preferences → `[Controller]` → `[Mixer]` → `[EQ]`:
- `[EQ/ISOLATOR]`: `[EQ]` = equalizer mode; `[ISOLATOR]` = isolator mode.
- When `[EQ]` is selected, **`[EQ Type]`** = **`[DJM-900NXS]`** or **`[DJM-900NXS2]`** — *"Set to the same EQ characteristics of DJM-900NXS(2)."*

**This is the single most useful fact for a clone: rekordbox ships two named DJM EQ curve models.**

**Band kill (a rekordbox-only affordance)**: *"When you click words of `[HIGH]`/`[MID]`/`[LOW]` to light up, the band is turned off. While they light up, each controller is not activated."* Clicking the knob resets it to `[0]`.

**Ranges from the modelled hardware** (DJM-900NXS2 OI, "Adjusting the sound quality"):
- `[HI]`: **−26 dB to +6 dB (30 kHz)**
- `[MID]`: **−26 dB to +6 dB (1 kHz)**
- `[LOW]`: **−26 dB to +6 dB (20 Hz)**

HI and LOW are shelves, MID is peaking. In ISOLATOR mode the bands become full-kill filters rather than −26 dB shelves. ⚠️ No explicit "−∞" figure appears in the manual text; treat isolator full-kill depth as DJM convention, not a quoted spec.

### 4.3 The COLOR knob (Sound Color FX knob)

One per channel, `[CH1]`–`[CH4]`. Manual, verbatim:

> The effect is applied to the channel of which you turned the knob.
> **If the knob is in the center position, the effect is not applied.**
> **The effect level differs according to the clockwise or counterclockwise turn of the knob.**

So: **hard centre detent = bypass; the two directions are two different behaviours of the same effect, not a mirrored amount.** Per-effect left/right semantics are in §5.3.

- A separate **parameter knob** sits next to each COLOR knob (*"Adjust the effect level"*) — the DJM `[PARAMETER]` control (resonance, feedback, noise volume…).
- *"If no DJ product is connected, `[COLOR]` knobs and parameter knobs for `[CH 1]` to `[CH 4]` are displayed."*
- **Multi-mode** = a different CFX per channel: *"you can apply `[DUB ECHO]` to a rhythm track and mix it with a cappella `[FILTER]`."* **Single-mode** = *"The same effect … to `[CH1]` to `[CH4]`."*

### 4.4 Faders and crossfader

- **Channel fader curve**: `[Preferences]` → `[Controller]` → `[Mixer]` → `[Channel Fader Curve]`. rekordbox draws the options as DJM icons; the DJM-A9 wording for the same three is: steep near the top / gradual across the throw / steep from the bottom.
- **Crossfader assign**: A / B buttons per channel; with neither engaged the channel bypasses the crossfader (= hardware `THRU`). ⚠️ The word "THRU" does not appear in the rekordbox manual.
- **Crossfader curve**: `[CROSSFADER Curve]`, three curves from sharp cut to gradual constant-power.
- **Channel fader start and crossfader start are NOT in rekordbox's software mixer.** No `Fader Start` entry exists in any Preferences table — it's a DJM-hardware + PRO DJ LINK/CDJ feature.
- **There is no "hide crossfader" toggle.** You hide the whole mixer panel; functionally you disable the crossfader by leaving every channel un-assigned.

### 4.5 Headphones (a separate panel)

Manual procedure: set `[MIX]` to the middle so *"The audio volume balance of `[MASTER]` … and `[CUE]` … are the same"*; turn `[LEVEL]` fully left; click `[CUE]` on the deck to monitor; raise `[LEVEL]`.

- Per-channel `CUE` in the mixer panel; the **sampler deck has its own CUE**.
- **No dedicated MASTER CUE button is documented in rekordbox** — master monitoring comes from the `[MIX]` balance knob.
- **Split cue / MONO SPLIT is hardware-only.** DJM-900NXS2: *"The sound of the channels for which the `[CUE]` button is pressed … is output from the headphones output's left channel, the `[MASTER]` channel sound is output from the right channel."*

### 4.6 Masters, levels, limiter, booth, mic

- **MASTER LEVEL is not in the mixer panel** — it is **Global section item 10**: *"Adjust the volume level from MASTER OUT."* Same control carries **PC MASTER OUT** (`[ON]` = master also out of the computer's speakers).
- **Master level meter** is Global item 11.
- **`[Output Level]`** — a rekordbox-specific deck gain stage at `[Controller]` → `[Mixer]`:
  - Internal mixer mode: **−21 / −18 / −15 / −12 / −9 / −6 / −3 dB / NONE**
  - External mixer mode: **−12 / −9 / −6 / −3 / NONE / +3 / +6 / +9 dB**
- **Limiter** on the master path, no user controls: *"Clipping will enable the limiter to prevent distortion, but at the same time it will spoil the attack of a sound."*
- **rekordbox publishes no dB scale or clip-LED spec for its meters.** (DJM-A9 hardware has a separate `CLIP` indicator.)
- **No booth level knob in rekordbox** — booth exists only as a routing destination under `[Audio]` → `[Input/Output]` → `[Output channels]`.
- **Microphone panel** exists but is gated: *"When compatible DJ equipment is connected, open the microphone panel."* It has mic on/off, level meter, **mic EQ**, mic effect on/off + select + level, **TALKOVER**, **FEEDBACK REDUCER** + type. Talkover modes: `[Advanced]` (*"Only the mid-range sound of channels, other than the MIC channel, is attenuated"*) and `[Normal]` (all frequencies). DJM-900NXS2 gives the numbers: **−18 dB attenuation triggered at −10 dB mic input**. FEEDBACK REDUCER: `[LIGHT]` (narrow cut, for singing/rap) vs `[HEAVY]` (wide cut, for speech/MCing). Mic EQ on DJM: HI −12/+12 dB (10 kHz), LOW −12/+12 dB (100 Hz).

---

## 5. Effects

### 5.0 The engines

Manual, verbatim: *"There are four effect modes in rekordbox; **BEAT FX, SOUND COLOR FX, Release FX, and MERGE FX**. The **PAD FX** feature enables you to operate these effects with the pads. Popular effects in our DJ mixer (DJM series, etc.) and remix station (**RMX series**, etc.) are pre-installed…"* v7 adds **STEM FX** (any of the above applied to a single INST/VOCAL/DRUMS stem).

### 5.1 BEAT FX — units, routing, modes

**Two units, `[FX1]` and `[FX2]`** — *"allowing you to assign a deck for each unit."*

**Routing (manual, verbatim):** Decks 1–4 = click `[1]`–`[4]`; sampler = `[S]`; master out = `[M]`. **Master is exclusive**: *"When the master out is selected for effects, you cannot assign effects to any other deck or the sampler deck."*

⚠️ This differs from DJM hardware, which also routes `[MIC]`, `[CROSS FADER A]` and `[CROSS FADER B]`. **rekordbox has no MIC or crossfader-A/B Beat FX assignment** — mic FX is a separate small selector in the Microphone panel.

**Two modes per unit:**
- **Multi-mode** — *"You can use up to three effects at the same time for each effect unit"* (3-slot serial chain).
- **Single-mode** — one effect, plus **SNAPSHOT**: *"Save multiple parameter settings … **The position of FX LEVEL/DEPTH is not saved**."*

**Panel elements (manual):** deck select · single/multi toggle · effect on/off · effect select · SNAPSHOT · **Release FX on/off** · Release FX select · BPM · **FX LEVEL/DEPTH** · beat count `<` / `>` · per-effect parameter · parameter on/off · Release FX beat count.

**FX LEVEL/DEPTH:** *"when you select `[ECHO]`, you can use the knob to coordinate how much echo is mixed on the original track. The original sound is output when the knob is turned fully counterclockwise."*

**BEAT parameter:** *"Select the number of beats to apply to effects in sync with the BPM."* Critical caveat: *"For some effects, including `[REVERB]`, a parameter value is set instead of beats"* — and in single mode *"these buttons are not enabled"* for some effects.

**BPM source:** `[AUTO]` (default; from the loaded track) or `[TAP]`. DJM hardware AUTO range is **BPM 70–180**.

**On/off is latching.** Momentary behaviour comes only from PAD FX and Release FX.

### 5.2 BEAT FX — the effect names

⚠️ **rekordbox's official manuals never print the effect list** (verified across v5.5.0, v6.0.0 and v7.x). The list below is assembled from Pioneer product copy, a Pioneer DJ forum enumeration, and a detailed rekordbox dj 4.0 review.

**Base set:** `Delay` · `Echo` · `Spiral` · `Reverb` · `Rev Delay` · `MT Delay` · `Up Echo` · `Down Echo` · `Trans` · `Pan` · `Filter` · `Flanger` · `Phaser` · `Slip Roll` · `Roll` · `Rev Roll` · `Robot` · `Pitch` · `Pitch Echo`

**Plus the four added for the DDJ-1000** (official Pioneer page: "four new Beat FX" + "10 of the most popular Beat FX from the DJM-series"): `Enigma Jet` · `Mobius Saw` · `Mobius Triangle` · `Low Cut Echo`

→ roughly **23** Beat FX in a current install.

**Not confirmed as rekordbox software Beat FX** (they exist on DJM hardware): `PING PONG`, `HELIX`, `TRIPLET FILTER`, `TRIPLET ROLL`. **`VINYL BRAKE` exists in rekordbox as a *Release* FX, not a Beat FX.** rekordbox splits DJM's single `MOBIUS` into Saw/Triangle.

**FX PLUS expansion pack** adds: `BPF ECHO`, `HPF ECHO`, `LPF ECHO`, `CRUSH ECHO`, `SPIRAL UP`, `SPIRAL DOWN`, `REVERB UP`, `REVERB DOWN`. An **RMX** pack also exists.

**Per-effect parameter table** (from the DJM-900NXS2 / DJM-A9 manuals rekordbox emulates) — format: BEAT | TIME | LEVEL/DEPTH:

| Effect | BEAT | TIME | LEVEL/DEPTH |
|---|---|---|---|
| DELAY | 1/16–16 beats | 1–4000 ms | dry/delay balance |
| ECHO | 1/16–16 | 1–4000 ms | dry/echo balance |
| PING PONG | 1/16–16 | 1–4000 ms | dry/echo balance |
| SPIRAL | 1/16–16 | 10–4000 ms | balance **and feedback** |
| **REVERB** | **1–100 % (not beats)** | 1–100 % | dry/effect balance |
| TRANS | 1/16–16 | 10–16000 ms | balance **and duty** |
| FILTER | 1/16–**64** | 10–32000 ms | effect amount |
| FLANGER | 1/16–**64** | 10–32000 ms | effect amount |
| PHASER | 1/16–**64** | 10–32000 ms | effect amount |
| **PITCH** | **−50 – +100 %** | −50 – +100 % | pitch amount |
| ROLL / SLIP ROLL | 1/16–16 | 10–4000 ms | dry/ROLL balance |
| VINYL BRAKE | 1/16–16 | 10–4000 ms | *"turn right … to slow playback steadily, resulting in an effect that stops playback"* |
| HELIX | 1/16–16 | 10–4000 ms | sound-overlay ratio; fully right fixes the output |
| MOBIUS (A9) | 1/16–64 / −64 – −1/16 | ±10–32000 ms | oscillator volume |

Two behaviours worth copying: `ROLL` / `SLIP ROLL` / `HELIX` *"record the input sound when the `[ON/OFF]` button is pressed"* (SLIP ROLL re-records when the time changes); and `DELAY`/`ECHO`/`PING PONG`/`SPIRAL`/`REVERB` are **post-fader** — *"Lowering the channel faders and cutting the input volume leaves a delay sound."*

### 5.3 SOUND COLOR FX (CFX) — the verified list

**rekordbox = exactly 9.** Manual (`[USER]` mode): *"**You can select favorite effects from 9 types of effect** and save them."*

| # | CFX | On current DJM HW? | What it does / COLOR left vs right | PARAMETER |
|---|---|---|---|---|
| 1 | **FILTER** | ✅ | *"Outputs filtered sound."* **CCW:** lowers LPF cutoff. **CW:** raises HPF cutoff | resonance |
| 2 | **SPACE** | ✅ | *"Adds reverberation."* **CCW:** reverb on **mid + low**. **CW:** reverb on **mid + high** | feedback |
| 3 | **DUB ECHO** | ✅ | *"Adds reverberating echo…"* **CCW:** echo on **mid only**. **CW:** echo on **high only** | feedback |
| 4 | **SWEEP** | ✅ | **CCW:** widens a **notch/gate** — *"makes the sound tighter, with a reduced sense of volume."* **CW:** **bandpass** whose *"bandwidth decreases steadily"* | centre frequency |
| 5 | **NOISE** | ✅ | *"Outputs filtered white noise mixed with the sound of the channel."* **CCW:** lowers the noise filter cutoff. **CW:** raises it | noise volume (EQ knobs shape noise quality) |
| 6 | **CRUSH** | ✅ | *"Outputs a 'crushed' version of the original sound."* **CCW:** more raw crush. **CW:** crush **through a high-pass filter** | crush amount |
| 7 | **JET** | ❌ (DJM-900nexus era) | flanger-type jet sweep | |
| 8 | **PITCH** | ❌ (is a *Beat* FX on current DJMs) | tone/pitch shift of the channel | |
| 9 | **GATE/COMP** | ❌ | gate one side of centre, compressor the other | |

Confirmed via the official **XDJ-RX Hardware Diagram for rekordbox dj**, which maps hardware buttons to `SOUND COLOR FX (NOISE)`, `SOUND COLOR FX (GATE/COMP)`, `SOUND COLOR FX (CRUSH)`, `SOUND COLOR FX (FILTER)`.

**rekordbox is a superset of current hardware**: the DJM-900NXS2 and DJM-A9 ship only 6 (`SPACE, DUB ECHO, SWEEP, NOISE, CRUSH, FILTER`); rekordbox keeps `JET`, `PITCH` and `GATE/COMP` from the older DJM-900nexus generation.

**Modes**: single-mode `[DEFAULT]` (mirrors the connected controller; `[FILTER]` when nothing is connected) · single-mode `[USER]` (pick freely from the 9) · multi-mode (one per channel). **CFX has no beat parameter** — it is a knob-position effect only.

### 5.4 RELEASE FX

**Purpose (manual, verbatim):** *"Release FX is a function to apply effects, **to cancel BEAT FX**, and to enable smooth transition of the currently playing track and the effect sound. You can also set to turn off SOUND COLOR FX."*

**Trigger semantics (manual):** select effect → click `[<]`/`[>]` to **set the length in beats** → *"**Click and hold** the effect to be applied"* (name lights blue) → *"**Release holding to turn off** the effect."* → **momentary by default, with a beat-length parameter.**

**Names (3):** **`VINYL BRAKE`**, **`ECHO`**, **`BACK SPIN`** (some hardware labels these `V.BRAKE` / `SPIN BACK`).

**Configuration** at `[Controller]` → `[Effect]` → `[RELEASE FX]`:
- **`[Unit Number]`** — *"when `[Mixer Mode]` is `[Internal]`, **Release FX is applied to the Master output if `[Unit Number]` is `[1]`**."*
- **`[Apply RELEASE FX on CFX]`** — *"You can then turn off Release FX and SOUND COLOR FX at the same time."*
- Per-unit cancellation (official DDJ-RX diagram): *"When the release FX is turned on, the beat FX in the same effect unit are turned off."*

**Do not confuse with ACTIVE CENSOR**, which has its own effect list (`REV ROLL`, `TRANS 1/8` or `1/4`, `ECHO`, `V.BRAKE 1/16–32`).

### 5.5 PAD FX

- **Two pad modes, `[PAD FX 1]` and `[PAD FX 2]`**, each *"While the pad is being pressed, the assigned FX is turned on."*
- **Banks:** *"PAD FX has 2 banks, and 16 preset effects can be set to each bank"* → **32 slots per PAD FX mode**.
- **What a pad holds (v7):** *"There are 4 parameters; `[BEAT FX]`, `[SOUND COLOR FX]`, `[SCENE FX]`, and `[RELEASE FX]`. In a parameter `[BEAT FX]`, you can change the beat of the FX."* (⚠️ `SCENE FX` is new in v7 and the manual never defines or enumerates it.)
- **Momentary vs latch:** Beat/Colour pads are **momentary** (*"Click and hold the pad to light it up… Release the click to turn the light off"*). Release FX pads have **`[HOLD ON/OFF]`** to choose latch vs momentary. (The manual contradicts itself on the polarity of that flag in two places — treat it as a latch/momentary toggle.)
- **Stacking:** *"When you press more than one performance pad (different effects), all the effects are turned on at the same time. **If an effect has different beats, only the last performance pad you pressed turns on.**"*
- **Release-FX pad interaction:** pressing one turns off all other PAD FX and returns to the original sound.
- **Temporary beat nudge:** press `[<]`/`[>]` *while* holding a pad.
- Colour themable via `[View]` → `[Color]` → `[PAD FX color]`.

### 5.6 MERGE FX (v6.6+/v7) — a one-knob transition macro

Enabled at `[Controller]` → `[Effect]` → `[Enable MERGE FX]`, adding an **`[MFX]` panel**. Two units — `MFX1` (decks 1/3), `MFX2` (decks 2/4) — and four user presets `[MERGE FX1]`–`[MERGE FX4]`, each a **4-stage recipe**:

> `[BUILD FX]`: Change the effect type when MERGE FX is turned on.
> `[BUILD SAMPLE]`: … sample sound/oscillator sound type to be played at the same time…
> `[RELEASE FX]`: Change the Release FX type when MERGE FX is turned off.
> `[DROP SAMPLE]`: … sample sound to be played after the Release FX when MERGE FX is turned off.

*"When MERGE FX is turned off, the MERGE FX parameter knob is automatically turned back to the center."* Not supported in external mixer mode.

### 5.7 FX panel UI

FX1 and FX2 are identical panels: source selector (Deck 1–4 / `S` / `M`), **single-vs-multi toggle drawn as 1 dot vs 3 dots**, effect name (click = on/off) + dropdown, FX LEVEL/DEPTH, beat `<`/`>`, `AUTO`/`TAP`. The CFX panel has its own single/multi toggle plus `DEFAULT`/`USER`, and a per-channel effect name + parameter knob. Layout chosen at `[View]` → `[Layout]` → `[Effect Panel]`. On controllers the FX PANEL button cycles: FX → CFX off → FX → CFX → FX + CFX → back.

---

## 6. Track analysis & data

### 6.1 Analysis — there are **three** modes, not two

Preferences → **`[Analysis]` category → `[Track Analysis]` tab**:

| Setting | Manual text |
|---|---|
| **`[Use high precision BeatGrid analysis]`** | *"Higher accuracy analysis results can be obtained compared to conventional analysis."* Slower |
| **`[Track Analysis Mode]`** | **`[Normal]`** — *"Suitable for analyzing tracks which have a relatively consistent tempo."* · **`[Dynamic]`** — *"…tracks which contain significant tempo changes."* · **`[Auto]`** — *"Available only when `[Use high precision BeatGrid analysis]` is on."* |
| **`[BPM Range]`** | *"Set BPM range obtained by **normal** analysis"* (only meaningful for `[Normal]`) |
| **`[Track Analysis Setting]`** | Checkboxes: **`[BPM / Grid]`, `[KEY]`, `[Phrase]`, `[Vocal]`** |
| **`[Auto Analysis]`** | `[Enable]` / `[Disable]` on import |

`[Vocal]` is a v7 addition (AI vocal-position detection, drives the vocal overlay on the waveform). Adjacent tabs: `[CUE Analysis]`, `[Cloud Analysis]`, `[Radar Analysis]`, `[Key Analysis]` → `[Write the value to the ID3 tag]`, `[Analysis Process]` (`[Performance]` vs `[Power saving]`).

Trigger via `[Track]` menu → **`[Analyze Track]`** or right-click. Tracks analysed by an old version show **`[?]`** — fix with right-click → **`[Add New Analysis Data]`**.

**`[Analysis Lock]`** — *"Set to disable re-analysis and grid edit."* Blocks both track analysis and `[GRID EDIT]` operations; batch analysis skips locked tracks; a lock icon shows in the status column.

### 6.2 Beat grid and the `[GRID]` / `[GRID EDIT]` panel

`[Normal]` writes essentially one tempo/anchor for the whole track; **`[Dynamic]`** places multiple beat markers wherever a tempo shift is detected.

Panel controls (verbatim): shift the playhead to the **first beat of bar** · display grid spacing **as BPM** (type a BPM to change it) · **`[TAP]`** · move grid **left/right by 1 msec** · **widen/narrow** spacing by 1 msec (3 msec when `[fine]` is on) · **double/halve the BPM** · select whole track vs "current position or later" · **re-set the grid from the current position** · undo/redo · **metronome** on/off + 3 volume levels · `[Analysis Lock]` · phrase-edit controls.

Caveats: *"You cannot adjust the beat grid when your computer is connected to DJ equipment supported with PRO DJ LINK"*, and **re-analysis overwrites manual grid edits**.

Beat Sync, quantize, beat jump, auto loop and slicer all **depend on the grid**.

### 6.3 Key

Preferences → `[View]` → `[Display Type]` → **`[Key display format]`**:
> "Select a key display format from **`[Classic]`** (key name) or **`[Alphanumeric]`** (such as 1A and 2A). When selecting **`[Display key information on the database]`**, key is displayed as recorded on the track."

**There is no `[Open Key]` option.** Available since ver. 5.4.3.

**Traffic Light** = the key-compatibility highlighting, at `[View]` → `[Display Type]` → `[Traffic Light]`. Taking a loaded **2A** as the example:

| Option | Highlights |
|---|---|
| `Same key` | 2A |
| `Related key 1` | 2A / 2B |
| `Related key 2` | 2A / 2B / 1A / 3A |
| `Related key 3` (default since 6.5.2) | 2A / 2B / 1A / 3A / 1B / 3B |

`KEY SYNC` picks the smallest of: same / dominant / subdominant / relative / relative-of-dominant / relative-of-subdominant. `[KEY SHIFT]` pad mode = −12…+12. `[KEYBOARD]` pad mode pitch-shifts **per hot cue**. On CDJ-3000X the key readout is **green** when related to the sync master's key.

### 6.4 Phrase analysis — **three auto-assigned moods**, not genre models

There is **no HOUSE/TECHNO vs HIP HOP/R&B selector**. rekordbox auto-classifies each track into a **mood**, and the mood fixes the label vocabulary. Official definition (LIGHTING mode guide): mood is *"a classification of music based on audio information including **tempo, rhythm, kick drum and sound density**. It is classified as **HIGH / MID / LOW**."*

Seven generic phrase types: **`Intro`** (opening) · **`Up`** (build-up) · **`Down`** (breakdown) · **`Chorus`** (uplifting) · **`Bridge`** (interlude) · **`Verse`** (*"a phrase that does not apply to other phrases"*) · **`Outro`** (ending). Plus **`Fill in`** — detected at the end of **Intro, Up and Chorus** (up to 4 beats), shown on the **enlarged waveform only**.

**Actual label sets per mood:**
- **HIGH** (the EDM model): **Intro 1, Intro 2, Up 1, Up 2, Up 3, Down, Chorus 1, Chorus 2, Outro 1, Outro 2**. "Down" is the only un-numbered one. **No Verse, no Bridge.**
- **MID**: **Intro, Verse 1 … Verse 6, Bridge, Chorus, Outro**
- **LOW**: **Intro, Verse 1, Verse 2, Bridge, Chorus, Outro** — this is the set commonly described as the "hip hop / R&B" model

**Editing (`[PHRASE EDIT]`)**: only one deck at a time · **`[CUT]`** divides a phrase into two of the *same* type · change type from a drop-down limited to the mood's own types · drag the white split line to adjust, and *"if ◄► is moved beyond another phrase, the phrases will be **combined**"* · **`[CLEAR]`** deletes all results *"except `[Intro]`"*. ⚠ **"If you perform Phrase Analysis again for the track of which you edited phrases, your edit will be cleared."**

Display toggles: `[View]` → `[Layout]` → `[Phrases]` → `[Phrase (Enlarged Waveform)]` / `[Phrase (Full Waveform)]` / `[Always Show types of phrases]`.

**Phrase colours** — ⚠ AlphaTheta publishes no colour table. Reverse-engineered values (Beat Link), family logic: **Intro = red/pink · Up & Verse = violet-blue · Down = brown · Bridge = yellow · Chorus = green · Outro = grey-blue.** Sample HIGH-mood values: Intro 1 `rgb(200,0,0)`, Up 1 `(140,50,255)`, Down `(155,115,45)`, Chorus `(15,170,0)`, Outro 1 `(80,135,195)`.

Storage: `PSSI` tag in the `.EXT` analysis file, 24 bytes/phrase, header carries mood (1/2/3). Since rekordbox 6 the exported `PSSI` is XOR-obfuscated.

### 6.5 Waveform colouring — exact mapping

Setting is at Preferences → **`[View]` category → `[Color]` tab → `[Waveform color]`** (not a `[Waveform]` tab): *"Set the color of the **enlarged/full waveform** as `[BLUE]`, `[RGB]`, or `[3Band]`."*

**It is a single global setting covering both the enlarged and the full/overview waveform** — not per-deck, not separate per waveform. A separate setting controls what the *player* draws off USB (`[DJ System]` → `[General]`, per device).

| Mode | Mapping |
|---|---|
| **`BLUE`** | Each byte = **5 low bits height + 3 high bits "whiteness"**. Deep saturated blue = low-frequency-dominant; light cyan/white = high-frequency-rich |
| **`RGB`** | **low/bass → RED, mid → GREEN, high → BLUE**, blended into one hue per column. Hi-hat-only intros read blue/cyan; bass+mid sections read orange/yellow; full-spectrum reads white |
| **`3Band`** | **low = dark blue `(32,83,217)`, mid = amber `(242,170,60)`, high = white**. In the *preview* the bands are **stacked**; in the *detail* view they share an axis, so low∩mid overlap renders **brown** `(169,107,39)` and white highs are drawn last, obscuring what's under them |

**Note the inversion: low is *red* in RGB but *blue* in 3Band.** RGB blends three energies into one hue (you read a colour); 3Band keeps three amplitudes separate with fixed colours (you read three levels).

⚠ The RGB band→colour mapping is established by reverse engineering (Deep Symmetry / Beat Link), not by any AlphaTheta statement.

ANLZ tags: `PWAV` (mono preview, 400 B) · `PWV3` (mono detail) · `PWV4` (colour preview, 6 B/col) · `PWV5` (colour detail, 2 B/col, bitfield `red:3|green:3|blue:3|height:5|unused:2`) · `PWV6`/`PWV7` (3-band, 3 B/col in **mid, high, low** order, `.2EX`).

3Band needs `.2EX` data — no re-analysis, just right-click → `[Add New Analysis Data]`.

### 6.6 Colours, ratings, comments, tags

- **Track colour tag — 8 colours**: Pink, Red, Orange, Yellow, Green, Aqua, Blue, Purple (+ None). Each colour carries an **editable comment/label** at `[Advanced]` → `[Browse]` → `[Color]`.
- **`[Coloring of played tracks]`** is a *different* feature — recolours the row after playing.
- **Hot cue colours**: four schemes at `[View]` → `[Color]` → `[HOT CUE color]` — `[CDJ]` (*"Hot Cues in green and Hot Loop in amber"*), `[COLD1]` (blue/green), `[COLD2]` (blue gradation), `[COLORFUL]`. Per-cue override by right-clicking the pad. Same tab has `[PAD FX color]` and `[SAMPLER color]`.
- **Rating**: 0–5 stars. **Comments**: free text per track, per hot cue, per memory cue.
- Ratings, colours and comments **round-trip from the player** via `[Update Collection]` on a USB device.
- **My Tag**: **4 category slots — three named presets `Genre`, `Components`, `Situation` plus one blank**, hard cap of 4. ⚠ "Mood" is *not* a stock category name, just the most common user rename of the blank slot. The per-category tag cap is **unconfirmed**. `[Advanced]` → `[Browse]` → `[My Tag]` → **`[Add My Tag to the Comments]`** is how My Tags become visible on CDJ/XDJ — note it writes into the same `[Comments]` field the colour-comment feature uses, so the two can collide.
- Other fields: Label, Mix, Remixer, Original Artist, Composer, Date Added, Year, Play Count, DJ Play Count. ⚠ The complete field/column list is never published by AlphaTheta.
- Tag formats read: ID3 v1/v1.1/v2.2/v2.3/v2.4 (MP3, AIFF), M4A meta, RIFF INFO (WAV), Vorbis Comment (FLAC). `[Reload Tag]` re-reads and **replaces** your edits.

---

## 7. Browser / library

### 7.1 Tree structure — and the v6 → v7 rename

- **v6**: the left panel is the **Tree View**.
- **v7**: split into **`[Media Browser]`** (the source list) + **Tree View** (contents of the selected source). The v7 `[Collection]` window is numbered `1. Shortcuts · 2. Media Browser · 3. Tree View · 4. Menu · 5. Column`.

**v7.2.x media browser**: `[Collection]`, `[Playlists]`, `[Related Tracks]`, **`[Track Suggestion]`**, `[Hot Cue Bank Lists]`, `[iTunes]`, `[Apple Music]`, `[Inflyte]`, `[Beatport]`, `[TIDAL]`, `[rekordbox xml]`, `[Explorer]`, `[Devices]`, `[Histories]`, `[Recordings]` — 7.2.18 adds `[Spotify]`, `[Cloud Export]`, `[CloudDirectPlay Filter]` and drops `[Photo]` and `[Beatsource]`.

⚠ **`[Sampler]` is NOT a browser node** (the sampler bank lives in the sampler deck). Neither `[Bridge]` nor `[Inbox]` exist in rekordbox.

- **`[Histories]`** — tracks played ≥1 minute; folders `[HISTORY yyyy-mm-dd]` and `[LINK HISTORY yyyy-mm-dd]`.
- **`[Hot Cue Bank Lists]`** — 8 banks `[A]`–`[H]` per list; saved cue = green, saved loop = orange.
- **`[Tag List]`** — the **left-most of the 4 palette slots**, max **100 files**.
- **Cloud** — there is no node named `[Cloud Library Sync]`; settings are at `[CLOUD]` → `[LIBRARY SYNC]`, with **`[Default Cloud Storage]` = `[Dropbox]` or `[Google Drive]`**.

**Streaming (as of Aug 2026)**: SoundCloud, Beatport, TIDAL, Apple Music, **Spotify**. **Beatsource has been dropped** in 7.2.18 (⚠ inferred from the guide diff; no announcement found). `[Beatport]`, `[TIDAL]` and `[Apple Music]` work in **EXPORT mode** too as of 7.2.7. Recording is disabled while streaming tracks are loaded.

### 7.2 Playlists & Intelligent Playlists

Create with **`+`** beside `[Playlists]`. **v7 only**: *"Playlists have two display formats: tree view and column view."* Export to `.txt` / `.m3u8`; import M3U/M3U8/PLS. **Up to 8 shortcuts.** **Collaborative Playlist** (v7): max **1000 tracks, 5 members**.

**`[Playlist Palette]`** — **4 slots**, the left-most is **TAG LIST**, the other 3 are playlists.

**Intelligent Playlist** (rekordbox's term for a smart playlist) — right-click `[Playlists]` → **`[Create New Intelligent Playlist]`**. Operators, verbatim and identical across 5.5.0 / 6.8.0 / 7.2.x:

`[=]` · `[≠]` · `[>]` · `[<]` · `[contains]` · `[does not contain]` · `[starts with]` · `[ends with]` · `[is in the range]` (between 2 values) · `[is in the last]` (days/months from today) · `[is not in the last]`

Combine with **`[Match all of the following conditions]`** or **`[Match any of the following conditions]`**. ⚠ The field list is not published; third-party enumeration gives Album, Album artist, Artist, BPM, Color, Comments, Composer, Date Added, Date Created, DJ play count, File name, Genre, Key, Label, Mix name, My Tag, Original artist, Rating, Release date, Remixer, Time, Track title, Year.

### 7.3 Related Tracks

> "You can display a list of tracks related to the loaded track… The relation can be set with **`[BPM]`, `[Key]`, `[Matching]`, `[Tracks in the same genre]`, `[Ratings]`, My Tag, etc.**" (5.5.0 adds **colour**)

Window parts: conditions list (create/edit/delete with `[+]`) · search target (folder or playlist) · **`[Rank]`** (*"Tracks are ranked in the relevant order based on the conditions"*) · track selection (which deck is the reference) · criteria customiser.

**`[Matching]`** is a manual "these two work together" pairing — a button in 2-deck layouts that *"register[s] 2 tracks loaded as related tracks."*

Subpanel via right-click → `[Display on Subpanel]`, with source selector `[LIST]` / `[MASTER]` / `[1]`–`[4]`.

⚠ The complete criteria checkbox list is undocumented (official text stops at "…etc."). **Hot Cue Bank is not a criterion.**

### 7.4 Track Suggestion (v7)

In v5/v6 this named only preset condition lists *inside* `[Related Tracks]`. In **v7 it is its own Media Browser node** with five conditions, verbatim:

- **`Collection Radar`** — *"tracks with similar musical characteristics to the currently playing track from `[Collection]`"*
- **`Streaming Radar`** — same, from a streaming service
- **`Era`** — *"tracks released in a similar era"* (year + BPM)
- **`Mood`** — *"tracks with the similar vibe"* (genre + BPM)
- **`Association`** — *"tracks with the same composer, label, etc."*

Only the two **Radar** modes use AI, and only they are configurable — the settings window has exactly **four** parameters: **Streaming service · BPM · Key · Vocal** (*"Set vocals included/not included"*). Search target is not selectable for Streaming Radar.

Requires `[Analysis]` → `[Track Analysis]` → **`[Rader Analysis]`** *(sic — AlphaTheta's own typo)*; already-imported tracks need `[Add New Analysis Data]`.

**Related Tracks vs Track Suggestion**: Related Tracks = *your* rule sets over *your* library. Track Suggestion = AlphaTheta's engines, four knobs, and it can reach into **streaming catalogues**.

### 7.5 Track Filter

Button is the filter icon on the **left side of the search box**.

> "Search for a track by refining with **`[BPM]`, `[KEY]`, `[RATING]`, `[COLOR]`, and `[MY TAG]`**."

For `[BPM]` or `[KEY]`, turn on **`[MASTER PLAYER]`** (EXPORT) / **`[MASTER DECK]`** (PERFORMANCE) and *"the value is set as the `[BPM]` or `[KEY]` of the track loaded on the Master Player at that time."* Multiple My Tags combine with **`[AND]` / `[OR]`**. Reset with **`[RST]`**.

It narrows **whatever list is currently shown**. ⚠ No ±% BPM tolerance control and no "key-compatible" toggle exist inside the Track Filter — key compatibility is the separate **Traffic Light** highlighting.

### 7.6 Track list, search, preview, views

- **Columns**: right-click the header to toggle; drag headers to reorder. ⚠ The full column list is never published.
- **There is no `[Sort]` dialog for the rekordbox browser** — the `[Category]`/`[Sort]`/`[Column]` settings under `[DJ System]` configure the **CDJ/XDJ** browse UI, not rekordbox's. Click a header to sort, click again to reverse.
- **Alphabet Search** — type characters to highlight matching tracks; **disabled in PERFORMANCE mode** (shortcuts take over).
- **Search filter is column-scoped via an explicit picker**: click the `▼` → *"Searchable columns are displayed"* → pick a column → type.
- **Preview Player is the `[Preview]` column**, not a separate widget. *"Click the waveform in the `[Preview]` column… to start the preview from the position you clicked."* Starting a preview **pauses the player panel**. `[View]` → `[Layout]` → `[Browser panel]` → **`[Display Cue Markers on Preview]`** adds memory/hot cues to the preview waveform, and you can start playback from a cue marker. The **`[Artwork]` column** previews from the beginning on hover-click and **skips 30 s** per further click.
- ⚠ **rekordbox has no list-vs-grid toggle and no `[Track]` display mode.** What exists: an artwork display-pattern switch (upper part vs whole), **Sub Browser**, **`[Show Split Screen]`** (PERFORMANCE), **`[Browse]`** (minimised deck + enlarged browser) and **`[Full Browser]`** (EXPORT).
- The right-hand panels — Track Information / My Tag Configuration / Related Tracks Subpanel / Track Suggestion Subpanel — are **mutually exclusive**.
- Row styling at `[View]` → `[Display Type]` → `[Browse]`: `[FontSize]`, `[Line Space]`, `[Show the selected track to the center]`, `[Coloring of played tracks]`, `[Key display format]`.

---

## 8. Other notable features

- **Recording** — REC panel, source defaults to Master Out, level + VU, saves **WAV** (AIFF selectable). Paid-plan feature; disabled with streaming tracks.
- **STEMS** (7.2.8+) — real-time separation into **3 stems (VOCAL / INST / DRUMS)** or **4 stems (VOCAL / INST / BASS / DRUMS)**. Functions: `ACTIVE STEM` (per-stem mute at the deck), `STEM ISO` (per-stem level on the mixer knobs), `STEM FX`.
- **MERGE FX** — one-knob transition macro (see §5.6), two units, four user presets, each a BUILD FX → BUILD SAMPLE → RELEASE FX → DROP SAMPLE recipe.
- **Mix Point Link** — preset `MIX IN` / `MIX OUT` switch-over points on two decks, linked so the transition happens hands-free.
- **Dual Player** — links two players: play/pause, waveform scrubbing and beat jump apply to both.
- **Ableton Link** — network tempo sync with other apps/hardware. Cannot be used during Automix or on decks in `RELATIVE`/`ABSOLUTE` DVS mode.
- **DVS** — timecode vinyl/CD control; deck modes `INTERNAL` / `RELATIVE` / `ABSOLUTE` (+ `THRU`).
- **VIDEO mode** — video file playback and video output (paid plan). **LIGHTING mode** — auto-generates DMX lighting sequences from phrase data, driving fixtures via RB-DMX1.
- **Automix** — automatic playlist mixing.
- **Cloud Library Sync / CloudDirectPlay / Collaborative Playlist** — multi-device library sync.
- **MIDI LEARN** and **PAD EDITOR** — full remapping.

---

## 9. What is realistically implementable in a browser (Web Audio API / WASM)

Rough build-cost tiers for a 2-deck web page.

### Tier 1 — cheap, do these first (hours to a day each)

| Feature | How |
|---|---|
| Play / pause / cue / back-cue / cue-preview | `AudioBufferSourceNode` restarted at offsets, or an `AudioWorklet` reading a float sample cursor |
| Hot cues (16), memory cues, cue colours & comments | Pure state; jump = restart the source at a sample offset |
| Channel fader, trim, crossfader + curve | `GainNode`s; curve = a math function on the fader value |
| 3-band EQ / isolator | 3 × `BiquadFilterNode` (lowshelf 20 Hz / peaking 1 kHz / highshelf 30 kHz), **−26 dB to +6 dB**; isolator mode = same knobs mapped to −∞. Ship a single curve; rekordbox's `DJM-900NXS` vs `DJM-900NXS2` `[EQ Type]` choice is a nicety, not MVP. Add the band-kill affordance (click the HIGH/MID/LOW *label* to kill the band, click the knob to reset to 0) — it's cheap and very rekordbox |
| Filter / COLOR knob (FILTER, CRUSH, NOISE, basic SPACE/DUB ECHO) | `BiquadFilterNode` (bipolar LPF/HPF around centre), `WaveShaperNode` for crush, `ConvolverNode` or feedback delay for space/echo |
| Beat FX: DELAY, ECHO, PING PONG, LOW CUT ECHO, FILTER, TRANS (gate), FLANGER, PHASER, REVERB | Standard Web Audio graphs. Beat division → delay time = `60 / bpm * beats` |
| VU / level meters | `AnalyserNode` or an `AudioWorklet` sending RMS/peak |
| Full-track overview waveform | Decode once, compute min/max (and 3-band via offline filtering) per pixel column, draw to canvas once |
| Enlarged scrolling waveform + beat grid | Pre-computed peak array + `requestAnimationFrame` canvas blit; grid lines from the beat array |
| Waveform colouring (BLUE / RGB / 3Band) | Run three `OfflineAudioContext` passes with LP/BP/HP filters, store 3 peak arrays, composite per column |
| Quantize (snap to grid) | Pure math on the beat array |
| Beat jump, loop in/out, auto beat loop, reloop/exit, loop halve/double, active loop | Sample-offset arithmetic; loop = wrap the cursor |
| Browser, playlists, search, sort, filters, My Tag, ratings, track colours | Ordinary app state / IndexedDB |
| Recording of the master bus | `MediaStreamDestination` + `MediaRecorder`, or an `AudioWorklet` capturing to WAV |

### Tier 2 — moderate (days; needs an AudioWorklet and care)

| Feature | Notes |
|---|---|
| **Tempo fader without key lock** | Trivial (`playbackRate`) — but `AudioBufferSourceNode.playbackRate` interpolation quality is browser-dependent. Better: own worklet with cubic (Catmull-Rom) interpolation over a float cursor. |
| **Jog wheel / scratch** | Requires the custom float-cursor worklet: play forward, backward and at any rate with clean interpolation. This is the single most important piece of custom DSP — everything else (reverse, censor, vinyl brake, backspin, slip scratch) builds on it. |
| **SLIP mode** | Once you have a float cursor, slip is cheap: keep a *shadow* cursor advancing at normal rate; on release, snap the audible cursor to the shadow. Same trick powers slip loop / slip reverse / slicer. |
| **REVERSE / SLIP REVERSE (censor)** | Negative cursor increment + the shadow cursor. |
| **VINYL BRAKE / BACK SPIN Release FX** | Ramp the cursor increment to 0 (or negative) over N beats. |
| **ROLL / SLIP ROLL / REV ROLL Beat FX** | Capture a beat-length buffer and loop it; slip variants use the shadow cursor. |
| **SLICER** | 8 sub-ranges of a `LENGTH` window + the slip shadow cursor. |
| **BPM detection + beat grid** | **essentia.js** (Essentia C++ compiled to WASM, from UPF's MTG) computes BPM, beat positions, key, chords, chroma. Run it in a Worker over an `OfflineAudioContext`-decoded buffer. Accurate enough for 4/4 electronic music; downbeat/bar-1 placement is the weak spot — expect to offer manual grid nudge/tap like rekordbox's Grid Edit. |
| **Key detection + Camelot mapping** | essentia.js key/scale extractor; Camelot is a lookup table on (key, mode). |
| **Sampler + sequencer** | Multiple buffer players; sequencer = scheduled events on the audio clock. |
| **Pad FX** | Composition of the above; the work is the assignment UI, not the DSP. |

### Tier 3 — expensive / compromise required

| Feature | Why it's hard | Pragmatic option |
|---|---|---|
| **MASTER TEMPO (key lock)** | Real-time time-stretch. Web Audio has nothing built in. Phase-vocoder and WSOLA implementations in JS exist but are experimental; quality/CPU tradeoffs are real. | Compile **SoundTouch** or **Rubber Band** to WASM and run it inside an `AudioWorklet`. Budget for artefacts beyond roughly ±10 %. This is the highest-value / highest-effort item, because DJs consider MT table stakes. |
| **KEY SHIFT / KEY SYNC / KEYBOARD pad mode** | Same pitch-shifting engine as MT, plus independent pitch control | Same WASM stretcher, resampling ratio decoupled from playback rate. Once MT exists this is nearly free. |
| **STEMS separation** | Demucs/Spleeter-class models. Real-time 4-stem separation in a browser is not currently practical. | Offline pre-separation (server-side or a one-time WASM/WebGPU pass into 4 buffers), then play 4 synced buffers. Real-time is a research project. |
| **Phrase analysis** | Structural segmentation (MSAF-class algorithms); no off-the-shelf WASM library | Either skip, or ship a crude energy/novelty-based segmenter and label it as approximate. rekordbox's own phrase detection is proprietary and genre-modelled. |
| **Very low latency** | `AudioWorklet`'s 128-sample render quantum causes glitching on mobile browsers under load; desktop is fine, mobile is not. | Target desktop; keep the worklet single-threaded and allocation-free; move analysis to Workers. |
| **DVS / timecode vinyl** | Needs multi-channel audio input and tight timing | Out of scope for a browser app. |
| **Recording with streaming sources, PRO DJ LINK, DMX lighting, video** | Hardware/licensing bound | Out of scope. |

### Recommended MVP for a 2-deck rekordbox-styled web page

1. **Custom `AudioWorklet` playback engine** with a float sample cursor and cubic interpolation — this unlocks scratch, reverse, slip, brake, roll and variable tempo in one go.
2. **`2Deck Horizontal` layout**: overview waveform + enlarged scrolling waveform per deck, mixer strip between them.
3. **Deck**: play/pause, cue (with hold-preview), tempo fader (±6/±10/±16/WIDE), `MT` (WASM SoundTouch), `Q`, `SLIP`, `BEAT SYNC` + `MASTER`, jog with vinyl/CDJ mode.
4. **Pads**: `HOT CUE` (16), `BEAT LOOP`, `BEAT JUMP`, `PAD FX`. Add `SLICER` / `KEYBOARD` later.
5. **Mixer**: trim, 3-band EQ, COLOR knob, channel fader, crossfader + curve, cue with mix knob, VU meters.
6. **FX**: `FX1` / `FX2` Beat FX units (deck / sampler / master routing, master exclusive) with the ~8 Web-Audio-native effects, the 6 hardware-standard CFX (FILTER, SPACE, DUB ECHO, SWEEP, NOISE, CRUSH) with **centre-detent bypass and asymmetric left/right behaviour**, and the 3 Release FX (momentary, beat-length parameter, cancels the Beat FX in the same unit).
7. **Analysis**: essentia.js in a Worker for BPM, beat grid and key; manual grid tap/nudge as a fallback; 3-band peak arrays for waveform colouring.
8. **Browser**: collection, playlists, search, sort, BPM/key/rating filter, Camelot display with compatible-key highlighting.

Deliberately deferred: STEMS, phrase analysis, DVS, video, lighting, streaming services, sequencer, Mix Point Link.

---

## Sources

**Official — rekordbox / AlphaTheta**
- https://rekordbox.com/en/feature/overview/
- https://rekordbox.com/en/support/faq/rekordbox7/
- https://rekordbox.com/en/support/faq/rekordboxdj/
- https://rekordbox.com/en/support/faq/streaming-5/
- https://rekordbox.com/en/2026/08/rekordbox-v7218-release-information/
- https://rekordbox.com/en/2025/12/rekordbox-v728-release-information/
- https://cdn.rekordbox.com/files/20240509141437/rekordbox7.0.0_manual_EN.pdf
- https://cdn.rekordbox.com/files/20250718115648/rekordbox7.1.4_manual_EN.pdf
- https://cdn.rekordbox.com/files/20200214194946/rekordbox5.5.0_manual_EN.pdf
- https://cdn.rekordbox.com/files/20210119132842/rekordbox6.5.0_pad_editor_operation_guide_EN.pdf
- https://cdn.rekordbox.com/files/20241203210634/rekordbox7.0.5_Phrase_Edit_operation_guide_EN.pdf
- https://cdn.rekordbox.com/files/20241203185020/rekordbox7.0.5_default_keyboard_shortcut_reference_EN.pdf
- https://cdn.rekordbox.com/files/20241203185046/rekordbox7.0.5_video_operation_guide_EN.pdf
- https://cdn.rekordbox.com/files/20241216130922/rekordbox7.0.7_lighting_operation_guide_EN.pdf
- https://cdn.rekordbox.com/files/20241203185031/rekordbox7.0.5_dvs_setup_guide_EN.pdf
- https://cdn.rekordbox.com/files/20241213141656/rekordbox7.0.7_streaming_service_usage_guide_EN.pdf
- https://cdn.rekordbox.com/files/20200124130852/CDJ_XDJ_Control_Mapping_en.pdf
- https://cdn.rekordbox.com/files/20250107172240/XDJ-AZ_HardwareDiagram_en.pdf
- https://cdn.rekordbox.com/files/20250107172137/DDJ-GRV6_HardwareDiagram_en.pdf
- https://cdn.rekordbox.com/files/20200124131226/DDJ-RX_Hardware_Diagram_en.pdf
- https://support.alphatheta.com/en-US/articles/8113178546201 (waveform colour BLUE/RGB/3Band)
- https://support.alphatheta.com/en-US/articles/9059124846745 (enlarged waveform size)
- https://support.alphatheta.com/en-US/articles/8943219092761 (key display format)
- https://support.alphatheta.com/en-US/articles/4408020773913 (recording)
- https://support.pioneerdj.com/hc/en-us/articles/4405908406681 (crossfader curve)
- https://downloads.support.alphatheta.com/manuals/all-in-one-dj-systems/XDJ-AZ/html/en/000COV_en/Beat_Sync/Beat_Sync.htm
- https://blog.pioneerdj.com/djtips/what-do-all-of-these-buttons-do/

**Official — hardware**
- CDJ-3000X Instruction Manual (downloads.support.alphatheta.com)
- CDJ-2000NXS2 Operating Instructions
- https://www.novelty.fr/wp-content/uploads/downloaded/downloads/materiel_manuels/pioneer_djm-900nxs2_manual_EN.pdf (EQ ranges, CFX table, full Beat FX parameter tables)
- https://kulturbuero.ch/files-sg/DJM-A9_manual_EN.pdf (current-gen CFX / Beat FX tables, EQ, booth, mic ranges)
- https://www.dj-technik.de/mediafiles/Bedienungsanleitungen/Pioneer_DJ/Pioneer_DJ_DJM-V10.pdf (4-band / SEND FX cross-check)
- https://cdn.rekordbox.com/files/20200124131236/XDJ-RX_Hardware_Diagram_en.pdf (source for CFX `GATE/COMP`)
- https://cdn.rekordbox.com/files/20200323144552/rekordbox6.0.0_manual_EN.pdf
- https://forums.pioneerdj.com/hc/en-us/community/posts/360061524832-RMX-Effects (rekordbox 6 Beat FX enumeration)
- https://forums.pioneerdj.com/hc/en-us/community/posts/115000174526-Echo-effect-has-no-volume-fader-control (post-fader FX by category, FX PLUS list)
- https://www.pioneerdj.com/en/product/dj-controllers/ddj-1000/ (the four new Beat FX)
- https://www.bonedo.de/artikel/pioneer-rekordbox-40-dj-test/ (FX / CFX / Release FX name lists)
- https://djtechtools.com/2019/06/24/hacking-rekordbox-fx-and-adding-rmx-1000-control/
- https://www.manualslib.com/manual/1275366/Pioneer-Djm-900nxs2.html (EQ/ISO ranges, Beat FX & Sound Color FX lists)
- https://virtualdj.com/manuals/hardware/pioneer/cdj3k/controls.html

**Secondary / tutorials**
- https://www.deejayplaza.com/en/articles/rekordbox-performance-mode-tutorial
- https://www.deejayplaza.com/en/articles/color-waveform-rekordbox
- https://www.deejayplaza.com/en/articles/rekordbox-keyboard-shortcuts
- https://www.deejayplaza.com/en/articles/import-analyze-music-rekordbox
- https://www.deejayplaza.com/en/articles/rekordbox-related-tracks-suggestions
- https://www.deejayplaza.com/en/articles/rekordbox-my-tag
- https://www.digitaldjtips.com/reviews/rekordbox-dj-5/ (pad mode list, 17 effects)
- https://www.digitaldjtips.com/how-to-map-different-effects-to-every-channel-in-rekordbox/
- https://www.digitaldjtips.com/rekordbox-v7-2-8-adds-4-stem-separation-new-cloud-setup-wizard/
- https://wearecrossfader.co.uk/blog/rekordbox-quantize-settings-how-its-done/
- https://wearecrossfader.co.uk/blog/keyboard-mode-tutorial-rekordbox/
- https://wearecrossfader.co.uk/blog/ddj-400-hidden-features/ (Release FX)
- https://wearecrossfader.co.uk/blog/slip-mode/
- https://pestrela.github.io/dj_kb/effects/ (DJM Beat FX / Colour FX mechanism table)
- https://www.thediscdjstore.com/blog/phrase-analysis.html
- https://www.setflow.app/blog/complete-guide-tagging-tracks-rekordbox

**Web audio implementability**
- https://mtg.github.io/essentia.js/ and https://transactions.ismir.net/articles/10.5334/tismir.111
- https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
- https://github.com/WebAudio/web-audio-api/issues/2632 (AudioWorklet mobile latency issues)
- https://repository.gatech.edu/bitstreams/f4b1290d-061f-45ab-8016-dfa8240b024e/download (Time Stretching & Pitch Shifting with the Web Audio API)
- https://github.com/superpoweredSDK/web-audio-javascript-webassembly-SDK-interactive-audio
- https://www.buttonbass.com/DJ.html (AudioWorklet scratch engine with Catmull-Rom interpolation)
