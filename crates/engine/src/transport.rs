//! Transport: playhead `u64` sample sebagai SATU-SATUNYA sumber kebenaran.
//!
//! `AudioContext.currentTime` tidak dipakai (docs/02 §2c): ia f64 detik yang
//! di-quantize implementasi, menyatakan waktu OUTPUT bukan posisi RENDER, dan
//! bisa melompat saat suspend/resume. Konversi ke detik/bar/beat hanya di UI.

use daw_timeline::TimelineSample;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum TransportState {
    Stopped = 0,
    Playing = 1,
    Recording = 2,
}

#[derive(Copy, Clone, Debug)]
pub struct Transport {
    /// Sample sejak awal timeline.
    pub playhead: u64,
    pub state: TransportState,
    pub loop_range: Option<(u64, u64)>,
    pub sample_rate: u32,
}

impl Transport {
    pub fn new(sample_rate: u32) -> Self {
        Transport {
            playhead: 0,
            state: TransportState::Stopped,
            loop_range: None,
            sample_rate,
        }
    }

    #[inline]
    pub fn playing(&self) -> bool {
        !matches!(self.state, TransportState::Stopped)
    }

    #[inline]
    pub fn position(&self) -> TimelineSample {
        TimelineSample(self.playhead)
    }

    /// Berapa sample lagi sampai batas loop, kalau batas itu jatuh di dalam
    /// `frames` berikutnya. Dipakai untuk memotong sub-blok tepat di batas loop.
    #[inline]
    pub fn frames_to_loop_end(&self, frames: usize) -> Option<usize> {
        let (start, end) = self.loop_range?;
        if !self.playing() || end <= start || self.playhead >= end {
            return None;
        }
        let remain = end - self.playhead;
        if remain < frames as u64 {
            Some(remain as usize)
        } else {
            None
        }
    }

    /// Lompat ke awal loop. Voice di-retrigger dengan micro-fade oleh pemanggil.
    #[inline]
    pub fn wrap_loop(&mut self) {
        if let Some((start, _)) = self.loop_range {
            self.playhead = start;
        }
    }

    #[inline]
    pub fn advance(&mut self, frames: usize) {
        self.playhead = self.playhead.wrapping_add(frames as u64);
    }

    pub fn seek(&mut self, pos: TimelineSample) {
        self.playhead = pos.0;
    }
}
