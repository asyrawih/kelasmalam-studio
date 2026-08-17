//! Meter feedback (audio → UI) lewat blok METER di SAB, ditulis dengan SeqLock.
//!
//! SeqLock dipilih karena writer-nya adalah audio thread: writer TIDAK PERNAH
//! menunggu siapa pun (docs/01 §1b). Reader (UI) yang mengulang baca kalau
//! seq berubah atau ganjil.
//!
//! Layout satu slot = 32 byte, 33 slot (32 track + master):
//!   f32 peak_l, peak_r, rms_l, rms_r, gain_reduction_db, u32 clip_hold_frames,
//!   u64 padding.

use alloc::boxed::Box;
use alloc::vec::Vec;

use daw_dsp::{peak as peak_of, rms as rms_of};

/// Ukuran satu slot meter dalam byte (docs/01 §1b).
pub const METER_SLOT_BYTES: usize = 32;
/// 32 track + master.
pub const METER_SLOTS: usize = 33;
/// Berapa lama indikator clip ditahan (frame) setelah sample >= 1.0.
pub const CLIP_HOLD_FRAMES: u32 = 48_000;

/// `repr(C)` + padding eksplisit ke 32 byte supaya struct ini BENAR-BENAR
/// bertata letak sama dengan blok METER di SAB (docs/01 §1b) — bukan sekadar
/// mirip. Ini yang membuat `SeqWriter<MeterBlock>` bisa menulisnya utuh.
#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct MeterSlot {
    pub peak_l: f32,
    pub peak_r: f32,
    pub rms_l: f32,
    pub rms_r: f32,
    pub gain_reduction_db: f32,
    pub clip_hold_frames: u32,
    _pad: u64,
}

/// Seluruh blok meter — satu nilai yang ditulis atomik lewat SeqLock.
#[repr(C)]
#[derive(Copy, Clone)]
pub struct MeterBlock {
    pub slots: [MeterSlot; METER_SLOTS],
}

impl Default for MeterBlock {
    fn default() -> Self {
        MeterBlock {
            slots: [MeterSlot::default(); METER_SLOTS],
        }
    }
}

/// Kumpulan nilai meter untuk satu blok. Nilai mentah; ballistics release
/// (~300 ms) dikerjakan di sisi UI supaya audio thread tetap sesederhana mungkin.
pub struct MeterBank {
    slots: Box<[MeterSlot]>,
}

const _: () = {
    assert!(core::mem::size_of::<MeterSlot>() == METER_SLOT_BYTES);
    assert!(core::mem::size_of::<MeterBlock>() == METER_SLOT_BYTES * METER_SLOTS);
};

impl MeterBank {
    pub fn new() -> Self {
        let mut v = Vec::with_capacity(METER_SLOTS);
        v.resize(METER_SLOTS, MeterSlot::default());
        MeterBank {
            slots: v.into_boxed_slice(),
        }
    }

    /// Awal blok penuh: peak/RMS di-reset, clip hold dihitung mundur.
    pub fn begin_block(&mut self, frames: u32) {
        for s in self.slots.iter_mut() {
            s.peak_l = 0.0;
            s.peak_r = 0.0;
            s.rms_l = 0.0;
            s.rms_r = 0.0;
            s.gain_reduction_db = 0.0;
            s.clip_hold_frames = s.clip_hold_frames.saturating_sub(frames);
        }
    }

    /// Dipanggil oleh `Step::Meter`. Bisa dipanggil beberapa kali per blok
    /// (sub-blok split) → kita ambil maksimum.
    #[inline]
    pub fn measure(&mut self, slot: u16, l: &[f32], r: &[f32]) {
        let s = match self.slots.get_mut(slot as usize) {
            Some(s) => s,
            None => return,
        };
        let pl = peak_of(l);
        let pr = peak_of(r);
        if pl > s.peak_l {
            s.peak_l = pl;
        }
        if pr > s.peak_r {
            s.peak_r = pr;
        }
        let rl = rms_of(l);
        let rr = rms_of(r);
        if rl > s.rms_l {
            s.rms_l = rl;
        }
        if rr > s.rms_r {
            s.rms_r = rr;
        }
        if pl >= 1.0 || pr >= 1.0 {
            s.clip_hold_frames = CLIP_HOLD_FRAMES;
        }
    }

    #[inline]
    pub fn set_gain_reduction(&mut self, slot: u16, gr_db: f32) {
        if let Some(s) = self.slots.get_mut(slot as usize) {
            if gr_db > s.gain_reduction_db {
                s.gain_reduction_db = gr_db;
            }
        }
    }

    #[inline]
    pub fn slot(&self, i: usize) -> Option<&MeterSlot> {
        self.slots.get(i)
    }

    /// Serialisasi ke buffer byte dengan layout SAB persis. Dipisah dari
    /// penulisan SeqLock supaya bisa diuji tanpa shared memory.
    pub fn encode(&self, out: &mut [u8]) {
        for (i, s) in self.slots.iter().enumerate() {
            let base = i * METER_SLOT_BYTES;
            if base + METER_SLOT_BYTES > out.len() {
                return;
            }
            let f = [
                s.peak_l.to_le_bytes(),
                s.peak_r.to_le_bytes(),
                s.rms_l.to_le_bytes(),
                s.rms_r.to_le_bytes(),
                s.gain_reduction_db.to_le_bytes(),
            ];
            for (j, b) in f.iter().enumerate() {
                out[base + j * 4..base + j * 4 + 4].copy_from_slice(b);
            }
            out[base + 20..base + 24].copy_from_slice(&s.clip_hold_frames.to_le_bytes());
            out[base + 24..base + 32].copy_from_slice(&0u64.to_le_bytes());
        }
    }
}

impl Default for MeterBank {
    fn default() -> Self {
        Self::new()
    }
}

impl MeterBank {
    /// Salin ke satu nilai `MeterBlock` yang siap ditulis lewat SeqLock.
    pub fn to_block(&self, out: &mut MeterBlock) {
        let n = self.slots.len().min(METER_SLOTS);
        out.slots[..n].copy_from_slice(&self.slots[..n]);
    }
}

/// Publikasi meter ke SAB. Writer (audio thread) TIDAK PERNAH menunggu:
/// `SeqWriter::write` hanya menaikkan seq → tulis → naikkan seq lagi.
/// Reader (UI) yang mengulang kalau seq-nya ganjil atau berubah.
#[inline]
pub fn publish(bank: &MeterBank, writer: &mut daw_rt::SeqWriter<MeterBlock>, tmp: &mut MeterBlock) {
    bank.to_block(tmp);
    writer.write(tmp);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_slot_layout() {
        let mut b = MeterBank::new();
        b.measure(0, &[0.5, -0.25], &[0.125, 0.0]);
        let mut buf = alloc::vec![0u8; METER_SLOTS * METER_SLOT_BYTES];
        b.encode(&mut buf);
        assert_eq!(f32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]), 0.5);
        assert_eq!(f32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]), 0.125);
        assert_eq!(buf.len(), 33 * 32);
    }
}
