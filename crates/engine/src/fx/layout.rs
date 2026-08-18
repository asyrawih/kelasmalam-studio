//! Penomoran node FX — **satu-satunya tempat** indeks node dihitung.
//!
//! `Step::Fx { node }` menunjuk baris di tabel node datar milik [`FxRack`].
//! Kalau `build_plan` dan `FxRack` menghitung penomoran itu sendiri-sendiri,
//! keduanya bisa menyimpang tanpa error apa pun — dan gejalanya adalah efek
//! yang memproses buffer track yang salah, atau membaca parameter milik efek
//! lain. Karena itu keduanya mengonsumsi [`plan_chains`].
//!
//! ## Tata letak
//!
//! ```text
//! node 0 .. TOTAL_UNITS*2    EQ dan kompresor bawaan, DUA per unit
//!                            (unit*2 = EQ, unit*2+1 = kompresor)
//! node TOTAL_UNITS*2 ..      insert chain user, urut per unit lalu per slot
//! ```
//!
//! Blok bawaan sengaja dipertahankan padat dan lebih dulu, jadi aritmetika
//! `unit*2` yang sudah dipakai `eq_mut`/`comp_mut` tetap berlaku persis. Chain
//! user ditambahkan di belakangnya, sehingga menambah atau menghapus satu efek
//! tidak pernah menggeser nomor node efek bawaan.

use alloc::vec::Vec;

use crate::graph::{bus_unit, track_unit, TOTAL_UNITS};
use crate::plan::PlanError;
use crate::snapshot::{FxSlotDesc, Project, MAX_CHAIN_LEN};

use super::arena::{FxArena, MemHandle};
use super::registry::FxKind;

/// Jumlah node bawaan per unit: EQ lalu kompresor.
pub const BUILTIN_PER_UNIT: usize = 2;

/// Node bawaan seluruhnya — awal wilayah chain user.
pub const BUILTIN_NODES: usize = TOTAL_UNITS * BUILTIN_PER_UNIT;

/// Satu efek user yang terpasang, beserta tempatnya di tabel node dan arena.
#[derive(Clone, Debug)]
pub struct ChainEntry {
    /// Track atau bus pemiliknya.
    pub unit: u16,
    /// Posisi di dalam chain unit itu (0..MAX_CHAIN_LEN).
    pub slot: u8,
    pub kind: FxKind,
    /// Indeks di tabel node datar — yang masuk `Step::Fx`.
    pub node: u16,
    pub bypass: bool,
    /// Nilai parameter, diindeks urutan `EffectDesc::params`.
    pub params: Vec<f32>,
    /// Region arena; kosong untuk efek yang tidak butuh memori.
    pub mem: MemHandle,
}

/// Hasil penomoran untuk satu project.
#[derive(Clone, Debug, Default)]
pub struct FxLayout {
    /// Hanya chain USER; node bawaan tersirat di `0..BUILTIN_NODES`.
    pub entries: Vec<ChainEntry>,
}

impl FxLayout {
    /// Ukuran tabel node yang harus disediakan rak.
    pub fn total_nodes(&self) -> usize {
        BUILTIN_NODES + self.entries.len()
    }

    /// Entri milik satu unit, urut slot.
    pub fn entries_for(&self, unit: u16) -> impl Iterator<Item = &ChainEntry> {
        self.entries.iter().filter(move |e| e.unit == unit)
    }

    /// Total f32 arena yang dibutuhkan seluruh chain pada sample rate ini.
    ///
    /// Arena dibuat PAS sebesar ini, bukan sebesar anggaran penuh, dan ia
    /// ikut dimiliki `RenderConfig`. Dengan begitu konfigurasi lama dan baru
    /// tidak pernah berbagi alamat: kalau satu arena dipakai bersama lalu
    /// di-`reset` saat memuat project, rak lama yang masih berbunyi akan terus
    /// menulis ke region yang sudah dijanjikan ke node baru — dan node baru
    /// mulai berbunyi dengan sisa audio lama di delay line-nya.
    pub fn total_mem_frames(&self, sample_rate: f32) -> usize {
        self.entries
            .iter()
            .map(|e| e.kind.mem_frames(sample_rate))
            .sum()
    }

    /// Bagikan region arena ke tiap entri. NON-RT.
    ///
    /// Kehabisan anggaran mengembalikan [`PlanError::OutOfFxMemory`], yang
    /// ditolak sebelum plan dipasang dan muncul sebagai peringatan di UI —
    /// preseden yang sama dengan `OutOfBuffers`. Yang tidak boleh terjadi
    /// adalah alokasi dadakan di jalur render.
    pub fn assign_memory(&mut self, sample_rate: f32, arena: &mut FxArena) -> Result<(), PlanError> {
        arena.reset();
        for e in self.entries.iter_mut() {
            let need = e.kind.mem_frames(sample_rate);
            e.mem = arena.alloc(need).ok_or(PlanError::OutOfFxMemory)?;
        }
        Ok(())
    }
}

/// Satu entri chain dari snapshot, kalau jenisnya dikenal versi ini.
///
/// `kind` yang tidak dikenal dilewati di sini dan dilaporkan sebagai peringatan
/// di `map_project` — memutar project dengan satu efek hilang jauh lebih baik
/// daripada menolak memutarnya sama sekali.
fn entry_from(desc: &FxSlotDesc, unit: u16, slot: usize, node: usize) -> Option<ChainEntry> {
    let kind = FxKind::from_u16(desc.kind)?;
    Some(ChainEntry {
        unit,
        slot: slot as u8,
        kind,
        node: node as u16,
        bypass: desc.bypass,
        params: desc.params.clone(),
        mem: MemHandle::EMPTY,
    })
}

/// Susun penomoran node untuk seluruh project. NON-RT.
pub fn plan_chains(p: &Project) -> Result<FxLayout, PlanError> {
    let mut entries: Vec<ChainEntry> = Vec::new();

    let push_chain = |unit: u16, chain: &[FxSlotDesc], entries: &mut Vec<ChainEntry>| {
        for (slot, d) in chain.iter().take(MAX_CHAIN_LEN).enumerate() {
            let node = BUILTIN_NODES + entries.len();
            if node > u16::MAX as usize {
                continue;
            }
            if let Some(e) = entry_from(d, unit, slot, node) {
                entries.push(e);
            }
        }
    };

    for (i, t) in p.tracks.iter().enumerate() {
        push_chain(track_unit(i), &t.chain, &mut entries);
    }
    for (i, b) in p.buses.iter().enumerate() {
        push_chain(bus_unit(i), &b.chain, &mut entries);
    }

    Ok(FxLayout { entries })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::{BusDesc, TrackDesc};

    fn slot(kind: u16) -> FxSlotDesc {
        FxSlotDesc {
            kind,
            bypass: false,
            params: alloc::vec![0.5, 0.25],
        }
    }

    fn project(track_chain: Vec<FxSlotDesc>, bus_chain: Vec<FxSlotDesc>) -> Project {
        Project {
            sample_rate: 48_000,
            tracks: alloc::vec![TrackDesc {
                chain: track_chain,
                ..Default::default()
            }],
            buses: alloc::vec![BusDesc {
                chain: bus_chain,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    /// Node bawaan tidak boleh bergeser saat chain user berubah — kalau
    /// bergeser, `eq_mut(unit)` dan `comp_mut(unit)` menunjuk efek yang salah.
    #[test]
    fn user_chains_never_displace_the_builtin_nodes() {
        let empty = plan_chains(&project(Vec::new(), Vec::new())).unwrap();
        assert_eq!(empty.total_nodes(), BUILTIN_NODES);

        let full = plan_chains(&project(alloc::vec![slot(0), slot(1)], alloc::vec![slot(0)])).unwrap();
        assert_eq!(full.total_nodes(), BUILTIN_NODES + 3);
        for e in &full.entries {
            assert!(
                (e.node as usize) >= BUILTIN_NODES,
                "chain user menempati nomor node bawaan"
            );
        }
    }

    /// Nomor node harus unik dan padat — dua efek yang berbagi nomor berarti
    /// satu di antaranya tidak pernah diproses.
    #[test]
    fn node_numbers_are_unique_and_dense() {
        let l = plan_chains(&project(
            alloc::vec![slot(0), slot(1), slot(0)],
            alloc::vec![slot(1)],
        ))
        .unwrap();
        let mut nodes: Vec<u16> = l.entries.iter().map(|e| e.node).collect();
        nodes.sort_unstable();
        nodes.dedup();
        assert_eq!(nodes.len(), l.entries.len(), "ada nomor node duplikat");
        for (i, n) in nodes.iter().enumerate() {
            assert_eq!(*n as usize, BUILTIN_NODES + i, "penomoran berlubang");
        }
    }

    /// Chain lebih panjang dari batas dipotong di sini; peringatannya menjadi
    /// tanggung jawab `map_project`, yang bisa menyebut nama lane-nya.
    #[test]
    fn chains_are_capped_at_max_chain_len() {
        let long: Vec<FxSlotDesc> = (0..MAX_CHAIN_LEN + 3).map(|_| slot(0)).collect();
        let l = plan_chains(&project(long, Vec::new())).unwrap();
        assert_eq!(l.entries.len(), MAX_CHAIN_LEN);
    }

    /// Efek yang tidak dikenal versi ini dilewati, bukan membuat project gagal.
    #[test]
    fn unknown_kinds_are_skipped_not_fatal() {
        let l = plan_chains(&project(alloc::vec![slot(0), slot(9999), slot(1)], Vec::new())).unwrap();
        assert_eq!(l.entries.len(), 2);
        // Dan yang tersisa tetap bernomor padat.
        assert_eq!(l.entries[0].node as usize, BUILTIN_NODES);
        assert_eq!(l.entries[1].node as usize, BUILTIN_NODES + 1);
    }

    #[test]
    fn entries_are_grouped_by_unit() {
        let l = plan_chains(&project(alloc::vec![slot(0)], alloc::vec![slot(1), slot(0)])).unwrap();
        assert_eq!(l.entries_for(track_unit(0)).count(), 1);
        assert_eq!(l.entries_for(bus_unit(0)).count(), 2);
        assert_eq!(l.entries_for(track_unit(5)).count(), 0);
    }

    /// Anggaran arena habis harus jadi PlanError, bukan panic atau alokasi RT.
    #[test]
    fn running_out_of_arena_is_a_plan_error() {
        let mut l = plan_chains(&project(alloc::vec![slot(0)], Vec::new())).unwrap();
        let mut arena = FxArena::empty();
        // EQ tidak butuh memori, jadi arena kosong pun cukup.
        assert!(l.assign_memory(48_000.0, &mut arena).is_ok());
    }
}
