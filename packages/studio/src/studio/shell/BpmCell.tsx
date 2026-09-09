/**
 * Sel BPM di readout strip — pelacak tempo gaya DJ.
 *
 * Yang dijawab: "materi yang sedang berbunyi di playhead ini berapa BPM,
 * SETELAH pitch fader lane dan kecepatan transport." Itu sebabnya angkanya
 * ikut berubah saat speed lane digeser, persis seperti angka BPM di CDJ.
 *
 * Empat keadaan dibedakan, dan tidak satu pun boleh terlihat seperti yang lain:
 *
 *   idle      "—"          tidak ada clip terdengar di playhead
 *   pending   "…"          worker WASM masih menganalisis
 *   unknown   "—" + nota   sudah dianalisis, materinya memang tanpa ketukan
 *   ada       angka        + tanda "?" kalau keyakinannya rendah
 *
 * Menampilkan "0.0" atau "—" tanpa keterangan untuk tiga keadaan yang berbeda
 * akan membuat user menunggu angka yang tidak akan pernah datang.
 */

import { memo, useEffect, useState } from 'react';

import {
  bpmSyncPlan,
  correctedBpm,
  selectDisplayedTempo,
  selectPlayheadTempo,
  type PlayheadTempo,
} from '../analysis/playhead-tempo';
import { TEMPO_UNCERTAIN, studioActions, useStudio } from '../store';

/** Selisih BPM di bawah ini dianggap "sudah match" dan tidak dilaporkan. */
const MATCH_EPSILON = 0.05;

/**
 * Nota di bawah angka. Memilih SATU hal terpenting untuk dikatakan, bukan
 * menumpuk semuanya — barisnya hanya selebar satu sel.
 *
 * Urutannya disengaja: selisih dengan lane lain lebih mendesak daripada
 * keterangan pitch, karena itu yang dipakai untuk beatmatch.
 */
export function tempoNote(t: PlayheadTempo): string | undefined {
  if (t.primary === null) {
    if (t.pending) return 'MENGANALISIS…';
    if (t.unknown) return 'TANPA KETUKAN JELAS';
    return undefined;
  }
  const other = t.others[0];
  if (other !== undefined) {
    const delta = other.bpm - t.primary.bpm;
    if (Math.abs(delta) < MATCH_EPSILON) return `SEIRAMA · ${t.others.length + 1} LANE`;
    const sign = delta > 0 ? '+' : '−';
    return `${other.laneName.toUpperCase()} ${sign}${Math.abs(delta).toFixed(1)}`;
  }
  if (Math.abs(t.primary.speedFactor - 1) > 1e-4) {
    return `SUMBER ${t.primary.sourceBpm.toFixed(1)}`;
  }
  if (t.primary.confidence < TEMPO_UNCERTAIN) return 'TIDAK YAKIN';
  return t.primary.laneName.toUpperCase();
}

/**
 * `memo` TANPA props bukan optimasi spekulatif: sel ini anak `ReadoutStrip`,
 * dan strip itu berlangganan `playhead` untuk selnya sendiri. Tanpa `memo`,
 * setiap gerakan playhead — puluhan kali per detik saat scrub dan saat
 * transport berjalan — me-render ulang sel BPM lewat induknya, melewati
 * langganan store-nya sendiri sepenuhnya.
 */
export const BpmCell = memo(function BpmCell(): JSX.Element {
  // Berlangganan ke seluruh state: sel ini memang bergantung pada playhead,
  // lanes, assets, dan speed sekaligus. Selector sempit di sini hanya akan
  // memindahkan penggabungannya ke tempat lain tanpa mengurangi render.
  const tempo = useStudio(selectDisplayedTempo);
  // Tombol sync tetap membandingkan clip yang benar-benar bertumpuk di
  // playhead; readout boleh mengikuti pilihan yang berada di tempat lain.
  const playheadTempo = useStudio(selectPlayheadTempo);
  const assets = useStudio((s) => s.assets);
  const selectedClipId = useStudio((s) => s.selectedClipId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const sync = bpmSyncPlan(playheadTempo, selectedClipId);
  const barSyncReady = useStudio((s) => {
    if (sync === null) return false;
    const assetFor = (clipId: string) => {
      for (const lane of s.lanes) {
        const clip = lane.clips.find((entry) => entry.id === clipId);
        if (clip !== undefined) return s.assets[clip.assetId];
      }
      return undefined;
    };
    const targetAsset = assetFor(sync.target.clipId);
    const referenceAsset = assetFor(sync.reference.clipId);
    return (
      targetAsset !== undefined &&
      referenceAsset !== undefined &&
      targetAsset.beatOffsetOverride !== null &&
      referenceAsset.beatOffsetOverride !== null
    );
  });

  // Oktaf dipakai pada ASSET dari clip yang sedang ditampilkan; tanpa clip
  // aktif tidak ada yang bisa digandakan.
  const activeAssetId = useStudio((s) => {
    const t = selectDisplayedTempo(s);
    if (t.primary === null) return null;
    for (const lane of s.lanes) {
      const clip = lane.clips.find((c) => c.id === t.primary?.clipId);
      if (clip !== undefined) return clip.assetId;
    }
    return null;
  });

  const uncertain = tempo.primary !== null && tempo.primary.confidence < TEMPO_UNCERTAIN;
  const value =
    tempo.primary !== null
      ? `${tempo.primary.bpm.toFixed(1)}${uncertain ? '?' : ''}`
      : tempo.pending
        ? '…'
        : '—';

  const asset = activeAssetId === null ? undefined : assets[activeAssetId];
  const locked = asset?.analysisLock === true;
  const shifted = asset !== undefined && asset.tempoOctave !== 0;
  const title =
    tempo.primary === null
      ? tempo.pending
        ? 'Menganalisis tempo di worker WASM.'
        : 'Tidak ada materi ber-tempo di posisi playhead.'
      : `Terdengar ${tempo.primary.bpm.toFixed(2)} BPM. Materi sumber ${tempo.primary.sourceBpm.toFixed(2)} BPM` +
        `${shifted ? ` (dikoreksi ${asset.tempoOctave > 0 ? '×' : '÷'}${2 ** Math.abs(asset.tempoOctave)})` : ''}` +
        `, kecepatan ${tempo.primary.speedFactor.toFixed(3)}×.` +
        (uncertain ? ' Keyakinan deteksi rendah — periksa dengan telinga.' : '');

  // Kalau playhead berpindah ke clip lain saat editor terbuka, tutup editor.
  // Menyimpan draft ke asset yang baru akan terasa seperti BPM clip A berubah
  // padahal angka tadi dibuka ketika clip B yang aktif.
  useEffect(() => setEditing(false), [activeAssetId]);

  const beginEdit = (): void => {
    if (activeAssetId === null || tempo.primary === null || locked) return;
    setDraft(tempo.primary.sourceBpm.toFixed(2).replace(/\.00$/, ''));
    setEditing(true);
  };

  const commitEdit = (): void => {
    if (!editing || activeAssetId === null) return;
    const bpm = Number(draft.replace(',', '.'));
    if (Number.isFinite(bpm)) {
      // Angka yang diketik adalah keputusan manual. Simpan override dahulu,
      // baru kunci asset; urutan sebaliknya akan membuat setter grid menolak
      // angka tersebut karena analysisLock memang melindungi semua edit grid.
      studioActions.setAssetBeatGrid(activeAssetId, { bpm });
      studioActions.setAnalysisLock(activeAssetId, true);
    }
    setEditing(false);
  };

  return (
    <div
      title={title}
      style={{
        flex: 1,
        minWidth: 0,
        padding: '9px 16px',
        borderRight: '1px solid var(--cy-border)',
      }}
    >
      <div
        style={{
          fontSize: '9px',
          letterSpacing: '.2em',
          color: 'var(--cy-text-muted)',
          textTransform: 'uppercase',
        }}
      >
        Bpm
      </div>
      {/* Tinggi dikunci: tombol ×2/÷2 muncul-hilang mengikuti ada-tidaknya clip
          di playhead, dan kotaknya sedikit lebih tinggi dari baseline angka —
          tanpa tinggi tetap, baris ini ikut tumbuh-susut saat scrub. Sama
          dengan baris nilai `CellView`. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '6px',
          marginTop: '2px',
          height: VALUE_LINE_HEIGHT,
        }}
      >
        {editing ? (
          <input
            aria-label="BPM clip"
            autoFocus
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') setEditing(false);
            }}
            style={{
              width: '72px',
              height: '22px',
              padding: '0 5px',
              border: '1px solid var(--cy-accent)',
              outline: 'none',
              background: 'var(--cy-surface-1)',
              color: 'var(--cy-accent)',
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '17px',
              fontWeight: 600,
            }}
          />
        ) : (
          <span
            onDoubleClick={beginEdit}
            title={
              activeAssetId === null
                ? undefined
                : locked
                  ? 'BPM terkunci — buka kunci sebelum mengubahnya'
                  : 'Double-click untuk mengubah BPM clip'
            }
            style={{
              fontFamily: 'var(--cy-font-sans)',
              fontSize: '19px',
              fontWeight: 600,
              color: uncertain ? 'var(--cy-text-dim)' : 'var(--cy-accent)',
              cursor: activeAssetId === null ? 'default' : locked ? 'not-allowed' : 'text',
              userSelect: 'none',
            }}
          >
            {value}
          </span>
        )}
        {activeAssetId !== null && tempo.primary !== null ? (
          <span style={{ display: 'flex', gap: '2px' }}>
            {([-1, 1] as const).map((d) => (
              <button
                key={d}
                type="button"
                disabled={locked}
                title={
                  d > 0
                    ? 'Gandakan BPM — oktaf tempo memang ambigu; 85 dan 170 sama sahnya.'
                    : 'Bagi dua BPM.'
                }
                onClick={() => studioActions.shiftAssetTempoOctave(activeAssetId, d)}
                style={{
                  fontFamily: 'var(--cy-font-mono)',
                  fontSize: '9px',
                  lineHeight: 1,
                  padding: '3px 4px',
                  background: 'transparent',
                  color: 'var(--cy-text-muted)',
                  border: '1px solid var(--cy-border)',
                  cursor: locked ? 'not-allowed' : 'pointer',
                  opacity: locked ? 0.4 : 1,
                }}
              >
                {d > 0 ? '×2' : '÷2'}
              </button>
            ))}
          </span>
        ) : null}
        {activeAssetId !== null && tempo.primary !== null ? (
          <button
            type="button"
            aria-label={locked ? 'Buka kunci BPM' : 'Kunci BPM'}
            aria-pressed={locked}
            title={
              locked
                ? 'BPM terkunci: buka kunci untuk mengedit atau memakai ×2/÷2'
                : 'Kunci BPM agar koreksi manual terlindungi dari perubahan grid'
            }
            onClick={() => studioActions.setAnalysisLock(activeAssetId, !locked)}
            style={{
              fontFamily: 'var(--cy-font-mono)',
              fontSize: '10px',
              lineHeight: 1,
              padding: '3px 4px',
              background: locked ? 'var(--cy-accent)' : 'transparent',
              color: locked ? 'var(--cy-text-on-accent)' : 'var(--cy-text-muted)',
              border: `1px solid ${locked ? 'var(--cy-accent)' : 'var(--cy-border)'}`,
              cursor: 'pointer',
            }}
          >
            {locked ? '🔒' : '🔓'}
          </button>
        ) : null}
        {sync !== null ? (
          <span style={{ display: 'flex', gap: '2px' }}>
            {([
              ['tempo', 'MATCH', 'Samakan BPM saja'],
              ['beat', 'BEAT', 'Samakan BPM dan posisi beat terdekat'],
              ['bar', 'BAR', 'Samakan BPM dan awal bar 4/4 terdekat'],
            ] as const).map(([mode, label, explanation]) => (
              <button
                key={mode}
                type="button"
                aria-label={`${label} sync ${sync.target.laneName}`}
                disabled={mode === 'bar' && !barSyncReady}
                title={
                  mode === 'bar' && !barSyncReady
                    ? 'BAR membutuhkan downbeat kedua clip yang sudah dikunci manual lewat SET 1/offset.'
                    : `${explanation}: ${sync.target.laneName} mengikuti ${sync.reference.laneName}. Varispeed: pitch ikut berubah.`
                }
                onClick={() => studioActions.syncClipTo(sync.target.clipId, sync.reference.clipId, mode)}
                style={{
                  fontFamily: 'var(--cy-font-mono)', fontSize: '8px', lineHeight: 1,
                  padding: '3px 4px', background: mode === 'tempo' ? 'transparent' : 'var(--cy-accent)',
                  color: mode === 'tempo' ? 'var(--cy-text-muted)' : 'var(--cy-text-on-accent)',
                  border: `1px solid ${mode === 'tempo' ? 'var(--cy-border)' : 'var(--cy-accent)'}`,
                  cursor: mode === 'bar' && !barSyncReady ? 'not-allowed' : 'pointer',
                  opacity: mode === 'bar' && !barSyncReady ? 0.4 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {/* Baris nota SELALU ada, walau kosong. Ini yang membuat timeline berhenti
          berkedip saat playhead digeser: nota ini muncul-hilang tiap kali
          playhead melewati sambungan clip, dan baris `readouts` di
          `StudioLayout` ber-`auto` — jadi strip-nya memendek, seluruh isi di
          bawahnya ikut naik-turun ~12 px, dan yang terlihat adalah timeline
          yang melompat mengikuti kursor. */}
      <NoteLine text={tempoNote(tempo)} />
    </div>
  );
})

/** Tinggi baris NILAI (angka 19px). Dibagi dengan `CellView` supaya kelima sel
 *  sejajar dan tidak ada yang berubah tinggi saat isinya berganti. */
export const VALUE_LINE_HEIGHT = '23px';

/** Tinggi baris nota, dikunci supaya sel yang punya nota dan yang tidak sama
 *  tingginya. 12px = line box wajar untuk teks 9px. */
export const NOTE_LINE_HEIGHT = '12px';

/**
 * Baris mikro di bawah nilai sel. Dipakai bersama `CellView` di `ReadoutStrip`
 * supaya kelima sel punya tinggi yang sama, apa pun isinya.
 */
export function NoteLine({ text }: { text?: string }): JSX.Element {
  return (
    <div
      style={{
        fontSize: '9px',
        lineHeight: NOTE_LINE_HEIGHT,
        height: NOTE_LINE_HEIGHT,
        letterSpacing: '.12em',
        color: 'var(--cy-text-muted)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text ?? ''}
    </div>
  );
}

/** Diekspor untuk tes: BPM sumber setelah koreksi oktaf. */
export { correctedBpm };
