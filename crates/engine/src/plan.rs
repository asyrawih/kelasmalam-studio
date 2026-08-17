//! ProcessPlan datar + alokator buffer *linear scan*.
//!
//! Lihat docs/02 §2a. Intinya: topologi graph jarang berubah tapi diproses
//! 375×/detik, jadi topo-sort dan alokasi buffer dikerjakan SEKALI di sisi
//! non-RT, hasilnya berupa daftar `Step` datar yang dieksekusi audio thread
//! tanpa pointer chasing, tanpa `dyn`, tanpa cabang yang tak terprediksi.

use alloc::boxed::Box;
use alloc::vec::Vec;

/// Satu instruksi render. Sengaja `Copy` + 8 byte supaya seluruh plan muat di L1.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nolkan buffer scratch (mendefinisikan nilai baru → titik awal live range).
    ClearBuf { buf: u16 },
    /// Render semua voice milik `track` ke `dst` (source PCM → clip gain → clip fade).
    RenderClips { track: u16, dst: u16 },
    /// Efek insert in-place. `node` = indeks ke tabel FxNode datar.
    Fx { node: u16, buf: u16 },
    /// Fader track/bus (gain ter-smooth per sample), in-place.
    Fader { track: u16, buf: u16 },
    /// Pan equal-power (-3 dB di tengah) lalu *sum* ke `dst`. `pan` = indeks unit param.
    PanAdd { src: u16, dst: u16, pan: u16 },
    /// Send post-fader: `dst += src * amount`. `amount` = indeks ke tabel send gain.
    SendAdd { src: u16, dst: u16, amount: u16 },
    /// Tulis peak/RMS/GR ke slot meter (`slot` 0..MAX_TRACKS-1 = track, MAX_TRACKS = master).
    Meter { slot: u16, buf: u16 },
}

impl Step {
    /// Semua buffer yang disentuh step ini (untuk analisis live range).
    #[inline]
    fn touched(&self, out: &mut [u16; 2]) -> usize {
        match *self {
            Step::ClearBuf { buf } => {
                out[0] = buf;
                1
            }
            Step::RenderClips { dst, .. } => {
                out[0] = dst;
                1
            }
            Step::Fx { buf, .. } | Step::Fader { buf, .. } | Step::Meter { buf, .. } => {
                out[0] = buf;
                1
            }
            Step::PanAdd { src, dst, .. } | Step::SendAdd { src, dst, .. } => {
                out[0] = src;
                out[1] = dst;
                2
            }
        }
    }

    /// Menulis ulang id buffer virtual → fisik.
    #[inline]
    fn remap(&mut self, map: &[u16]) {
        let m = |b: u16| -> u16 { *map.get(b as usize).unwrap_or(&0) };
        match self {
            Step::ClearBuf { buf } => *buf = m(*buf),
            Step::RenderClips { dst, .. } => *dst = m(*dst),
            Step::Fx { buf, .. } => *buf = m(*buf),
            Step::Fader { buf, .. } => *buf = m(*buf),
            Step::Meter { buf, .. } => *buf = m(*buf),
            Step::PanAdd { src, dst, .. } => {
                *src = m(*src);
                *dst = m(*dst);
            }
            Step::SendAdd { src, dst, .. } => {
                *src = m(*src);
                *dst = m(*dst);
            }
        }
    }
}

/// Rencana render yang sudah jadi. Dibangun di luar RT, ditukar atomik di awal blok.
#[derive(Clone, Debug)]
pub struct ProcessPlan {
    pub steps: Box<[Step]>,
    /// Jumlah scratch stereo minimum hasil linear scan.
    pub buffer_count: u16,
    /// Buffer yang berisi hasil akhir master.
    pub out_buf: u16,
    /// Dinaikkan tiap plan baru; dipakai UI untuk tahu plan mana yang aktif.
    pub generation: u32,
}

impl ProcessPlan {
    /// Plan kosong (dipakai sebelum project pertama dimuat) — output senyap.
    pub fn silent() -> Self {
        ProcessPlan {
            steps: Vec::from([Step::ClearBuf { buf: 0 }]).into_boxed_slice(),
            buffer_count: 1,
            out_buf: 0,
            generation: 0,
        }
    }

    /// Validasi invariant yang dipakai jalur RT untuk TIDAK melakukan bounds-panic.
    pub fn validate(&self, max_buffers: usize) -> Result<(), PlanError> {
        if self.buffer_count as usize > max_buffers {
            return Err(PlanError::OutOfBuffers);
        }
        if self.out_buf >= self.buffer_count {
            return Err(PlanError::BadPlan);
        }
        let mut t = [0u16; 2];
        for s in self.steps.iter() {
            let n = s.touched(&mut t);
            for b in t.iter().take(n) {
                if *b >= self.buffer_count {
                    return Err(PlanError::BadPlan);
                }
            }
        }
        Ok(())
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PlanError {
    /// Linear scan butuh lebih dari MAX_BUFFERS scratch → penambahan node ditolak
    /// di UI, BUKAN dialokasi di RT (docs/02 §2a).
    OutOfBuffers,
    /// Graph bus mengandung siklus.
    Cycle,
    BadPlan,
}

/// Interval hidup sebuah buffer virtual: [first, last] dalam indeks step.
#[derive(Copy, Clone)]
struct Live {
    vbuf: u16,
    first: u32,
    last: u32,
}

/// Alokator *linear scan* — persis masalah register allocation di compiler.
///
/// Buffer virtual (satu per "nilai") dipetakan ke buffer fisik dengan menyapu
/// interval yang sudah terurut berdasarkan titik definisi; buffer fisik yang
/// intervalnya sudah lewat dikembalikan ke free stack dan dipakai ulang.
/// Hasilnya = jumlah scratch minimum untuk plan ini.
pub fn allocate_buffers(steps: &mut [Step], max_buffers: usize) -> Result<u16, PlanError> {
    // 1. Kumpulkan live range tiap buffer virtual.
    let mut n_virtual = 0usize;
    let mut t = [0u16; 2];
    for s in steps.iter() {
        let n = s.touched(&mut t);
        for b in t.iter().take(n) {
            n_virtual = n_virtual.max(*b as usize + 1);
        }
    }
    if n_virtual == 0 {
        return Ok(0);
    }

    let mut lives: Vec<Live> = Vec::with_capacity(n_virtual);
    for v in 0..n_virtual {
        lives.push(Live {
            vbuf: v as u16,
            first: u32::MAX,
            last: 0,
        });
    }
    for (i, s) in steps.iter().enumerate() {
        let n = s.touched(&mut t);
        for b in t.iter().take(n) {
            let l = &mut lives[*b as usize];
            if l.first == u32::MAX {
                l.first = i as u32;
            }
            l.last = i as u32;
        }
    }
    // Buffer virtual yang tidak pernah muncul tidak ada (kita sudah scan), tapi
    // jaga-jaga: buang yang first == MAX.
    lives.retain(|l| l.first != u32::MAX);
    lives.sort_by_key(|l| (l.first, l.last));

    // 2. Sapuan linear.
    let mut map: Vec<u16> = alloc::vec![0; n_virtual];
    // active: (last_step, phys) — kecil (<= MAX_BUFFERS), linear scan lebih cepat dari heap.
    let mut active: Vec<(u32, u16)> = Vec::with_capacity(max_buffers);
    let mut free: Vec<u16> = Vec::with_capacity(max_buffers);
    let mut next_phys: u16 = 0;

    for l in lives.iter() {
        // Pensiunkan interval yang sudah mati sebelum titik definisi ini.
        let mut i = 0;
        while i < active.len() {
            if active[i].0 < l.first {
                let (_, phys) = active.swap_remove(i);
                free.push(phys);
            } else {
                i += 1;
            }
        }
        let phys = match free.pop() {
            Some(p) => p,
            None => {
                if next_phys as usize >= max_buffers {
                    return Err(PlanError::OutOfBuffers);
                }
                let p = next_phys;
                next_phys += 1;
                p
            }
        };
        map[l.vbuf as usize] = phys;
        active.push((l.last, phys));
    }

    for s in steps.iter_mut() {
        s.remap(&map);
    }
    Ok(next_phys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use daw_rt::MAX_BUFFERS;

    #[test]
    fn linear_scan_reuses_dead_buffers() {
        // Dua "track" berurutan yang masing-masing pakai buffer sendiri lalu
        // menyumbangkannya ke master → harus cukup 2 buffer fisik.
        let mut steps = alloc::vec![
            Step::ClearBuf { buf: 0 }, // master
            Step::ClearBuf { buf: 1 },
            Step::PanAdd {
                src: 1,
                dst: 0,
                pan: 0
            },
            Step::ClearBuf { buf: 2 },
            Step::PanAdd {
                src: 2,
                dst: 0,
                pan: 1
            },
            Step::Meter { slot: 32, buf: 0 },
        ];
        let n = allocate_buffers(&mut steps, MAX_BUFFERS).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn out_of_buffers_is_an_error_not_an_allocation() {
        let mut steps: Vec<Step> = (0..(MAX_BUFFERS as u16 + 4))
            .map(|b| Step::ClearBuf { buf: b })
            .collect();
        // Semua hidup bersamaan karena semuanya dipakai di akhir.
        for b in 0..(MAX_BUFFERS as u16 + 4) {
            steps.push(Step::Meter { slot: b, buf: b });
        }
        assert_eq!(
            allocate_buffers(&mut steps, MAX_BUFFERS),
            Err(PlanError::OutOfBuffers)
        );
    }
}
