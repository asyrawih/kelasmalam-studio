//! Editing non-destruktif sebagai **command dengan inverse**.
//!
//! # Kenapa command+inverse, bukan snapshot immutable
//!
//! Alternatifnya adalah persistent data structure: setiap edit menghasilkan
//! `Project` baru yang berbagi struktur dengan yang lama, undo = tukar pointer.
//! Elegan, dan di Rust bisa dipakai `im`/`rpds`. Kami **tidak** memilihnya:
//!
//! | | Command + inverse (dipilih) | Snapshot immutable |
//! |---|---|---|
//! | Memori per langkah undo | O(ukuran edit) — satu `Clip` ≈ 120 B | O(node yang di-*path-copy*) — `Vec<Track>` + `Vec<Clip>` yang tersentuh |
//! | Alokasi saat drag | Nol setelah command dibuat | Satu path-copy **per gerakan mouse** (60/detik) |
//! | Kompatibel `no_std`+WASM | Ya, `Vec` saja | Butuh crate persistent (Arc, atomic refcount, ukuran binary) |
//! | Mengirim edit ke worker | Command **adalah** delta — langsung serializable | Harus men-diff dua snapshot |
//! | Kolaborasi/OT nanti | Command = operasi, fondasinya sudah benar | Harus dibangun ulang |
//! | Risiko | Inverse yang salah = korupsi senyap | Praktis nol |
//!
//! Yang menentukan adalah **baris "alokasi saat drag"**. DAW menghabiskan
//! sebagian besar hidupnya di dalam drag, dan path-copy per frame di WASM (yang
//! GC-nya adalah allocator kita sendiri, dan yang memory-nya `SharedArrayBuffer`
//! yang tidak pernah menyusut) berarti heap terus tumbuh selama user menggeser
//! clip. Ditambah itu, command yang serializable adalah hal yang sama yang kita
//! butuhkan untuk mengirim edit ke engine dan ke export worker — satu mekanisme,
//! bukan dua.
//!
//! Risiko "inverse yang salah" ditangani dua cara:
//! 1. Untuk op yang memutasi satu clip, inverse-nya adalah
//!    [`EditCmd::RestoreClip`] yang membawa salinan penuh clip sebelum edit.
//!    Ini **tidak curang**: `Clip` itu kecil dan tanpa buffer, jadi salinannya
//!    tetap O(1) terhadap panjang audio. Yang mahal (PCM) tidak pernah disalin.
//! 2. Property test `apply(inverse(apply(p))) == p` untuk setiap op
//!    (lihat modul `tests` di bawah).
//!
//! # Bentuk API
//!
//! ```ignore
//! let inv = EditCmd::TrimLeft { clip, new_start }.apply(&mut project, policy)?;
//! history.push(cmd, inv);
//! ```
//!
//! `apply` mengembalikan command inverse-nya. Itu satu-satunya kontrak:
//! **menerapkan hasil `apply` mengembalikan project ke keadaan sebelum `apply`.**

use alloc::boxed::Box;
use alloc::vec;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use crate::coords::{timeline_to_source, TimelineSample};
use crate::model::{Clip, ClipId, FadeSpec, Project, TrackId};

/// Apa yang terjadi kalau hasil edit menabrak clip lain di track yang sama.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OverlapPolicy {
    /// Bagian yang tumpang tindih jadi crossfade otomatis: clip kiri dapat
    /// fade-out, clip kanan dapat fade-in, sepanjang overlap. Ini yang paling
    /// "DAW modern" (Pro Tools/Logic), dan tidak pernah menghilangkan audio.
    #[default]
    Crossfade,
    /// Clip yang tertabrak digeser ke kanan sebanyak overlap. Berguna untuk
    /// menyusun ulang urutan take.
    Push,
    /// Edit ditolak dengan [`EditError::Overlap`]. Paling aman, tapi paling
    /// menyebalkan saat dipakai sebagai default.
    Reject,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FadeSide {
    In,
    Out,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum EditError {
    /// Clip dengan ID itu tidak ada (mis. undo dari history yang basi).
    NoSuchClip(ClipId),
    NoSuchTrack(TrackId),
    /// Hasil edit akan menghasilkan clip sepanjang 0 sample.
    ZeroLength,
    /// Titik split di luar clip, atau tepat di tepinya (tidak ada gunanya).
    SplitOutOfRange,
    /// Trim melewati batas asset (tidak ada audio lagi untuk ditampilkan).
    OutOfSource,
    /// [`OverlapPolicy::Reject`] dan hasilnya tumpang tindih.
    Overlap(ClipId),
}

/// Satu operasi edit. `apply` mengembalikan inverse-nya.
///
/// `Box<Clip>` dipakai supaya varian enum-nya tidak membengkak ke ukuran `Clip`
/// (yang punya `Vec` dan `String`) — enum sebesar varian terbesarnya, dan
/// command ini disimpan ribuan kali di history.
#[derive(Clone, Debug, PartialEq)]
pub enum EditCmd {
    // --- op yang dipanggil UI ---
    /// Geser tepi kiri ke `new_start` (timeline space). Mundur = memperpanjang,
    /// dibatasi oleh awal asset.
    TrimLeft {
        clip: ClipId,
        new_start: TimelineSample,
    },
    /// Geser tepi kanan ke `new_end` (eksklusif, timeline space).
    TrimRight {
        clip: ClipId,
        new_end: TimelineSample,
    },
    /// Pecah jadi dua clip yang berbagi `asset_id` yang sama.
    SplitAt {
        clip: ClipId,
        at: TimelineSample,
        new_id: ClipId,
    },
    MoveClip {
        clip: ClipId,
        to_track: TrackId,
        to_pos: TimelineSample,
    },
    SetGain {
        clip: ClipId,
        gain_db: f32,
    },
    SetFade {
        clip: ClipId,
        side: FadeSide,
        spec: FadeSpec,
    },
    Duplicate {
        clip: ClipId,
        new_id: ClipId,
        to_track: TrackId,
        at: TimelineSample,
    },
    Delete {
        clip: ClipId,
    },

    // --- varian yang hanya muncul sebagai inverse ---
    /// Kembalikan satu clip ke keadaan tersimpan. Inverse universal untuk semua
    /// op yang memutasi tepat satu clip tanpa efek samping ke tetangga.
    RestoreClip {
        state: Box<Clip>,
    },
    /// Kembalikan seluruh isi satu track. Inverse untuk op dengan efek samping
    /// (Push/Crossfade menyentuh clip tetangga).
    RestoreTrackClips {
        track: TrackId,
        clips: Vec<Clip>,
    },
    /// Sisipkan clip kembali (inverse dari Delete).
    Insert {
        track: TrackId,
        clip: Box<Clip>,
    },
    /// Hapus tanpa mencatat apa pun (inverse dari Duplicate/Split).
    Remove {
        clip: ClipId,
    },
    /// Beberapa command berurutan; inverse-nya adalah inverse tiap elemen
    /// dalam **urutan terbalik**.
    Batch(Vec<EditCmd>),
}

impl EditCmd {
    /// Terapkan dan kembalikan inverse.
    ///
    /// Kontrak: kalau `apply` mengembalikan `Err`, project **tidak berubah**
    /// sama sekali. Semua validasi dilakukan sebelum mutasi pertama.
    pub fn apply(&self, p: &mut Project, policy: OverlapPolicy) -> Result<EditCmd, EditError> {
        match self {
            EditCmd::TrimLeft { clip, new_start } => trim_left(p, *clip, *new_start),
            EditCmd::TrimRight { clip, new_end } => trim_right(p, *clip, *new_end),
            EditCmd::SplitAt { clip, at, new_id } => split_at(p, *clip, *at, *new_id),
            EditCmd::MoveClip {
                clip,
                to_track,
                to_pos,
            } => move_clip(p, *clip, *to_track, *to_pos, policy),
            EditCmd::SetGain { clip, gain_db } => set_gain(p, *clip, *gain_db),
            EditCmd::SetFade { clip, side, spec } => set_fade(p, *clip, *side, *spec),
            EditCmd::Duplicate {
                clip,
                new_id,
                to_track,
                at,
            } => duplicate(p, *clip, *new_id, *to_track, *at, policy),
            EditCmd::Delete { clip } => delete(p, *clip),

            EditCmd::RestoreClip { state } => restore_clip(p, state),
            EditCmd::RestoreTrackClips { track, clips } => restore_track(p, *track, clips),
            EditCmd::Insert { track, clip } => insert_clip(p, *track, (**clip).clone()),
            EditCmd::Remove { clip } => delete(p, *clip),
            EditCmd::Batch(cmds) => {
                let mut inv = Vec::with_capacity(cmds.len());
                for c in cmds {
                    inv.push(c.apply(p, policy)?);
                }
                inv.reverse();
                Ok(EditCmd::Batch(inv))
            }
        }
    }
}

// -------------------------------------------------------------------------
// Helper
// -------------------------------------------------------------------------

fn locate(p: &Project, id: ClipId) -> Result<(usize, usize), EditError> {
    for (ti, t) in p.tracks.iter().enumerate() {
        if let Some(ci) = t.clip_index(id) {
            return Ok((ti, ci));
        }
    }
    Err(EditError::NoSuchClip(id))
}

fn track_index(p: &Project, id: TrackId) -> Result<usize, EditError> {
    p.tracks
        .iter()
        .position(|t| t.id == id)
        .ok_or(EditError::NoSuchTrack(id))
}

/// Inverse "kembalikan clip ini apa adanya".
fn snapshot_inverse(c: &Clip) -> EditCmd {
    EditCmd::RestoreClip {
        state: Box::new(c.clone()),
    }
}

/// Inverse "kembalikan seluruh track ini apa adanya".
fn snapshot_track_inverse(p: &Project, ti: usize) -> EditCmd {
    EditCmd::RestoreTrackClips {
        track: p.tracks[ti].id,
        clips: p.tracks[ti].clips.clone(),
    }
}

// -------------------------------------------------------------------------
// Trim
// -------------------------------------------------------------------------

/// Trim kiri = **hanya** mutasi `source_start`, `source_len`, `timeline_pos`.
/// PCM tidak tersentuh; trim bisa dibatalkan dengan menggeser kembali karena
/// sample-nya masih ada.
///
/// Edge case yang ditangani:
/// - **Melewati awal asset**: `source_start` tidak boleh < 0 →
///   [`EditError::OutOfSource`]. UI seharusnya sudah meng-clamp handle-nya, tapi
///   command harus tetap aman dipanggil dari mana pun (undo, script, kolaborasi).
/// - **Hasil nol**: `new_start >= timeline_end` → [`EditError::ZeroLength`].
/// - **Trim melewati fade**: fade-in "menempel di kepala clip", jadi setelah
///   trim ia tetap mulai di kepala yang baru. Kalau durasinya tidak muat lagi,
///   `clamp_fades` mengecilkannya. Alternatif (fade tetap di posisi absolut lalu
///   terpotong) terdengar sebagai clip yang tiba-tiba mulai di tengah fade — itu
///   klik, persis yang mau kita hindari.
fn trim_left(p: &mut Project, id: ClipId, new_start: TimelineSample) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, id)?;
    let c = &p.tracks[ti].clips[ci];
    let g = c.geometry();

    if new_start >= c.timeline_end() {
        return Err(EditError::ZeroLength);
    }
    // Konversi lintas space — SATU-SATUNYA cara yang sah.
    let new_source_start = timeline_to_source_unclamped(&g, new_start)?;
    let source_end = g.source_end();
    if new_source_start >= source_end {
        return Err(EditError::ZeroLength);
    }
    let new_len = source_end.distance_from(new_source_start);
    if new_len == 0 {
        return Err(EditError::ZeroLength);
    }

    let inv = snapshot_inverse(c);
    let c = &mut p.tracks[ti].clips[ci];
    c.source_start = new_source_start;
    c.source_len = new_len;
    c.timeline_pos = new_start;
    c.clamp_fades();
    p.tracks[ti].sort_clips();
    Ok(inv)
}

/// Trim kanan = mutasi `source_len` saja. `timeline_pos` tidak bergerak.
fn trim_right(p: &mut Project, id: ClipId, new_end: TimelineSample) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, id)?;
    let c = &p.tracks[ti].clips[ci];
    let g = c.geometry();

    if new_end <= c.timeline_pos {
        return Err(EditError::ZeroLength);
    }
    // Panjang timeline yang diminta → panjang source. Dibatasi sisa asset:
    // memperpanjang ke kanan melewati akhir asset tidak menghasilkan audio.
    let asset_frames = p
        .assets
        .iter()
        .find(|a| a.id == c.asset_id)
        .map(|a| a.frames)
        .unwrap_or(u64::MAX);
    let want_tl = new_end.distance_from(c.timeline_pos);
    let want_src = (want_tl as f64 * g.safe_ratio() + 0.5) as u64;
    let avail = asset_frames.saturating_sub(c.source_start.raw());
    let new_len = want_src.min(avail);
    if new_len == 0 {
        return Err(EditError::ZeroLength);
    }

    let inv = snapshot_inverse(c);
    let c = &mut p.tracks[ti].clips[ci];
    c.source_len = new_len;
    c.clamp_fades();
    Ok(inv)
}

/// Konversi timeline→source untuk trim: tanpa clamp bawah ke `source_start`
/// (kita justru butuh tahu kalau hasilnya negatif) dan tanpa clamp atas.
fn timeline_to_source_unclamped(
    g: &crate::coords::ClipGeometry,
    t: TimelineSample,
) -> Result<crate::coords::SourceSample, EditError> {
    let d = t.signed_delta(g.timeline_pos) as f64 * g.safe_ratio();
    let s = g.source_start.raw() as i64 + (if d >= 0.0 { d + 0.5 } else { d - 0.5 }) as i64;
    if s < 0 {
        return Err(EditError::OutOfSource);
    }
    Ok(crate::coords::SourceSample::new(s as u64))
}

// -------------------------------------------------------------------------
// Split
// -------------------------------------------------------------------------

/// Split di `at`: satu clip jadi dua, **berbagi `asset_id` yang sama**. Tidak
/// ada sample yang disalin — hanya satu `Clip` baru dengan `source_start` yang
/// digeser.
///
/// ```text
/// sebelum:  [====== A ======]            asset: src_start=100 len=800
/// split di tengah:
/// sesudah:  [== A ==][== B ==]           A: src_start=100 len=400
///                                        B: src_start=500 len=400
/// ```
///
/// **Edge case: split di tengah fade.** Ini kasus yang biasanya salah.
/// Yang kami lakukan:
/// - Fade-in asli menempel di kepala A. Kalau titik split jatuh **di dalam**
///   fade-in, A jadi lebih pendek dari fade-in-nya → `clamp_fades` memotongnya,
///   dan B **tidak** mewarisi sisa fade-in. Alasannya: melanjutkan kurva fade
///   di clip B mustahil direpresentasikan (FadeSpec tidak punya "offset di
///   dalam kurva"), dan meng-approx-nya menghasilkan diskontinuitas gain di
///   titik split — persis klik yang mau dihindari. Yang benar secara audio
///   adalah B mulai dari gain penuh dengan micro-fade engine, dan itu yang
///   terjadi.
/// - Fade-out asli ikut ke B (menempel di ekor).
/// - Tepi baru di titik split tidak diberi fade eksplisit sama sekali: engine
///   menerapkan micro-fade 3 ms di setiap boundary (lihat [`crate::MICRO_FADE_MS`]),
///   jadi sambungan A→B **null-test bersih** terhadap clip aslinya kecuali di
///   3 ms itu. Memberi fade eksplisit di sini justru akan terdengar sebagai
///   lubang volume.
///
/// Split tepat di tepi ditolak ([`EditError::SplitOutOfRange`]) — hasilnya akan
/// berupa clip nol-panjang.
fn split_at(
    p: &mut Project,
    id: ClipId,
    at: TimelineSample,
    new_id: ClipId,
) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, id)?;
    let c = &p.tracks[ti].clips[ci];
    if at <= c.timeline_pos || at >= c.timeline_end() {
        return Err(EditError::SplitOutOfRange);
    }
    let g = c.geometry();
    let split_src = timeline_to_source(&g, at);
    let left_len = split_src.distance_from(c.source_start);
    let right_len = g.source_end().distance_from(split_src);
    if left_len == 0 || right_len == 0 {
        return Err(EditError::ZeroLength);
    }

    let original = c.clone();
    let mut right = original.clone();
    right.id = new_id;
    right.source_start = split_src;
    right.source_len = right_len;
    right.timeline_pos = at;
    right.fade_in = FadeSpec::NONE; // lihat doc di atas
    right.clamp_fades();

    let left = &mut p.tracks[ti].clips[ci];
    left.source_len = left_len;
    left.fade_out = FadeSpec::NONE;
    // Clip yang di-loop tidak bisa di-split secara bermakna: loop jadi ambigu.
    // Kebijakan: split "membekukan" loop jadi 1 di kedua sisi.
    left.loop_count = 1;
    left.clamp_fades();
    right.loop_count = 1;

    p.tracks[ti].clips.insert(ci + 1, right);
    p.tracks[ti].sort_clips();

    // Inverse: hapus clip kanan, lalu kembalikan clip kiri ke keadaan semula.
    Ok(EditCmd::Batch(vec![
        EditCmd::Remove { clip: new_id },
        EditCmd::RestoreClip {
            state: Box::new(original),
        },
    ]))
}

// -------------------------------------------------------------------------
// Move / duplicate / delete
// -------------------------------------------------------------------------

fn move_clip(
    p: &mut Project,
    id: ClipId,
    to_track: TrackId,
    to_pos: TimelineSample,
    policy: OverlapPolicy,
) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, id)?;
    let dst_ti = track_index(p, to_track)?;

    // Validasi overlap SEBELUM mutasi apa pun.
    let len = p.tracks[ti].clips[ci].timeline_len();
    if policy == OverlapPolicy::Reject {
        if let Some(other) = first_overlap(p, dst_ti, id, to_pos, len) {
            return Err(EditError::Overlap(other));
        }
    }

    // Inverse: snapshot kedua track (atau satu, kalau move dalam track sendiri).
    let inv = if ti == dst_ti {
        EditCmd::Batch(vec![snapshot_track_inverse(p, ti)])
    } else {
        EditCmd::Batch(vec![
            snapshot_track_inverse(p, dst_ti),
            snapshot_track_inverse(p, ti),
        ])
    };

    let mut c = p.tracks[ti].clips.remove(ci);
    c.timeline_pos = to_pos;
    c.track = to_track;
    p.tracks[dst_ti].clips.push(c);
    p.tracks[dst_ti].sort_clips();
    resolve_overlaps(p, dst_ti, id, policy);
    if ti != dst_ti {
        p.tracks[ti].sort_clips();
    }
    Ok(inv)
}

fn duplicate(
    p: &mut Project,
    id: ClipId,
    new_id: ClipId,
    to_track: TrackId,
    at: TimelineSample,
    policy: OverlapPolicy,
) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, id)?;
    let dst_ti = track_index(p, to_track)?;
    let mut c = p.tracks[ti].clips[ci].clone();
    if policy == OverlapPolicy::Reject {
        if let Some(other) = first_overlap(p, dst_ti, new_id, at, c.timeline_len()) {
            return Err(EditError::Overlap(other));
        }
    }
    c.id = new_id;
    c.track = to_track;
    c.timeline_pos = at;
    // Inverse: kalau policy bisa menyentuh tetangga (Push/Crossfade mengubah
    // fade & posisi clip lain), `Remove` saja TIDAK cukup — snapshot track.
    let inv = match policy {
        OverlapPolicy::Reject => EditCmd::Remove { clip: new_id },
        _ => EditCmd::Batch(vec![snapshot_track_inverse(p, dst_ti)]),
    };
    // Duplicate TIDAK menyalin PCM: `asset_id` sama, refcount asset naik satu.
    // Ini yang membuat "duplikasi 200 kali" gratis.
    p.tracks[dst_ti].clips.push(c);
    p.tracks[dst_ti].sort_clips();
    resolve_overlaps(p, dst_ti, new_id, policy);
    Ok(inv)
}

fn delete(p: &mut Project, id: ClipId) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, id)?;
    let c = p.tracks[ti].clips.remove(ci);
    let track = p.tracks[ti].id;
    // Catatan asset pool: delete TIDAK membebaskan asset. Selama command ini
    // masih ada di history undo, ia memegang satu-satunya referensi ke clip —
    // dan karenanya mem-*pin* asset-nya. GC asset hanya berjalan pada asset yang
    // refcount-nya 0 DAN tidak muncul di history. Lihat docs/06 §6a.
    Ok(EditCmd::Insert {
        track,
        clip: Box::new(c),
    })
}

fn insert_clip(p: &mut Project, track: TrackId, clip: Clip) -> Result<EditCmd, EditError> {
    let ti = track_index(p, track)?;
    let id = clip.id;
    p.tracks[ti].clips.push(clip);
    p.tracks[ti].sort_clips();
    Ok(EditCmd::Remove { clip: id })
}

fn restore_clip(p: &mut Project, state: &Clip) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, state.id)?;
    let prev = p.tracks[ti].clips[ci].clone();
    if p.tracks[ti].id == state.track {
        p.tracks[ti].clips[ci] = state.clone();
        p.tracks[ti].sort_clips();
    } else {
        // Clip pindah track di antara apply dan inverse — pindahkan balik.
        let dst = track_index(p, state.track)?;
        p.tracks[ti].clips.remove(ci);
        p.tracks[dst].clips.push(state.clone());
        p.tracks[dst].sort_clips();
    }
    Ok(EditCmd::RestoreClip {
        state: Box::new(prev),
    })
}

fn restore_track(p: &mut Project, track: TrackId, clips: &[Clip]) -> Result<EditCmd, EditError> {
    let ti = track_index(p, track)?;
    let prev = p.tracks[ti].clips.clone();
    p.tracks[ti].clips.clear();
    p.tracks[ti].clips.extend_from_slice(clips);
    p.tracks[ti].sort_clips();
    Ok(EditCmd::RestoreTrackClips { track, clips: prev })
}

// -------------------------------------------------------------------------
// Gain & fade
// -------------------------------------------------------------------------

fn set_gain(p: &mut Project, id: ClipId, gain_db: f32) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, id)?;
    let inv = snapshot_inverse(&p.tracks[ti].clips[ci]);
    // Clamp ke rentang yang bisa direpresentasikan meter & fader UI.
    p.tracks[ti].clips[ci].gain_db = clampf(gain_db, -96.0, 24.0);
    Ok(inv)
}

fn set_fade(
    p: &mut Project,
    id: ClipId,
    side: FadeSide,
    spec: FadeSpec,
) -> Result<EditCmd, EditError> {
    let (ti, ci) = locate(p, id)?;
    let inv = snapshot_inverse(&p.tracks[ti].clips[ci]);
    let c = &mut p.tracks[ti].clips[ci];
    match side {
        FadeSide::In => c.fade_in = spec,
        FadeSide::Out => c.fade_out = spec,
    }
    c.clamp_fades();
    Ok(inv)
}

fn clampf(v: f32, lo: f32, hi: f32) -> f32 {
    // `is_nan()` bukan sekadar untuk menyenangkan clippy: `!(v == v)` memang
    // idiom NaN yang sah, tapi pembacanya harus tahu idiomnya dulu. NaN di sini
    // dipulangkan jadi 0.0 karena nilai rusak lebih baik dinetralkan daripada
    // merambat ke gain/fade dan membuat seluruh clip senyap.
    if v.is_nan() {
        return 0.0;
    }
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

// -------------------------------------------------------------------------
// Overlap
// -------------------------------------------------------------------------

fn first_overlap(
    p: &Project,
    ti: usize,
    ignore: ClipId,
    pos: TimelineSample,
    len: u64,
) -> Option<ClipId> {
    let end = pos.offset(len);
    p.tracks[ti]
        .clips
        .iter()
        .find(|c| c.id != ignore && c.timeline_end() > pos && c.timeline_pos < end)
        .map(|c| c.id)
}

/// Selesaikan tabrakan setelah `moved` ditempatkan di track `ti`.
///
/// `Reject` sudah divalidasi sebelum mutasi, jadi di sini ia no-op.
fn resolve_overlaps(p: &mut Project, ti: usize, moved: ClipId, policy: OverlapPolicy) {
    match policy {
        OverlapPolicy::Reject => {}
        OverlapPolicy::Push => {
            // Dorong berantai ke kanan. Iterasi maju: karena clips tersortir,
            // satu pass cukup — tiap clip hanya perlu dibandingkan dengan
            // pendahulunya yang sudah final.
            for i in 1..p.tracks[ti].clips.len() {
                let prev_end = p.tracks[ti].clips[i - 1].timeline_end();
                if p.tracks[ti].clips[i].timeline_pos < prev_end {
                    p.tracks[ti].clips[i].timeline_pos = prev_end;
                }
            }
        }
        OverlapPolicy::Crossfade => {
            let Some(mi) = p.tracks[ti].clip_index(moved) else {
                return;
            };
            // Tetangga kiri: ia fade-out, `moved` fade-in, sepanjang overlap.
            if mi > 0 {
                let (l_end, l_len) = {
                    let l = &p.tracks[ti].clips[mi - 1];
                    (l.timeline_end(), l.timeline_len())
                };
                let m_pos = p.tracks[ti].clips[mi].timeline_pos;
                if l_end > m_pos {
                    let ov = l_end
                        .distance_from(m_pos)
                        .min(l_len)
                        .min(p.tracks[ti].clips[mi].timeline_len());
                    set_xfade(&mut p.tracks[ti].clips[mi - 1], FadeSide::Out, ov);
                    set_xfade(&mut p.tracks[ti].clips[mi], FadeSide::In, ov);
                }
            }
            // Tetangga kanan.
            if mi + 1 < p.tracks[ti].clips.len() {
                let m_end = p.tracks[ti].clips[mi].timeline_end();
                let (r_pos, r_len) = {
                    let r = &p.tracks[ti].clips[mi + 1];
                    (r.timeline_pos, r.timeline_len())
                };
                if m_end > r_pos {
                    let ov = m_end
                        .distance_from(r_pos)
                        .min(r_len)
                        .min(p.tracks[ti].clips[mi].timeline_len());
                    set_xfade(&mut p.tracks[ti].clips[mi], FadeSide::Out, ov);
                    set_xfade(&mut p.tracks[ti].clips[mi + 1], FadeSide::In, ov);
                }
            }
        }
    }
}

fn set_xfade(c: &mut Clip, side: FadeSide, len: u64) {
    // Crossfade otomatis memakai EqualPower: dua clip yang bertabrakan di
    // timeline hampir selalu material yang TIDAK berkorelasi (dua take/dua file
    // berbeda). Lihat FadeCurve di model.rs.
    let spec = FadeSpec::new(len, crate::model::FadeCurve::EqualPower);
    match side {
        FadeSide::In => c.fade_in = spec,
        FadeSide::Out => c.fade_out = spec,
    }
    c.clamp_fades();
}

// -------------------------------------------------------------------------
// History
// -------------------------------------------------------------------------

/// Undo/redo stack.
///
/// Menyimpan pasangan `(do, undo)`. Redo memakai command asli, bukan
/// inverse-dari-inverse: menerapkan inverse dua kali tidak dijamin identik
/// ketika ada op yang lossy (mis. `SetGain` yang di-clamp).
///
/// `limit` membatasi kedalaman. Ini bukan soal memori command (kecil), tapi soal
/// **asset pinning**: setiap `Delete` di history menahan asset-nya supaya tidak
/// di-evict, jadi history tak terbatas = asset pool tak terbatas.
#[derive(Debug, Default)]
pub struct History {
    done: Vec<(EditCmd, EditCmd)>,
    undone: Vec<(EditCmd, EditCmd)>,
    limit: usize,
}

impl History {
    pub fn new(limit: usize) -> Self {
        Self {
            done: Vec::new(),
            undone: Vec::new(),
            limit: limit.max(1),
        }
    }

    /// Terapkan `cmd`, catat inverse-nya, buang redo stack.
    pub fn exec(
        &mut self,
        p: &mut Project,
        cmd: EditCmd,
        policy: OverlapPolicy,
    ) -> Result<(), EditError> {
        let inv = cmd.apply(p, policy)?;
        self.undone.clear();
        self.done.push((cmd, inv));
        if self.done.len() > self.limit {
            self.done.remove(0);
        }
        Ok(())
    }

    pub fn undo(&mut self, p: &mut Project, policy: OverlapPolicy) -> Result<bool, EditError> {
        let Some((cmd, inv)) = self.done.pop() else {
            return Ok(false);
        };
        inv.apply(p, policy)?;
        self.undone.push((cmd, inv));
        Ok(true)
    }

    pub fn redo(&mut self, p: &mut Project, policy: OverlapPolicy) -> Result<bool, EditError> {
        let Some((cmd, _)) = self.undone.pop() else {
            return Ok(false);
        };
        let inv = cmd.apply(p, policy)?;
        self.done.push((cmd, inv));
        Ok(true)
    }

    pub fn can_undo(&self) -> bool {
        !self.done.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.undone.is_empty()
    }

    /// Asset yang di-*pin* oleh history (ada di clip yang sudah dihapus tapi
    /// masih bisa di-undo). GC asset pool wajib menghormati daftar ini.
    pub fn pinned_assets(&self) -> Vec<crate::model::AssetId> {
        let mut out = Vec::new();
        for (a, b) in self.done.iter().chain(self.undone.iter()) {
            collect_assets(a, &mut out);
            collect_assets(b, &mut out);
        }
        out.sort_unstable();
        out.dedup();
        out
    }
}

fn collect_assets(cmd: &EditCmd, out: &mut Vec<crate::model::AssetId>) {
    match cmd {
        EditCmd::RestoreClip { state } => out.push(state.asset_id),
        EditCmd::Insert { clip, .. } => out.push(clip.asset_id),
        EditCmd::RestoreTrackClips { clips, .. } => out.extend(clips.iter().map(|c| c.asset_id)),
        EditCmd::Batch(v) => v.iter().for_each(|c| collect_assets(c, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::SourceSample;
    use crate::model::{AssetId, AssetRef, FadeCurve, Track};
    use alloc::string::String;
    use proptest::prelude::*;

    const SR: u32 = 48_000;

    fn fixture() -> (Project, TrackId, ClipId) {
        let mut p = Project::new("t", SR);
        p.assets.push(AssetRef {
            id: AssetId::new(1),
            name: String::new(),
            content_hash: 0,
            channels: 2,
            frames: 480_000,
            source_sample_rate: SR,
        });
        let master = p.master.id;
        let tid = TrackId::new(100);
        let mut t = Track::new(tid, "A", master);
        let cid = ClipId::new(200);
        let mut c = Clip::new(
            cid,
            tid,
            AssetId::new(1),
            TimelineSample::new(48_000),
            96_000,
        );
        c.fade_in = FadeSpec::new(4800, FadeCurve::Linear);
        c.fade_out = FadeSpec::new(4800, FadeCurve::Linear);
        t.clips.push(c);
        p.tracks.push(t);
        p.tracks.push(Track::new(TrackId::new(101), "B", master));
        (p, tid, cid)
    }

    fn roundtrip(cmd: EditCmd, policy: OverlapPolicy) {
        let (mut p, _, _) = fixture();
        let before = p.clone();
        let inv = cmd.apply(&mut p, policy).expect("apply gagal");
        assert_ne!(p, before, "command {cmd:?} tidak mengubah apa pun");
        inv.apply(&mut p, policy).expect("inverse gagal");
        assert_eq!(
            p, before,
            "inverse dari {cmd:?} tidak mengembalikan project"
        );
    }

    #[test]
    fn trim_left_roundtrip() {
        roundtrip(
            EditCmd::TrimLeft {
                clip: ClipId::new(200),
                new_start: TimelineSample::new(60_000),
            },
            OverlapPolicy::Crossfade,
        );
    }

    #[test]
    fn trim_right_roundtrip() {
        roundtrip(
            EditCmd::TrimRight {
                clip: ClipId::new(200),
                new_end: TimelineSample::new(100_000),
            },
            OverlapPolicy::Crossfade,
        );
    }

    #[test]
    fn split_roundtrip() {
        roundtrip(
            EditCmd::SplitAt {
                clip: ClipId::new(200),
                at: TimelineSample::new(96_000),
                new_id: ClipId::new(999),
            },
            OverlapPolicy::Crossfade,
        );
    }

    #[test]
    fn move_delete_duplicate_gain_fade_roundtrip() {
        for (cmd, pol) in [
            (
                EditCmd::MoveClip {
                    clip: ClipId::new(200),
                    to_track: TrackId::new(101),
                    to_pos: TimelineSample::new(0),
                },
                OverlapPolicy::Crossfade,
            ),
            (
                EditCmd::Delete {
                    clip: ClipId::new(200),
                },
                OverlapPolicy::Reject,
            ),
            (
                EditCmd::Duplicate {
                    clip: ClipId::new(200),
                    new_id: ClipId::new(998),
                    to_track: TrackId::new(101),
                    at: TimelineSample::new(0),
                },
                OverlapPolicy::Reject,
            ),
            (
                EditCmd::SetGain {
                    clip: ClipId::new(200),
                    gain_db: -6.0,
                },
                OverlapPolicy::Reject,
            ),
            (
                EditCmd::SetFade {
                    clip: ClipId::new(200),
                    side: FadeSide::In,
                    spec: FadeSpec::new(9600, FadeCurve::EqualPower),
                },
                OverlapPolicy::Reject,
            ),
        ] {
            roundtrip(cmd, pol);
        }
    }

    #[test]
    fn split_preserves_total_source_coverage() {
        let (mut p, _, cid) = fixture();
        let at = TimelineSample::new(96_000);
        EditCmd::SplitAt {
            clip: cid,
            at,
            new_id: ClipId::new(999),
        }
        .apply(&mut p, OverlapPolicy::Crossfade)
        .unwrap();
        let clips = &p.tracks[0].clips;
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0].source_len + clips[1].source_len, 96_000);
        // Dua clip berbagi asset yang sama — tidak ada PCM yang disalin.
        assert_eq!(clips[0].asset_id, clips[1].asset_id);
        assert_eq!(p.asset_refcount(AssetId::new(1)), 2);
        // Tepi baru tidak diberi fade eksplisit (engine yang micro-fade).
        assert!(clips[0].fade_out.is_none());
        assert!(clips[1].fade_in.is_none());
        // Fade luar dipertahankan.
        assert_eq!(clips[0].fade_in.len_timeline, 4800);
        assert_eq!(clips[1].fade_out.len_timeline, 4800);
    }

    #[test]
    fn split_inside_fade_in_truncates_and_does_not_leak_to_right() {
        let (mut p, _, cid) = fixture();
        // fade_in = 4800; split di +1000 → jatuh DI DALAM fade-in.
        let at = TimelineSample::new(49_000);
        EditCmd::SplitAt {
            clip: cid,
            at,
            new_id: ClipId::new(999),
        }
        .apply(&mut p, OverlapPolicy::Crossfade)
        .unwrap();
        let clips = &p.tracks[0].clips;
        assert_eq!(clips[0].timeline_len(), 1000);
        assert_eq!(
            clips[0].fade_in.len_timeline, 1000,
            "fade harus dipotong ke panjang clip"
        );
        assert!(
            clips[1].fade_in.is_none(),
            "sisa fade tidak boleh bocor ke clip kanan"
        );
    }

    #[test]
    fn trim_past_fade_clamps_it() {
        let (mut p, _, cid) = fixture();
        EditCmd::TrimRight {
            clip: cid,
            new_end: TimelineSample::new(50_000),
        }
        .apply(&mut p, OverlapPolicy::Reject)
        .unwrap();
        let c = &p.tracks[0].clips[0];
        assert_eq!(c.timeline_len(), 2000);
        assert!(c.fade_in.len_timeline + c.fade_out.len_timeline <= 2000);
        assert!(!c.fades_overlap());
    }

    #[test]
    fn zero_length_results_are_rejected() {
        let (mut p, _, cid) = fixture();
        assert_eq!(
            EditCmd::TrimLeft {
                clip: cid,
                new_start: TimelineSample::new(144_000)
            }
            .apply(&mut p, OverlapPolicy::Reject),
            Err(EditError::ZeroLength)
        );
        assert_eq!(
            EditCmd::TrimRight {
                clip: cid,
                new_end: TimelineSample::new(48_000)
            }
            .apply(&mut p, OverlapPolicy::Reject),
            Err(EditError::ZeroLength)
        );
        assert_eq!(
            EditCmd::SplitAt {
                clip: cid,
                at: TimelineSample::new(48_000),
                new_id: ClipId::new(9)
            }
            .apply(&mut p, OverlapPolicy::Reject),
            Err(EditError::SplitOutOfRange)
        );
    }

    #[test]
    fn trim_left_past_asset_start_is_rejected() {
        let (mut p, _, cid) = fixture();
        p.tracks[0].clips[0].source_start = SourceSample::new(0);
        assert_eq!(
            EditCmd::TrimLeft {
                clip: cid,
                new_start: TimelineSample::new(0)
            }
            .apply(&mut p, OverlapPolicy::Reject),
            Err(EditError::OutOfSource)
        );
    }

    #[test]
    fn failed_apply_leaves_project_untouched() {
        let (mut p, _, cid) = fixture();
        let before = p.clone();
        let _ = EditCmd::TrimLeft {
            clip: cid,
            new_start: TimelineSample::new(999_999),
        }
        .apply(&mut p, OverlapPolicy::Reject);
        assert_eq!(p, before);
    }

    #[test]
    fn overlap_reject_refuses() {
        let (mut p, tid, _) = fixture();
        let c2 = Clip::new(
            ClipId::new(300),
            tid,
            AssetId::new(1),
            TimelineSample::new(200_000),
            48_000,
        );
        p.tracks[0].clips.push(c2);
        p.tracks[0].sort_clips();
        let r = EditCmd::MoveClip {
            clip: ClipId::new(300),
            to_track: tid,
            to_pos: TimelineSample::new(50_000),
        }
        .apply(&mut p, OverlapPolicy::Reject);
        assert!(matches!(r, Err(EditError::Overlap(_))));
    }

    #[test]
    fn overlap_push_shifts_neighbour() {
        let (mut p, tid, _) = fixture();
        p.tracks[0].clips.push(Clip::new(
            ClipId::new(300),
            tid,
            AssetId::new(1),
            TimelineSample::new(200_000),
            48_000,
        ));
        p.tracks[0].sort_clips();
        EditCmd::MoveClip {
            clip: ClipId::new(300),
            to_track: tid,
            to_pos: TimelineSample::new(50_000),
        }
        .apply(&mut p, OverlapPolicy::Push)
        .unwrap();
        let a = &p.tracks[0].clips[0];
        let b = &p.tracks[0].clips[1];
        assert!(
            b.timeline_pos >= a.timeline_end(),
            "push harus menghilangkan overlap"
        );
    }

    #[test]
    fn overlap_crossfade_creates_equal_power_fades() {
        let (mut p, tid, _) = fixture();
        p.tracks[0].clips.push(Clip::new(
            ClipId::new(300),
            tid,
            AssetId::new(1),
            TimelineSample::new(200_000),
            48_000,
        ));
        p.tracks[0].sort_clips();
        EditCmd::MoveClip {
            clip: ClipId::new(300),
            to_track: tid,
            to_pos: TimelineSample::new(140_000),
        }
        .apply(&mut p, OverlapPolicy::Crossfade)
        .unwrap();
        let a = p.tracks[0].clip(ClipId::new(200)).unwrap();
        let b = p.tracks[0].clip(ClipId::new(300)).unwrap();
        assert_eq!(a.fade_out.curve, FadeCurve::EqualPower);
        assert_eq!(b.fade_in.curve, FadeCurve::EqualPower);
        assert_eq!(a.fade_out.len_timeline, 4_000);
        assert_eq!(b.fade_in.len_timeline, 4_000);
    }

    #[test]
    fn history_undo_redo_returns_to_same_state() {
        let (mut p, tid, cid) = fixture();
        let before = p.clone();
        let mut h = History::new(64);
        h.exec(
            &mut p,
            EditCmd::SetGain {
                clip: cid,
                gain_db: -12.0,
            },
            OverlapPolicy::Crossfade,
        )
        .unwrap();
        h.exec(
            &mut p,
            EditCmd::SplitAt {
                clip: cid,
                at: TimelineSample::new(96_000),
                new_id: ClipId::new(900),
            },
            OverlapPolicy::Crossfade,
        )
        .unwrap();
        h.exec(
            &mut p,
            EditCmd::MoveClip {
                clip: ClipId::new(900),
                to_track: TrackId::new(101),
                to_pos: TimelineSample::new(0),
            },
            OverlapPolicy::Crossfade,
        )
        .unwrap();
        let after_all = p.clone();

        while h.undo(&mut p, OverlapPolicy::Crossfade).unwrap() {}
        assert_eq!(p, before, "undo penuh harus kembali ke keadaan awal");
        while h.redo(&mut p, OverlapPolicy::Crossfade).unwrap() {}
        assert_eq!(p, after_all, "redo penuh harus kembali ke keadaan akhir");
        assert_eq!(tid, TrackId::new(100));
    }

    #[test]
    fn deleted_clip_asset_stays_pinned_by_history() {
        let (mut p, _, cid) = fixture();
        let mut h = History::new(64);
        h.exec(&mut p, EditCmd::Delete { clip: cid }, OverlapPolicy::Reject)
            .unwrap();
        assert_eq!(p.asset_refcount(AssetId::new(1)), 0);
        assert_eq!(p.unreferenced_assets(), alloc::vec![AssetId::new(1)]);
        assert_eq!(
            h.pinned_assets(),
            alloc::vec![AssetId::new(1)],
            "asset harus di-pin sampai undo dibuang"
        );
    }

    proptest! {
        /// Round-trip inverse untuk sembarang urutan edit acak.
        #[test]
        fn arbitrary_edit_sequence_is_fully_reversible(
            ops in prop::collection::vec(0u8..6, 1..12),
            vals in prop::collection::vec(0u64..200_000, 12),
        ) {
            let (mut p, _, cid) = fixture();
            let before = p.clone();
            let mut h = History::new(256);
            let mut next = 1000u64;
            for (i, op) in ops.iter().enumerate() {
                let v = vals[i % vals.len()];
                // Selalu pilih clip yang benar-benar ada.
                let target = p.tracks.iter().flat_map(|t| t.clips.iter()).map(|c| c.id).next().unwrap_or(cid);
                next += 1;
                let cmd = match op {
                    0 => EditCmd::TrimLeft { clip: target, new_start: TimelineSample::new(v) },
                    1 => EditCmd::TrimRight { clip: target, new_end: TimelineSample::new(v) },
                    2 => EditCmd::SplitAt { clip: target, at: TimelineSample::new(v), new_id: ClipId::new(next) },
                    3 => EditCmd::MoveClip { clip: target, to_track: TrackId::new(101), to_pos: TimelineSample::new(v) },
                    4 => EditCmd::SetGain { clip: target, gain_db: (v % 40) as f32 - 30.0 },
                    _ => EditCmd::Delete { clip: target },
                };
                let _ = h.exec(&mut p, cmd, OverlapPolicy::Crossfade); // error boleh, project tidak berubah
            }
            while h.undo(&mut p, OverlapPolicy::Crossfade).unwrap_or(false) {}
            prop_assert_eq!(p, before);
        }

        /// Split di titik mana pun mempertahankan total cakupan source.
        #[test]
        fn split_conserves_source(at in 1u64..95_999, ratio in 0.5f64..2.0) {
            let (mut p, _, cid) = fixture();
            p.tracks[0].clips[0].speed_ratio = ratio;
            let total = p.tracks[0].clips[0].source_len;
            let pos = p.tracks[0].clips[0].timeline_pos;
            let tl_len = p.tracks[0].clips[0].timeline_len();
            let at = TimelineSample::new(pos.raw() + (at % tl_len.max(2)).max(1));
            let split = EditCmd::SplitAt { clip: cid, at, new_id: ClipId::new(9999) };
            if split.apply(&mut p, OverlapPolicy::Crossfade).is_ok() {
                let sum: u64 = p.tracks[0].clips.iter().map(|c| c.source_len).sum();
                prop_assert_eq!(sum, total);
                prop_assert!(p.tracks[0].clips.iter().all(|c| c.source_len > 0));
            }
        }
    }
}
