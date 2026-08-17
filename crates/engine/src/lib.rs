//! `daw-engine` — jalur render SATU-SATUNYA, dipakai realtime DAN offline export.
//!
//! Aturan yang mengikat (docs/00 §Aturan, docs/01 §1c):
//! - tidak ada `Rc`/`Arc`/`Mutex`/`RefCell` di mana pun
//! - SEMUA buffer dialokasi di `Engine::new` / `Engine::from_snapshot`
//! - `render_block` dan turunannya: zero alloc, tanpa `panic!`/`unwrap`/`format!`
//! - semua posisi integer sample (`u64`), tidak pernah detik float
//! - semua buffer planar; interleave hanya terjadi di WAV writer

#![cfg_attr(not(test), no_std)]
#![forbid(unsafe_op_in_unsafe_fn)]

extern crate alloc;

pub mod fx;
pub mod graph;
pub mod meter;
pub mod plan;
pub mod snapshot;
pub mod track;
pub mod transport;
pub mod voice;

pub(crate) mod util;

use alloc::boxed::Box;
use alloc::vec::Vec;

use daw_dsp::{add_scaled, clear, db_to_lin};
use daw_rt::{Command, MAX_BLOCK, MAX_BUFFERS, MAX_TRACKS, MAX_VOICES};
use daw_timeline::TimelineSample;

use crate::fx::FxRack;
use crate::graph::{
    build_plan, bus_unit, send_slot, track_unit, MASTER_METER_SLOT, TOTAL_SEND_SLOTS, TOTAL_UNITS,
};
use crate::meter::MeterBank;
use crate::plan::{PlanError, ProcessPlan, Step};
use crate::snapshot::{Project, MAX_SENDS};
use crate::track::{apply_fader, pan_add, Mixer};
use crate::transport::{Transport, TransportState};
use crate::voice::{Asset, AssetTable, VoicePool, VoiceStart};

/// Kapasitas antrian event ber-timestamp di dalam satu blok.
pub const EVENT_QUEUE_CAP: usize = 256;
/// Berapa plan pensiun yang bisa ditampung sebelum sisi non-RT wajib mengambilnya.
pub const RETIRE_SLOTS: usize = 4;
/// Kapasitas tabel asset.
pub const MAX_ASSETS: usize = 512;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum EngineError {
    Decode,
    Plan(PlanError),
    TooManyTracks,
}

/// Opcode command (ring UI→audio). `at_sample` = 0 berarti ASAP.
pub mod op {
    pub const PLAY: u8 = 1;
    pub const STOP: u8 = 2;
    pub const SEEK: u8 = 3;
    /// `target` = unit, `param` = bit f32 dB.
    pub const SET_GAIN_DB: u8 = 4;
    /// `target` = unit, `param` = bit f32 (-1..1).
    pub const SET_PAN: u8 = 5;
    /// `target` = unit, `param` = 0/1.
    pub const SET_MUTE: u8 = 6;
    /// `target` = track, `flags` = indeks send, `param` = bit f32 amount.
    pub const SET_SEND: u8 = 7;
    /// `at_sample` = awal loop.
    pub const SET_LOOP_START: u8 = 8;
    /// `at_sample` = akhir loop.
    pub const SET_LOOP_END: u8 = 9;
    /// `param` = 0/1.
    pub const SET_LOOP_ENABLED: u8 = 10;
    /// `target` = indeks clip di project.
    pub const TRIGGER_CLIP: u8 = 11;
    pub const STOP_ALL_VOICES: u8 = 12;
}

#[inline]
fn f32_from_param(p: u32) -> f32 {
    f32::from_bits(p)
}

/// Semua scratch stereo, dialokasi SEKALI. Planar: L lalu R per buffer.
struct Scratch {
    data: Box<[f32]>,
    stride: usize,
}

impl Scratch {
    fn new(buffers: usize, max_frames: usize) -> Self {
        let mut v = Vec::new();
        v.resize(buffers * 2 * max_frames, 0.0f32);
        Scratch {
            data: v.into_boxed_slice(),
            stride: max_frames,
        }
    }

    #[inline]
    fn one(&mut self, b: u16, off: usize, n: usize) -> (&mut [f32], &mut [f32]) {
        let blk = self.stride * 2;
        let base = b as usize * blk;
        let end = base + blk;
        let s = &mut self.data[base..end];
        let (l, r) = s.split_at_mut(self.stride);
        (&mut l[off..off + n], &mut r[off..off + n])
    }

    /// Dua buffer BERBEDA sekaligus (PanAdd/SendAdd). Aman karena keduanya
    /// irisan disjoint dari satu alokasi.
    #[inline]
    #[allow(clippy::type_complexity)]
    fn two(
        &mut self,
        a: u16,
        b: u16,
        off: usize,
        n: usize,
    ) -> (&mut [f32], &mut [f32], &mut [f32], &mut [f32]) {
        debug_assert!(a != b);
        let blk = self.stride * 2;
        let stride = self.stride;
        let (lo, hi, swapped) = if a < b {
            (a as usize, b as usize, false)
        } else {
            (b as usize, a as usize, true)
        };
        let (head, tail) = self.data.split_at_mut(hi * blk);
        let x = &mut head[lo * blk..lo * blk + blk];
        let y = &mut tail[..blk];
        let (xl, xr) = x.split_at_mut(stride);
        let (yl, yr) = y.split_at_mut(stride);
        let (xl, xr) = (&mut xl[off..off + n], &mut xr[off..off + n]);
        let (yl, yr) = (&mut yl[off..off + n], &mut yr[off..off + n]);
        if swapped {
            (yl, yr, xl, xr)
        } else {
            (xl, xr, yl, yr)
        }
    }
}

/// Antrian event ber-timestamp, kapasitas tetap, terurut naik.
struct EventQueue {
    items: Box<[Command]>,
    len: usize,
}

impl EventQueue {
    fn new(cap: usize) -> Self {
        let mut v = Vec::with_capacity(cap);
        v.resize(
            cap,
            Command {
                op: 0,
                flags: 0,
                target: 0,
                param: 0,
                at_sample: 0,
            },
        );
        EventQueue {
            items: v.into_boxed_slice(),
            len: 0,
        }
    }

    /// Insertion sort — antrian pendek dan hampir selalu sudah terurut.
    /// Kalau penuh: event DIBUANG (keputusan sadar), bukan realokasi.
    fn push(&mut self, c: Command) -> bool {
        if self.len >= self.items.len() {
            return false;
        }
        let mut i = self.len;
        while i > 0 && self.items[i - 1].at_sample > c.at_sample {
            self.items[i] = self.items[i - 1];
            i -= 1;
        }
        self.items[i] = c;
        self.len += 1;
        true
    }

    #[inline]
    fn peek_at(&self, t: u64) -> Option<Command> {
        if self.len > 0 && self.items[0].at_sample <= t {
            Some(self.items[0])
        } else {
            None
        }
    }

    #[inline]
    fn pop(&mut self) {
        if self.len > 0 {
            for i in 1..self.len {
                self.items[i - 1] = self.items[i];
            }
            self.len -= 1;
        }
    }

    #[inline]
    fn next_time(&self) -> Option<u64> {
        if self.len > 0 {
            Some(self.items[0].at_sample)
        } else {
            None
        }
    }

    fn clear(&mut self) {
        self.len = 0;
    }
}

/// Satu-satunya pemilik state audio. Tidak ada `Rc`/`Arc`/`Mutex` di dalamnya;
/// worklet memegang pointer mentah hasil `Box::into_raw` dan hanya SATU thread
/// yang pernah menyentuhnya (invariant desain, didokumentasikan di wasm-bridge).
pub struct Engine {
    plan: ProcessPlan,
    /// Plan baru yang dibangun sisi non-RT, menunggu di-swap di awal blok.
    incoming: Option<ProcessPlan>,
    /// Plan pensiun. Audio thread TIDAK men-drop plan (drop = dealloc); ia
    /// menaruhnya di sini dan sisi non-RT yang mengambil & men-drop-nya.
    retired: [Option<ProcessPlan>; RETIRE_SLOTS],
    generation: u32,

    scratch: Scratch,
    mixer: Mixer,
    fx: FxRack,
    voices: VoicePool,
    assets: AssetTable,
    meters: MeterBank,
    transport: Transport,
    queue: EventQueue,

    /// Model project (sisi non-RT). Dipakai untuk snapshot & rebuild plan;
    /// jalur render tidak pernah membacanya kecuali daftar clip terurut.
    project: Project,
    /// Indeks clip terurut menaik berdasarkan `start`.
    sched: Box<[u16]>,
    sched_len: usize,
    /// Posisi baca berikutnya di `sched`.
    sched_cursor: usize,

    max_frames: usize,
    loop_enabled: bool,
    xruns: u32,
}

impl Engine {
    /// SATU-SATUNYA titik alokasi.
    pub fn new(sample_rate: u32, max_frames: usize) -> Self {
        let max_frames = max_frames.clamp(1, MAX_BLOCK);
        let sr = sample_rate as f32;
        Engine {
            plan: ProcessPlan::silent(),
            incoming: None,
            retired: [None, None, None, None],
            generation: 0,
            scratch: Scratch::new(MAX_BUFFERS, max_frames),
            mixer: Mixer::new(TOTAL_UNITS, TOTAL_SEND_SLOTS, sr),
            fx: FxRack::new(TOTAL_UNITS, sr),
            voices: VoicePool::new(MAX_VOICES, sample_rate),
            assets: AssetTable::new(MAX_ASSETS),
            meters: MeterBank::new(),
            transport: Transport::new(sample_rate),
            queue: EventQueue::new(EVENT_QUEUE_CAP),
            project: Project {
                sample_rate,
                ..Default::default()
            },
            sched: { alloc::vec![0u16; u16::MAX as usize / 8].into_boxed_slice() },
            sched_len: 0,
            sched_cursor: 0,
            max_frames,
            loop_enabled: false,
            xruns: 0,
        }
    }

    /// Bangun engine dari snapshot project (inilah yang diterima worker export).
    pub fn from_snapshot(bytes: &[u8], sample_rate: u32) -> Result<Self, EngineError> {
        let project = Project::from_bytes(bytes).map_err(|_| EngineError::Decode)?;
        let mut e = Engine::new(sample_rate, MAX_BLOCK);
        e.load_project(project)?;
        Ok(e)
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, EngineError> {
        self.project.to_bytes().map_err(|_| EngineError::Decode)
    }

    // ---------------------------------------------------------------- non-RT

    /// Memasang project baru: membangun plan, mengisi parameter, menyusun
    /// jadwal clip. NON-RT — mengalokasi.
    pub fn load_project(&mut self, project: Project) -> Result<(), EngineError> {
        if project.tracks.len() > MAX_TRACKS {
            return Err(EngineError::TooManyTracks);
        }
        self.generation = self.generation.wrapping_add(1);
        let plan = build_plan(&project, self.generation).map_err(EngineError::Plan)?;

        // Parameter mixer + FX.
        for (i, t) in project.tracks.iter().enumerate() {
            let u = track_unit(i);
            if let Some(p) = self.mixer.unit_mut(u) {
                p.set_gain_db(t.gain_db);
                p.set_pan(t.pan);
                p.muted = t.mute;
                p.snap();
            }
            for (si, s) in t.sends.iter().take(MAX_SENDS).enumerate() {
                if let Some(g) = self.mixer.send_mut(send_slot(i, si)) {
                    g.set_immediate(s.amount);
                }
            }
            if let Some(eq) = self.fx.eq_mut(u) {
                eq.set_all(&t.eq);
            }
            if let Some(c) = self.fx.comp_mut(u) {
                c.set_settings(&t.comp);
            }
        }
        for (i, b) in project.buses.iter().enumerate() {
            let u = bus_unit(i);
            if let Some(p) = self.mixer.unit_mut(u) {
                p.set_gain_db(b.gain_db);
                p.set_pan(b.pan);
                p.snap();
            }
            if let Some(eq) = self.fx.eq_mut(u) {
                eq.set_all(&b.eq);
            }
            if let Some(c) = self.fx.comp_mut(u) {
                c.set_settings(&b.comp);
            }
        }

        // Jadwal clip: indeks terurut berdasarkan `start`.
        let mut order: Vec<u16> = (0..project.clips.len().min(self.sched.len()) as u16).collect();
        order.sort_by_key(|i| project.clips[*i as usize].start);
        self.sched_len = order.len();
        self.sched[..order.len()].copy_from_slice(&order);
        self.sched_cursor = 0;

        self.transport.loop_range = project.loop_range;
        self.loop_enabled = project.loop_range.is_some();
        self.project = project;
        self.fx.reset_all();
        self.voices.reset();
        let _ = self.install_plan(plan);
        self.rewind_schedule();
        Ok(())
    }

    pub fn project(&self) -> &Project {
        &self.project
    }

    /// Menyerahkan plan baru ke engine. Swap terjadi di awal blok berikutnya.
    /// Mengembalikan `Err(plan)` kalau daftar pensiun penuh — pemanggil (non-RT)
    /// harus memanggil `take_retired()` dulu.
    pub fn install_plan(&mut self, plan: ProcessPlan) -> Result<(), ProcessPlan> {
        if plan.validate(MAX_BUFFERS).is_err() {
            return Err(plan);
        }
        if self.incoming.is_some() && self.retired.iter().all(|s| s.is_some()) {
            return Err(plan);
        }
        if let Some(old) = self.incoming.take() {
            if self.retire(old).is_err() {
                return Err(plan);
            }
        }
        self.incoming = Some(plan);
        Ok(())
    }

    fn retire(&mut self, plan: ProcessPlan) -> Result<(), ProcessPlan> {
        for slot in self.retired.iter_mut() {
            if slot.is_none() {
                *slot = Some(plan);
                return Ok(());
            }
        }
        Err(plan)
    }

    /// Dipanggil sisi NON-RT: mengambil plan pensiun untuk di-drop di sana.
    pub fn take_retired(&mut self) -> Option<ProcessPlan> {
        for slot in self.retired.iter_mut() {
            if slot.is_some() {
                return slot.take();
            }
        }
        None
    }

    pub fn plan(&self) -> &ProcessPlan {
        &self.plan
    }

    /// # Safety
    /// Lihat `AssetTable::register`.
    pub unsafe fn register_asset(&mut self, id: u16, asset: Asset) {
        unsafe { self.assets.register(id, asset) }
    }

    pub fn unregister_asset(&mut self, id: u16) {
        self.assets.unregister(id);
    }

    pub fn meters(&self) -> &MeterBank {
        &self.meters
    }

    pub fn xrun_count(&self) -> u32 {
        self.xruns
    }

    // ------------------------------------------------------------- transport

    pub fn transport(&self) -> &Transport {
        &self.transport
    }

    pub fn seek(&mut self, pos: TimelineSample) {
        self.transport.seek(pos);
        // Diskontinuitas total: voice di-fade-out singkat, state IIR di-reset,
        // lalu clip yang menaungi posisi baru dimulai di tengah.
        self.voices.reset();
        self.fx.reset_all();
        self.queue.clear();
        self.rewind_schedule();
    }

    pub fn play(&mut self) {
        self.transport.state = TransportState::Playing;
        self.rewind_schedule();
    }

    pub fn stop(&mut self) {
        self.transport.state = TransportState::Stopped;
        self.voices.kill_all();
    }

    /// Menyetel `sched_cursor` ke clip pertama yang mulai >= playhead, lalu
    /// menyalakan voice untuk clip yang SEDANG berlangsung di posisi itu.
    fn rewind_schedule(&mut self) {
        let now = self.transport.playhead;
        let mut cursor = self.sched_len;
        for i in 0..self.sched_len {
            let ci = self.sched[i] as usize;
            let c = match self.project.clips.get(ci) {
                Some(c) => c,
                None => continue,
            };
            if c.start >= now {
                cursor = i;
                break;
            }
            // Clip yang sudah mulai tapi belum selesai → mulai di tengah.
            if now < c.start + c.len {
                let into = now - c.start;
                self.voices.trigger(&VoiceStart {
                    track: c.track,
                    asset: c.asset,
                    source_offset: c.offset + (into as f64 * c.speed) as u64,
                    remaining: c.len - into,
                    total_len: c.len,
                    played: into,
                    gain_db: c.gain_db,
                    fade_in: c.fade_in,
                    fade_out: c.fade_out,
                    fade_curve: c.fade_curve,
                    speed: c.speed,
                });
            }
        }
        self.sched_cursor = cursor;
    }

    /// Waktu mulai clip terjadwal berikutnya — dipakai sebagai batas sub-blok
    /// supaya clip SELALU mulai di sample yang tepat, berapa pun ukuran blok.
    /// Inilah yang membuat render 128-frame dan 1024-frame identik.
    #[inline]
    fn next_clip_start(&self) -> Option<u64> {
        if self.sched_cursor >= self.sched_len {
            return None;
        }
        let ci = *self.sched.get(self.sched_cursor)? as usize;
        self.project.clips.get(ci).map(|c| c.start)
    }

    /// Menyalakan clip yang mulai di dalam [now, now+n).
    fn schedule_span(&mut self, now: u64, n: usize) {
        let end = now + n as u64;
        while self.sched_cursor < self.sched_len {
            let ci = self.sched[self.sched_cursor] as usize;
            let c = match self.project.clips.get(ci) {
                Some(c) => *c,
                None => {
                    self.sched_cursor += 1;
                    continue;
                }
            };
            if c.start >= end {
                break;
            }
            self.sched_cursor += 1;
            if c.len == 0 {
                continue;
            }
            self.voices.trigger(&VoiceStart {
                track: c.track,
                asset: c.asset,
                source_offset: c.offset,
                remaining: c.len,
                total_len: c.len,
                played: 0,
                gain_db: c.gain_db,
                fade_in: c.fade_in,
                fade_out: c.fade_out,
                fade_curve: c.fade_curve,
                speed: c.speed,
            });
        }
    }

    // --------------------------------------------------------------- command

    /// Menerapkan satu command. Kalau `at_sample` di masa depan, ia masuk
    /// antrian dan diterapkan tepat di sample itu lewat sub-blok split.
    pub fn apply(&mut self, cmd: Command) {
        if cmd.at_sample > self.transport.playhead {
            if !self.queue.push(cmd) {
                // Antrian penuh: terapkan sekarang daripada hilang. Ini kompromi
                // yang disengaja — telat beberapa sample lebih baik dari senyap.
                self.apply_now(cmd);
            }
            return;
        }
        self.apply_now(cmd);
    }

    fn apply_now(&mut self, cmd: Command) {
        match cmd.op {
            op::PLAY => self.transport.state = TransportState::Playing,
            op::STOP => {
                self.transport.state = TransportState::Stopped;
                self.voices.kill_all();
            }
            op::SEEK => {
                self.transport.playhead = cmd.at_sample;
                self.voices.kill_all();
                self.rewind_schedule();
            }
            op::SET_GAIN_DB => {
                if let Some(p) = self.mixer.unit_mut(cmd.target) {
                    p.set_gain_db(f32_from_param(cmd.param));
                }
            }
            op::SET_PAN => {
                if let Some(p) = self.mixer.unit_mut(cmd.target) {
                    p.set_pan(f32_from_param(cmd.param));
                }
            }
            op::SET_MUTE => {
                let muted = cmd.param != 0;
                // Mute di-ramp lewat gain supaya tidak klik.
                let restore = db_to_lin(
                    self.project
                        .tracks
                        .get(cmd.target as usize)
                        .map(|t| t.gain_db)
                        .unwrap_or(0.0),
                );
                if let Some(p) = self.mixer.unit_mut(cmd.target) {
                    p.muted = muted;
                    p.set_gain_lin(if muted { 0.0 } else { restore });
                }
            }
            op::SET_SEND => {
                let slot = send_slot(cmd.target as usize, cmd.flags as usize);
                if let Some(g) = self.mixer.send_mut(slot) {
                    g.set_target(f32_from_param(cmd.param));
                }
            }
            op::SET_LOOP_START => {
                let end = self.transport.loop_range.map(|r| r.1).unwrap_or(u64::MAX);
                self.transport.loop_range = Some((cmd.at_sample, end));
            }
            op::SET_LOOP_END => {
                let start = self.transport.loop_range.map(|r| r.0).unwrap_or(0);
                self.transport.loop_range = Some((start, cmd.at_sample));
            }
            op::SET_LOOP_ENABLED => {
                self.loop_enabled = cmd.param != 0;
            }
            op::TRIGGER_CLIP => {
                if let Some(c) = self.project.clips.get(cmd.target as usize).copied() {
                    self.voices.trigger(&VoiceStart {
                        track: c.track,
                        asset: c.asset,
                        source_offset: c.offset,
                        remaining: c.len,
                        total_len: c.len,
                        played: 0,
                        gain_db: c.gain_db,
                        fade_in: c.fade_in,
                        fade_out: c.fade_out,
                        fade_curve: c.fade_curve,
                        speed: c.speed,
                    });
                }
            }
            op::STOP_ALL_VOICES => self.voices.kill_all(),
            _ => {}
        }
    }

    /// Menguras ring command dari UI. Wait-free: kalau ring kosong, engine
    /// tidak menunggu apa pun, ia langsung merender dengan state yang ada.
    pub fn drain_commands(&mut self, rx: &mut daw_rt::SpscConsumer) {
        while let Some(c) = rx.pop() {
            self.apply(c);
        }
    }

    // ---------------------------------------------------------------- render

    /// JALUR RENDER SATU-SATUNYA. Zero alloc, no panic.
    ///
    /// Loop sub-blok mengikuti docs/02 §2c: terapkan semua event yang jatuh di
    /// playhead saat ini, potong sub-blok di event berikutnya (atau batas loop),
    /// render span itu, ulangi.
    pub fn render_block(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let frames = out_l.len().min(out_r.len()).min(self.max_frames);
        if frames == 0 {
            return;
        }

        // Swap plan sekali di awal blok; plan lama dipensiunkan, TIDAK di-drop
        // di sini (drop = dealloc = terlarang di jalur RT). Kalau daftar pensiun
        // penuh, swap DITUNDA sampai sisi non-RT memanggil `take_retired()`.
        let can_retire = self.retired.iter().any(|s| s.is_none());
        if can_retire && self.incoming.is_some() {
            if let Some(next) = self.incoming.take() {
                let old = core::mem::replace(&mut self.plan, next);
                if self.retire(old).is_err() {
                    self.xruns = self.xruns.wrapping_add(1);
                }
            }
        }

        self.meters.begin_block(frames as u32);
        self.fx.begin_block();

        let mut offset = 0usize;
        while offset < frames {
            // 1. Terapkan semua event yang jatuh tepat di playhead sekarang.
            while let Some(ev) = self.queue.peek_at(self.transport.playhead) {
                self.queue.pop();
                self.apply_now(ev);
            }

            // 2. Nyalakan clip yang mulai TEPAT di playhead ini.
            if self.transport.playing() {
                self.schedule_span(self.transport.playhead, 1);
            }

            // 3. Sub-blok berhenti di event berikutnya, awal clip berikutnya,
            //    batas loop, atau akhir blok — mana yang paling dekat.
            let remaining = frames - offset;
            let mut n = remaining;
            if self.transport.playing() {
                if let Some(t) = self.next_clip_start() {
                    let d = t.saturating_sub(self.transport.playhead) as usize;
                    if d < n {
                        n = d;
                    }
                }
            }
            if let Some(t) = self.queue.next_time() {
                let d = t.saturating_sub(self.transport.playhead) as usize;
                if d < n {
                    n = d;
                }
            }
            let mut wrap = false;
            if self.loop_enabled {
                if let Some(d) = self.transport.frames_to_loop_end(n) {
                    if d < n {
                        n = d;
                        wrap = true;
                    }
                } else if let Some((_, end)) = self.transport.loop_range {
                    if self.transport.playing() && self.transport.playhead + (n as u64) == end {
                        wrap = true;
                    }
                }
            }
            // Jaring pengaman tanpa biaya: sub-blok minimal 1 sample.
            let n = n.max(1).min(remaining);

            self.render_span(out_l, out_r, offset, n);
            offset += n;
            if self.transport.playing() {
                self.transport.advance(n);
            }

            if wrap {
                // Loop jump: playhead kembali ke awal loop, voice di-retrigger
                // dengan micro-fade 2 ms supaya tidak klik (docs/02 §2c).
                self.transport.wrap_loop();
                self.voices.kill_all();
                self.rewind_schedule();
            }
        }

        // Gain reduction kompresor → meter.
        for i in 0..self.project.tracks.len().min(MAX_TRACKS) {
            let u = track_unit(i);
            self.meters.set_gain_reduction(u, self.fx.gain_reduction(u));
        }
        if let Some(m) = self.project.master_bus() {
            self.meters.set_gain_reduction(
                MASTER_METER_SLOT,
                self.fx.gain_reduction(bus_unit(m as usize)),
            );
        }

        // Flush denormal sekali per blok, bukan per sample (docs/02 §2b).
        self.mixer.flush_denormals();
    }

    /// Menjalankan ProcessPlan untuk satu span [offset, offset+n).
    fn render_span(&mut self, out_l: &mut [f32], out_r: &mut [f32], offset: usize, n: usize) {
        // Destrukturisasi supaya borrow checker melihat field-field terpisah.
        let Engine {
            plan,
            scratch,
            mixer,
            fx,
            voices,
            assets,
            meters,
            ..
        } = self;

        let count = plan.buffer_count;
        for step in plan.steps.iter() {
            match *step {
                Step::ClearBuf { buf } => {
                    if buf >= count {
                        continue;
                    }
                    let (l, r) = scratch.one(buf, offset, n);
                    clear(l);
                    clear(r);
                }
                Step::RenderClips { track, dst } => {
                    if dst >= count {
                        continue;
                    }
                    let (l, r) = scratch.one(dst, offset, n);
                    voices.render_track(track, assets, l, r);
                }
                Step::Fx { node, buf } => {
                    if buf >= count {
                        continue;
                    }
                    let (l, r) = scratch.one(buf, offset, n);
                    if let Some(node) = fx.get_mut(node) {
                        node.process(l, r);
                    }
                }
                Step::Fader { track, buf } => {
                    if buf >= count {
                        continue;
                    }
                    let (l, r) = scratch.one(buf, offset, n);
                    if let Some(p) = mixer.unit_mut(track) {
                        apply_fader(&mut p.gain, l, r);
                    }
                }
                Step::Meter { slot, buf } => {
                    if buf >= count {
                        continue;
                    }
                    let (l, r) = scratch.one(buf, offset, n);
                    meters.measure(slot, l, r);
                }
                Step::PanAdd { src, dst, pan } => {
                    if src >= count || dst >= count || src == dst {
                        continue;
                    }
                    let (sl, sr, dl, dr) = scratch.two(src, dst, offset, n);
                    if let Some(p) = mixer.unit_mut(pan) {
                        pan_add(&mut p.pan_l, &mut p.pan_r, sl, sr, dl, dr);
                    }
                }
                Step::SendAdd { src, dst, amount } => {
                    if src >= count || dst >= count || src == dst {
                        continue;
                    }
                    let (sl, sr, dl, dr) = scratch.two(src, dst, offset, n);
                    if let Some(g) = mixer.send_mut(amount) {
                        // Send memakai ramp per blok (g0→g1) — cukup halus untuk
                        // amount yang tidak pernah bergerak secepat fader.
                        let g0 = g.next();
                        let mut g1 = g0;
                        for _ in 1..n {
                            g1 = g.next();
                        }
                        add_scaled_ramp_pair(dl, dr, sl, sr, g0, g1);
                    }
                }
            }
        }

        // Salin master ke output.
        let out = plan.out_buf;
        if out < count {
            let (l, r) = scratch.one(out, offset, n);
            let ol = &mut out_l[offset..offset + n];
            let orr = &mut out_r[offset..offset + n];
            ol.copy_from_slice(l);
            orr.copy_from_slice(r);
        } else {
            clear(&mut out_l[offset..offset + n]);
            clear(&mut out_r[offset..offset + n]);
        }
    }
}

#[inline]
fn add_scaled_ramp_pair(dl: &mut [f32], dr: &mut [f32], sl: &[f32], sr: &[f32], g0: f32, g1: f32) {
    if g0 == g1 {
        add_scaled(dl, sl, g0);
        add_scaled(dr, sr, g0);
    } else {
        daw_dsp::add_scaled_ramp(dl, sl, g0, g1);
        daw_dsp::add_scaled_ramp(dr, sr, g0, g1);
    }
}

#[cfg(test)]
mod tests;
