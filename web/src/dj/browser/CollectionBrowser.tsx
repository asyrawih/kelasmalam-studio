/**
 * Collection — daftar lagu di kepustakaan, plus tempat menjatuhkan file.
 *
 * Sumbernya `studioStore.assets`, BUKAN daftar kedua. Lagu yang diimpor di
 * `/studio` langsung muncul di sini dan sebaliknya; satu registry, satu jalur
 * decode, satu IndexedDB.
 *
 * Dua kolom yang sengaja menampilkan ketidaktahuan alih-alih angka:
 *
 *  - **BPM** menulis `ANALISIS…` selama worker masih bekerja, dan `—` untuk
 *    materi yang memang tidak bisa dianalisis (di bawah 8 detik, senyap). Angka
 *    dengan keyakinan rendah ditandai `?`, bukan disembunyikan — aturan
 *    `docs/10`: "tidak menebak diam-diam".
 *  - **KEY** selalu `—`: `crates/analysis` belum punya deteksi nada dasar sama
 *    sekali. Kolomnya tetap ada karena tempatnya memang di sana.
 */

import { useMemo, useRef, useState } from 'react';

import { TEMPO_UNCERTAIN, useStudio } from '../../studio/store';
import { formatDeckTime, type DeckId } from '../model';
import { djActions, useDj } from '../store';
import { filterSort, rowsOf, type CollectionRow } from './collection';
import { importFilesToDeck } from './dj-import';
import { inspectRemoval, removeAssetFromLibrary } from './dj-remove';

const HEAD: React.CSSProperties = {
  fontSize: '9px',
  letterSpacing: '.14em',
  color: 'var(--cy-text-muted)',
  textAlign: 'left',
  padding: '3px 6px',
  borderBottom: '1px solid var(--cy-border)',
  position: 'sticky',
  top: 0,
  background: 'var(--cy-surface-1)',
  cursor: 'pointer',
  userSelect: 'none',
};

const CELL: React.CSSProperties = {
  fontSize: '10px',
  padding: '3px 6px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/**
 * Tombol hapus satu baris, dua langkah.
 *
 * `title` menyebutkan KONSEKUENSINYA sebelum ditekan — berapa clip Studio yang
 * memakainya, apakah sedang di deck, apakah ada cue yang ikut hilang. Itu
 * dihitung saat dibutuhkan, bukan dilanggankan: daftar bisa berisi ratusan
 * baris, dan menghitung pemakaian untuk semuanya tiap render berarti menyisir
 * seluruh timeline sebanyak jumlah lagunya.
 */
function RemoveCell({
  assetId,
  name,
  pending,
  onArm,
  onCancel,
  onConfirm,
}: {
  readonly assetId: number;
  readonly name: string;
  readonly pending: boolean;
  readonly onArm: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const describe = (): string => {
    const r = inspectRemoval(assetId);
    if (r.clips > 0) return `"${name}" dipakai ${r.clips} clip di Studio — tidak bisa dihapus dari sini`;
    const extra: string[] = [];
    if (r.decks.length > 0) extra.push(`deck ${r.decks.join(' & ')} akan dikosongkan`);
    if (r.hasCues) extra.push('hot cue-nya ikut hilang');
    const tail = extra.length > 0 ? ` — ${extra.join(', ')}` : '';
    return `hapus "${name}" dari kepustakaan${tail}. Tidak bisa dibatalkan.`;
  };

  return (
    <button
      type="button"
      className="cy-btn-reset"
      title={describe()}
      onClick={(e) => {
        e.stopPropagation();
        if (pending) onConfirm();
        else onArm();
      }}
      onPointerLeave={() => {
        if (pending) onCancel();
      }}
      style={{
        fontSize: '9px',
        padding: '1px 6px',
        fontFamily: 'var(--cy-font-mono)',
        color: pending ? 'var(--cy-text-on-accent)' : 'var(--cy-text-muted)',
        background: pending ? '#ff4d4d' : 'transparent',
        border: `1px solid ${pending ? '#ff4d4d' : 'var(--cy-border)'}`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {pending ? 'HAPUS?' : '✕'}
    </button>
  );
}

export function CollectionBrowser(): JSX.Element {
  const assets = useStudio((s) => s.assets);
  const sampleRate = useStudio((s) => s.sampleRate);
  const query = useDj((s) => s.browse.query);
  const sort = useDj((s) => s.browse.sort);
  const ascending = useDj((s) => s.browse.ascending);
  const selected = useDj((s) => s.browse.selectedAssetId);

  const [dragOver, setDragOver] = useState(false);
  /**
   * Baris yang sedang MENUNGGU KONFIRMASI hapus.
   *
   * Konfirmasi dua-langkah di dalam barisnya sendiri, bukan dialog: menghapus
   * lagu **tidak bisa dibatalkan** — byte aslinya ikut hilang dari IndexedDB,
   * dan kalau berkasnya sudah tidak ada di disk user, ia hilang untuk selamanya.
   * Tapi dialog untuk setiap baris di daftar yang bisa berisi ratusan lagu
   * adalah gangguan yang membuat orang berhenti membacanya, lalu mengklik OK
   * tanpa melihat. Tombol yang berubah jadi "HAPUS?" di tempatnya menuntut
   * gerakan kedua di posisi yang sama, dan itu cukup.
   */
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(
    () => filterSort(rowsOf(assets), query, sort, ascending),
    [assets, query, sort, ascending],
  );

  const loadTo = (row: CollectionRow, deck: DeckId): void => {
    djActions.loadDeck(deck, {
      assetId: row.asset.id,
      frames: row.asset.frames,
      name: row.asset.name,
      sampleRate: row.asset.sampleRate,
    });
  };

  const takeFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    void importFilesToDeck([...files], null, sampleRate);
  };

  const remove = (assetId: number): void => {
    void removeAssetFromLibrary(assetId).then((r) => {
      setPendingRemove(null);
      djActions.setNotice(r.ok ? null : (r.reason ?? 'gagal menghapus'));
    });
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        takeFiles(e.dataTransfer.files);
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: dragOver ? '#ffd4000f' : 'var(--cy-bg)',
        outline: dragOver ? '1px dashed var(--cy-accent)' : 'none',
        outlineOffset: '-2px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 8px',
          borderBottom: '1px solid var(--cy-border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: '10px', letterSpacing: '.16em', color: 'var(--cy-text-dim)' }}>
          COLLECTION ({rows.length})
        </span>
        <input
          value={query}
          onChange={(e) => djActions.setBrowseQuery(e.target.value)}
          placeholder="CARI JUDUL"
          aria-label="cari judul"
          style={{
            background: 'var(--cy-surface-2)',
            border: '1px solid var(--cy-border)',
            color: 'var(--cy-text)',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '10px',
            padding: '3px 6px',
            width: '160px',
          }}
        />
        <button
          type="button"
          className="cy-btn-reset"
          onClick={() => fileRef.current?.click()}
          style={{
            fontSize: '9px',
            letterSpacing: '.12em',
            padding: '3px 10px',
            fontFamily: 'var(--cy-font-mono)',
            color: 'var(--cy-accent)',
            border: '1px solid var(--cy-accent)',
            background: 'var(--cy-surface-2)',
            cursor: 'pointer',
          }}
        >
          + TAMBAH FILE
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          multiple
          onChange={(e) => {
            takeFiles(e.target.files);
            e.target.value = '';
          }}
          style={{ display: 'none' }}
        />
        <span style={{ fontSize: '9px', color: 'var(--cy-text-muted)', marginLeft: 'auto' }}>
          jatuhkan berkas audio di mana saja di baris ini
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div
            style={{
              padding: '18px',
              textAlign: 'center',
              fontSize: '11px',
              color: 'var(--cy-text-muted)',
            }}
          >
            KEPUSTAKAAN KOSONG — JATUHKAN BERKAS AUDIO DI SINI
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...HEAD, width: '90px', cursor: 'default' }}>DECK</th>
                <th style={HEAD} onClick={() => djActions.setBrowseSort('name')}>
                  JUDUL {sort === 'name' ? (ascending ? '▲' : '▼') : ''}
                </th>
                <th
                  style={{ ...HEAD, width: '80px' }}
                  onClick={() => djActions.setBrowseSort('bpm')}
                >
                  BPM {sort === 'bpm' ? (ascending ? '▲' : '▼') : ''}
                </th>
                <th style={{ ...HEAD, width: '60px', cursor: 'default' }}>KEY</th>
                <th
                  style={{ ...HEAD, width: '70px' }}
                  onClick={() => djActions.setBrowseSort('time')}
                >
                  WAKTU {sort === 'time' ? (ascending ? '▲' : '▼') : ''}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.asset.id}
                  className="cy-hover-row"
                  onClick={() => djActions.selectBrowseAsset(row.asset.id)}
                  style={{
                    background:
                      selected === row.asset.id ? '#ffd40014' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <td style={{ ...CELL, display: 'flex', gap: '3px' }}>
                    {(['A', 'B'] as const).map((deck) => (
                      <button
                        key={deck}
                        type="button"
                        className="cy-btn-reset"
                        onClick={(e) => {
                          e.stopPropagation();
                          loadTo(row, deck);
                        }}
                        title={`muat ke deck ${deck}`}
                        style={{
                          fontSize: '9px',
                          padding: '1px 7px',
                          fontFamily: 'var(--cy-font-mono)',
                          color: deck === 'A' ? '#ffd400' : '#ffb020',
                          border: `1px solid ${deck === 'A' ? '#ffd400' : '#ffb020'}`,
                          background: 'transparent',
                          cursor: 'pointer',
                        }}
                      >
                        {deck}
                      </button>
                    ))}
                  </td>
                  <td style={{ ...CELL, color: 'var(--cy-text)' }} title={row.name}>
                    {row.name}
                  </td>
                  <td style={{ ...CELL, color: 'var(--cy-accent)', fontVariantNumeric: 'tabular-nums' }}>
                    {row.analyzing ? (
                      <span style={{ color: 'var(--cy-text-muted)' }}>ANALISIS…</span>
                    ) : row.bpm === null ? (
                      <span
                        style={{ color: 'var(--cy-text-muted)' }}
                        title="materi terlalu pendek atau tanpa ketukan jelas"
                      >
                        —
                      </span>
                    ) : (
                      <>
                        {row.bpm.toFixed(1)}
                        {row.asset.bpmOverride === null &&
                        row.asset.tempo !== null &&
                        row.asset.tempo.confidence < TEMPO_UNCERTAIN ? (
                          <span style={{ color: '#ffb020' }} title="keyakinan deteksi rendah">
                            {' '}
                            ?
                          </span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td
                    style={{ ...CELL, color: 'var(--cy-text-muted)' }}
                    title="deteksi nada dasar belum ada di crates/analysis"
                  >
                    —
                  </td>
                  <td style={{ ...CELL, color: 'var(--cy-text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                    {formatDeckTime(row.durationSec)}
                  </td>
                  <td style={CELL}>
                    <RemoveCell
                      assetId={row.asset.id}
                      name={row.name}
                      pending={pendingRemove === row.asset.id}
                      onArm={() => setPendingRemove(row.asset.id)}
                      onCancel={() => setPendingRemove(null)}
                      onConfirm={() => remove(row.asset.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
