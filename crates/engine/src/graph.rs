//! Pembangun ProcessPlan: topological sort + emisi Step + alokasi buffer.
//!
//! SEMUA yang ada di file ini berjalan di sisi NON-RT (docs/02 §2a). Audio
//! thread tidak pernah memanggilnya.

use alloc::vec::Vec;

use daw_rt::{MAX_BUFFERS, MAX_TRACKS};

use crate::fx::plan_chains;
use crate::plan::{allocate_buffers, PlanError, ProcessPlan, Step};
use crate::snapshot::{Project, MAX_BUSES, MAX_SENDS};

/// Indeks "unit" (track atau bus) di dalam tabel parameter/FX yang datar.
/// Track menempati 0..MAX_TRACKS, bus menempati MAX_TRACKS..MAX_TRACKS+MAX_BUSES.
#[inline]
pub const fn track_unit(t: usize) -> u16 {
    t as u16
}
#[inline]
pub const fn bus_unit(b: usize) -> u16 {
    (MAX_TRACKS + b) as u16
}
/// Tiap unit punya 2 node insert: EQ 4-band lalu kompresor.
#[inline]
pub const fn eq_node(unit: u16) -> u16 {
    unit * 2
}
#[inline]
pub const fn comp_node(unit: u16) -> u16 {
    unit * 2 + 1
}
#[inline]
pub const fn send_slot(track: usize, send: usize) -> u16 {
    (track * MAX_SENDS + send) as u16
}
/// Slot meter: 0..MAX_TRACKS-1 track, MAX_TRACKS = master (total 33, lihat 01 §1b).
pub const MASTER_METER_SLOT: u16 = MAX_TRACKS as u16;

pub const TOTAL_UNITS: usize = MAX_TRACKS + MAX_BUSES;
pub const TOTAL_FX_NODES: usize = TOTAL_UNITS * 2;
pub const TOTAL_SEND_SLOTS: usize = MAX_TRACKS * MAX_SENDS;

/// Urutkan bus secara topologis: bus harus diproses SEBELUM tujuannya.
/// Kahn; master (dest == None) selalu terakhir.
fn topo_sort_buses(p: &Project) -> Result<Vec<u16>, PlanError> {
    let n = p.buses.len();
    let mut indeg = alloc::vec![0u32; n];
    for b in p.buses.iter() {
        if let Some(d) = b.dest {
            let d = d as usize;
            if d >= n {
                return Err(PlanError::BadPlan);
            }
            indeg[d] += 1;
        }
    }
    // Antrian: bus tanpa sumber bus lain.
    let mut queue: Vec<u16> = (0..n as u16).filter(|i| indeg[*i as usize] == 0).collect();
    let mut order: Vec<u16> = Vec::with_capacity(n);
    let mut head = 0usize;
    while head < queue.len() {
        let cur = queue[head];
        head += 1;
        order.push(cur);
        if let Some(d) = p.buses[cur as usize].dest {
            let d = d as usize;
            indeg[d] -= 1;
            if indeg[d] == 0 {
                queue.push(d as u16);
            }
        }
    }
    if order.len() != n {
        return Err(PlanError::Cycle);
    }
    Ok(order)
}

/// Bangun rencana render lengkap dari model project.
///
/// Urutan aliran sinyal (WAJIB, docs/02): source PCM → clip gain → clip fade →
/// insert chain (EQ 4-band → kompresor) → fader → pan equal-power → send
/// post-fader → bus → master chain → output.
pub fn build_plan(p: &Project, generation: u32) -> Result<ProcessPlan, PlanError> {
    if p.tracks.len() > MAX_TRACKS || p.buses.len() > MAX_BUSES {
        return Err(PlanError::BadPlan);
    }
    let master = p.master_bus().ok_or(PlanError::BadPlan)?;
    let order = topo_sort_buses(p)?;

    // Penomoran node FX dihitung SATU kali di `plan_chains`, dan `Engine`
    // memanggil fungsi murni yang sama untuk membangun raknya. Kalau keduanya
    // menghitung sendiri-sendiri, `Step::Fx { node }` bisa menunjuk efek yang
    // berbeda dari yang dimaksud — tanpa error apa pun.
    let fx = plan_chains(p)?;

    // Buffer virtual: 0..n_buses = akumulator bus (hidup panjang), sisanya
    // buffer track sekali pakai. Linear scan yang nanti memadatkannya.
    let n_buses = p.buses.len();
    let mut next_vbuf = n_buses as u16;
    let mut steps: Vec<Step> = Vec::with_capacity(16 + p.tracks.len() * 10 + n_buses * 6);

    // 1. Nolkan semua akumulator bus.
    for b in 0..n_buses {
        steps.push(Step::ClearBuf { buf: b as u16 });
    }

    // 2. Track satu per satu — hanya butuh SATU buffer track yang dipakai ulang.
    let any_solo = p.tracks.iter().any(|t| t.solo);
    for (ti, t) in p.tracks.iter().enumerate() {
        // Track yang dibungkam tidak menyumbang apa pun: tidak perlu step sama
        // sekali (voice-nya tetap jalan lewat transport, tapi tidak dirender).
        let audible = !t.mute && (!any_solo || t.solo);
        let unit = track_unit(ti);
        let vt = next_vbuf;
        next_vbuf += 1;

        steps.push(Step::ClearBuf { buf: vt });
        steps.push(Step::RenderClips {
            track: unit,
            dst: vt,
        });
        if t.eq.iter().any(|b| b.enabled) {
            steps.push(Step::Fx {
                node: eq_node(unit),
                buf: vt,
            });
        }
        if t.comp.enabled {
            steps.push(Step::Fx {
                node: comp_node(unit),
                buf: vt,
            });
        }
        // Insert chain user, SELALU diemit — termasuk yang ter-bypass.
        // Menghilangkan step-nya saat bypass akan memotong ekor delay/reverb
        // tepat saat tombol ditekan; bypass ditangani di dalam node sebagai
        // peredaman input, jadi ekornya meluruh alami (lihat `fx::FxSlot`).
        for e in fx.entries_for(unit) {
            steps.push(Step::Fx {
                node: e.node,
                buf: vt,
            });
        }
        steps.push(Step::Fader {
            track: unit,
            buf: vt,
        });
        // Meter track = post-fader, pre-pan (itu yang dilihat user di channel strip).
        steps.push(Step::Meter {
            slot: unit,
            buf: vt,
        });

        if audible {
            let dst = t.dest_bus.min((n_buses.saturating_sub(1)) as u16);
            steps.push(Step::PanAdd {
                src: vt,
                dst,
                pan: unit,
            });
            // Send POST-fader: dibaca dari buffer track yang sudah ter-fader,
            // sebelum buffer itu dipakai ulang track berikutnya.
            for (si, s) in t.sends.iter().take(MAX_SENDS).enumerate() {
                if (s.bus as usize) < n_buses {
                    steps.push(Step::SendAdd {
                        src: vt,
                        dst: s.bus,
                        amount: send_slot(ti, si),
                    });
                }
            }
        }
    }

    // 3. Bus (return send / group) dalam urutan topologis; master ditangani terakhir.
    for &b in order.iter() {
        if b == master {
            continue;
        }
        let bd = &p.buses[b as usize];
        let unit = bus_unit(b as usize);
        if bd.eq.iter().any(|x| x.enabled) {
            steps.push(Step::Fx {
                node: eq_node(unit),
                buf: b,
            });
        }
        if bd.comp.enabled {
            steps.push(Step::Fx {
                node: comp_node(unit),
                buf: b,
            });
        }
        for e in fx.entries_for(unit) {
            steps.push(Step::Fx {
                node: e.node,
                buf: b,
            });
        }
        steps.push(Step::Fader {
            track: unit,
            buf: b,
        });
        let dst = bd.dest.unwrap_or(master);
        steps.push(Step::PanAdd {
            src: b,
            dst,
            pan: unit,
        });
    }

    // 4. Master chain.
    let md = &p.buses[master as usize];
    let munit = bus_unit(master as usize);
    if md.eq.iter().any(|x| x.enabled) {
        steps.push(Step::Fx {
            node: eq_node(munit),
            buf: master,
        });
    }
    if md.comp.enabled {
        steps.push(Step::Fx {
            node: comp_node(munit),
            buf: master,
        });
    }
    // Master ditangani terpisah dari loop bus di atas (`b == master` di-skip
    // di sana), jadi emisi chain-nya HARUS diulang di sini. Melewatkannya
    // membuat FX master ter-mapping dengan benar tapi tidak pernah berbunyi.
    for e in fx.entries_for(munit) {
        steps.push(Step::Fx {
            node: e.node,
            buf: master,
        });
    }
    steps.push(Step::Fader {
        track: munit,
        buf: master,
    });
    steps.push(Step::Meter {
        slot: MASTER_METER_SLOT,
        buf: master,
    });

    // 5. Alokasi buffer fisik (linear scan) + remap in-place.
    let buffer_count = allocate_buffers(&mut steps, MAX_BUFFERS)?;
    // Buffer master setelah remap: cari step Meter master terakhir.
    let out_buf = steps
        .iter()
        .rev()
        .find_map(|s| match *s {
            Step::Meter { slot, buf } if slot == MASTER_METER_SLOT => Some(buf),
            _ => None,
        })
        .ok_or(PlanError::BadPlan)?;

    let plan = ProcessPlan {
        steps: steps.into_boxed_slice(),
        buffer_count,
        out_buf,
        generation,
    };
    plan.validate(MAX_BUFFERS)?;
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::{BusDesc, SendDesc, TrackDesc};

    /// Graph target dari docs/02 §2a: 32 track × [EQ→comp] → fader/pan → master,
    /// + 2 send bus (reverb, delay).
    pub(crate) fn target_project() -> Project {
        let mut p = Project {
            sample_rate: 48_000,
            ..Default::default()
        };
        // bus 0 = master, bus 1 = reverb, bus 2 = delay
        p.buses.push(BusDesc::default());
        p.buses.push(BusDesc {
            dest: Some(0),
            ..Default::default()
        });
        p.buses.push(BusDesc {
            dest: Some(0),
            ..Default::default()
        });
        for _ in 0..MAX_TRACKS {
            let mut t = TrackDesc {
                dest_bus: 0,
                ..Default::default()
            };
            for b in t.eq.iter_mut() {
                b.enabled = true;
            }
            t.comp.enabled = true;
            t.sends.push(SendDesc {
                bus: 1,
                amount: 0.2,
            });
            t.sends.push(SendDesc {
                bus: 2,
                amount: 0.1,
            });
            p.tracks.push(t);
        }
        p
    }

    #[test]
    fn target_graph_needs_four_scratch_buffers() {
        let p = target_project();
        let plan = build_plan(&p, 1).unwrap();
        // track(1) + send_acc(2) + master(1) = 4 (docs/02 §2a).
        assert_eq!(plan.buffer_count, 4, "steps = {}", plan.steps.len());
    }

    #[test]
    fn bus_cycle_is_rejected() {
        let mut p = Project {
            sample_rate: 48_000,
            ..Default::default()
        };
        p.buses.push(BusDesc {
            dest: Some(1),
            ..Default::default()
        });
        p.buses.push(BusDesc {
            dest: Some(0),
            ..Default::default()
        });
        // Tidak ada master (semua punya dest) → BadPlan sebelum cek siklus.
        assert!(build_plan(&p, 1).is_err());
    }

    #[test]
    fn buses_are_processed_before_their_destination() {
        let p = target_project();
        let plan = build_plan(&p, 1).unwrap();
        // PanAdd terakhir sebelum master fader harus berasal dari bus send.
        let master_fader = plan
            .steps
            .iter()
            .rposition(|s| matches!(s, Step::Fader { .. }))
            .unwrap();
        let last_bus_panadd = plan.steps[..master_fader]
            .iter()
            .rposition(|s| matches!(s, Step::PanAdd { .. }))
            .unwrap();
        assert!(last_bus_panadd < master_fader);
    }
}
