//! Pool insert chain per-clip.
//!
//! ## Bentuk yang dipilih, dan kenapa bukan yang lebih ambisius
//!
//! Rancangan yang lebih kaya adalah kolam rak yang DIPEREBUTKAN voice: clip
//! yang berbunyi meminjam rak, melepasnya setelah ekornya habis, dan mencuri
//! dari yang paling pelan kalau habis. Itu memberi jumlah clip ber-efek yang
//! tak terbatas selama yang berbunyi bersamaan sedikit.
//!
//! Harganya: rak harus dibangun ULANG saat dipinjam, karena clip berikutnya
//! bisa memakai jenis efek yang berbeda — dan membangun node berarti mengalokasi,
//! di `render_block`, yang dilarang mutlak (docs/01 §1c). Menyiasatinya menuntut
//! tiap slot pool menyediakan SEMUA jenis efek sekaligus, yang biayanya jauh
//! lebih besar daripada yang dihemat.
//!
//! Jadi bentuk yang dipakai adalah yang paling sederhana yang benar: rak
//! dialokasikan per CLIP saat project dimuat, sekali, dan tidak pernah dilepas.
//! Batasnya [`MAX_CLIP_CHAINS`] clip ber-efek per project, dan kelebihannya
//! dilaporkan sebagai peringatan alih-alih dipotong diam-diam.
//!
//! Yang didapat sebagai gantinya bukan sedikit: nol alokasi, nol pencurian
//! slot, nol kondisi balapan di jalur render — dan ekor delay/reverb TIDAK
//! PERNAH terpotong saat playhead keluar clip, yang justru keberatan utama
//! `docs/06 §6e` terhadap insert per-clip.

use alloc::boxed::Box;
use alloc::vec;
use alloc::vec::Vec;

use daw_rt::MAX_BLOCK;

use crate::snapshot::{FxSlotDesc, Project, MAX_CLIP_CHAINS};

use super::registry::FxKind;
use super::FxRack;

/// Satu rak milik satu clip, plus pembukuan ekornya.
struct Entry {
    rack: FxRack,
    /// Track tempat hasilnya dijumlahkan.
    track: u16,
    /// Sisa frame sebelum rak boleh berhenti diproses. Dihitung dari
    /// `tail_frames()` — fungsi MURNI dari parameter, bukan pengukuran energi.
    keepalive: u32,
}

pub struct ClipFxPool {
    entries: Vec<Entry>,
    /// Buffer kerja stereo. Satu saja: rak diproses satu per satu, tidak pernah
    /// bersarang.
    scratch: Box<[f32]>,
    /// Berapa clip ber-efek yang tidak kebagian slot. Dipublikasikan ke UI.
    starved: u32,
}

impl ClipFxPool {
    pub fn empty(_sample_rate: f32) -> Self {
        ClipFxPool {
            entries: Vec::new(),
            scratch: vec![0.0f32; MAX_BLOCK * 2].into_boxed_slice(),
            starved: 0,
        }
    }

    /// Bangun pool dari project. NON-RT.
    pub fn build(p: &Project, sample_rate: f32) -> Self {
        let mut pool = ClipFxPool::empty(sample_rate);
        for (slot, chain) in p.clip_chains.iter().take(MAX_CLIP_CHAINS).enumerate() {
            // Track pemilik diambil dari clip PERTAMA yang menunjuk slot ini.
            // Semua clip yang berbagi slot pasti berada di track yang sama —
            // `map_project` yang menjaminnya, karena ia mengalokasikan slot
            // per clip.
            let track = p
                .clips
                .iter()
                .find(|c| c.chain_slot == Some(slot as u8))
                .map(|c| c.track)
                .unwrap_or(0);
            let kinds: Vec<(FxKind, bool)> = chain
                .iter()
                .filter_map(|d: &FxSlotDesc| {
                    FxKind::from_u16(d.kind).map(|k| (k, d.bypass))
                })
                .collect();
            let mut rack = FxRack::chain(&kinds, sample_rate);
            // Parameter dipasang di sini, sekali, bukan tiap blok.
            let mut i = 0usize;
            for d in chain.iter() {
                if FxKind::from_u16(d.kind).is_none() {
                    continue;
                }
                for (pi, v) in d.params.iter().enumerate() {
                    rack.set_param(i, pi, *v);
                }
                i += 1;
            }
            pool.entries.push(Entry {
                rack,
                track,
                keepalive: 0,
            });
        }
        pool
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[inline]
    pub fn starved(&self) -> u32 {
        self.starved
    }

    pub fn set_starved(&mut self, n: u32) {
        self.starved = n;
    }

    /// Apakah slot ini masih perlu diproses walau tidak ada voice yang aktif.
    #[inline]
    pub fn is_ringing(&self, slot: u8) -> bool {
        self.entries
            .get(slot as usize)
            .map(|e| e.keepalive > 0)
            .unwrap_or(false)
    }

    #[inline]
    pub fn track_of(&self, slot: u8) -> Option<u16> {
        self.entries.get(slot as usize).map(|e| e.track)
    }

    /// Jalankan rak slot ini pada buffer kerja, lalu jumlahkan ke `l`/`r`.
    ///
    /// `had_input` menandai apakah ada voice yang benar-benar mengisi buffer
    /// kerja di blok ini. Kalau tidak, ekornya yang sedang berbunyi — dan
    /// hitungan mundurnya jalan.
    pub fn process_into(
        &mut self,
        slot: u8,
        had_input: bool,
        l: &mut [f32],
        r: &mut [f32],
        n: usize,
    ) {
        let ClipFxPool {
            entries, scratch, ..
        } = self;
        let Some(e) = entries.get_mut(slot as usize) else {
            return;
        };
        let (sl, sr_buf) = scratch.split_at_mut(MAX_BLOCK);
        let (Some(sl), Some(sr_buf)) = (sl.get_mut(..n), sr_buf.get_mut(..n)) else {
            return;
        };

        e.rack.begin_block();
        e.rack.process_all(sl, sr_buf);
        e.rack.end_block(n as u32);

        for i in 0..n {
            l[i] += sl[i];
            r[i] += sr_buf[i];
        }

        if had_input {
            // Ekornya dihitung ulang dari parameter tiap kali ada materi baru.
            e.keepalive = e.rack.tail_frames().max(1);
        } else {
            e.keepalive = e.keepalive.saturating_sub(n as u32);
        }
    }

    /// Pinjam buffer kerja untuk diisi voice, lalu nolkan dulu.
    #[inline]
    pub fn scratch_mut(&mut self, n: usize) -> Option<(&mut [f32], &mut [f32])> {
        let (a, b) = self.scratch.split_at_mut(MAX_BLOCK);
        let (Some(a), Some(b)) = (a.get_mut(..n), b.get_mut(..n)) else {
            return None;
        };
        for v in a.iter_mut().chain(b.iter_mut()) {
            *v = 0.0;
        }
        Some((a, b))
    }

    /// Reset penuh — seek, loop wrap, ganti project.
    ///
    /// Ekor yang selamat dari seek berarti render yang dimulai dari seek
    /// berbeda dari bounce yang mulai bersih di posisi yang sama, dan itu
    /// pelanggaran null-test langsung.
    pub fn reset_all(&mut self) {
        for e in self.entries.iter_mut() {
            e.rack.reset_all();
            e.keepalive = 0;
        }
        for v in self.scratch.iter_mut() {
            *v = 0.0;
        }
    }
}
