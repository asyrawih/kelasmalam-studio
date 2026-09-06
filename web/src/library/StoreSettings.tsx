/**
 * Panel PENYIMPANAN di layar pengaturan (⌘,) — docs/21 K3.
 *
 * Hanya hidup di desktop: web tidak punya folder (kepustakaannya R2/D1,
 * docs/16), jadi di web komponen ini mengembalikan `null` SEBELUM menyentuh
 * `invoke` — bukan merender kerangka kosong, dan bukan memanggil `store_info`
 * yang di browser melempar karena `__TAURI_INTERNALS__` tidak ada.
 *
 * ## Alur pindah folder
 *
 *   PINDAHKAN FOLDER… → dialog native pilih folder → konfirmasi DI HALAMAN
 *   (menyebut ukuran yang akan disalin) → `store_relocate` + bar progres dari
 *   event `daw://store-relocate` → info diperbarui, atau pesan galat.
 *
 * Konfirmasinya di halaman, bukan `ask()` native: dialog native yang kedua
 * beruntun sesudah pemilih folder terasa seperti dua kali ditanya hal yang
 * sama, dan kalimat konfirmasi di sini memuat path tujuan yang panjang —
 * lebih terbaca di panel daripada di kotak pesan OS.
 *
 * Listener event dipasang SEBELUM `invoke` dipanggil dan dilepas sesudahnya
 * selesai (berhasil atau tidak): Rust mulai memancarkan progres begitu
 * command masuk, dan listener yang terlambat kehilangan byte pertama.
 *
 * ## Galat
 *
 * Pesan `LocalError` diteruskan apa adanya (`store-settings.ts`), ditambah
 * kalimat "folder lama tetap utuh" — itu janji kontrak `store_relocate`
 * (salin → verifikasi → tukar → hapus lama), dan user yang baru melihat
 * "gagal" perlu tahu lagunya tidak ke mana-mana.
 */

import { useEffect, useState } from 'react';

import { isDesktop } from '../app-shell/desktop';
import type { StoreInfo } from '../platform/local-commands';
import { LOCAL_EVENTS } from '../platform/local-commands';
import { callLocal, toLocalError } from '../platform/local-invoke';
import { Button, ProgressBar } from '../ui/cyber';
import { formatBytes } from './model';
import {
  confirmRelocateMessage,
  formatStoreBytes,
  relocateFailureMessage,
  relocatePercent,
  revealLabel,
  STORE_HELP,
} from './store-settings';

type Progress = { readonly done: number; readonly total: number };

/**
 * Keadaan panel dalam satu union supaya tidak ada kombinasi mustahil
 * ("sedang menyalin" sekaligus "menunggu konfirmasi").
 */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirm'; readonly newDir: string }
  | { readonly kind: 'relocating'; readonly newDir: string; readonly progress: Progress };

export function StoreSettings(): JSX.Element | null {
  // Diperiksa di dalam komponen, bukan oleh pemasangnya, supaya SETIAP tempat
  // yang memasang panel ini otomatis aman di web — tidak ada yang bisa lupa.
  if (!isDesktop()) return null;
  return <DesktopStoreSettings />;
}

function DesktopStoreSettings(): JSX.Element {
  const [info, setInfo] = useState<StoreInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [notice, setNotice] = useState<{ readonly tone: 'ok' | 'error'; readonly text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    callLocal('store_info', {}).then(
      (i) => {
        if (alive) setInfo(i);
      },
      (reason: unknown) => {
        if (alive) setLoadError(toLocalError(reason).message);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const busy = phase.kind === 'relocating';

  async function pickFolder(): Promise<void> {
    if (info === null || busy) return;
    setNotice(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        directory: true,
        multiple: false,
        title: 'Folder kepustakaan baru',
        defaultPath: info.dir,
      });
      // Batal di dialog = tidak ada yang berubah; tidak perlu pesan.
      if (picked === null) return;
      const newDir = Array.isArray(picked) ? picked[0] : picked;
      if (newDir === undefined) return;
      setPhase({ kind: 'confirm', newDir });
    } catch (reason: unknown) {
      setNotice({ tone: 'error', text: `dialog pilih folder gagal: ${toLocalError(reason).message}` });
    }
  }

  async function relocate(newDir: string): Promise<void> {
    setNotice(null);
    setPhase({ kind: 'relocating', newDir, progress: { done: 0, total: 0 } });
    let unlisten: (() => void) | null = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<Progress>(LOCAL_EVENTS.storeRelocate, (e) => {
        setPhase({ kind: 'relocating', newDir, progress: e.payload });
      });
      const next = await callLocal('store_relocate', { newDir });
      setInfo(next);
      setNotice({ tone: 'ok', text: `Kepustakaan dipindahkan ke ${next.dir}` });
    } catch (reason: unknown) {
      setNotice({ tone: 'error', text: relocateFailureMessage(toLocalError(reason)) });
    } finally {
      unlisten?.();
      setPhase({ kind: 'idle' });
    }
  }

  async function reveal(): Promise<void> {
    if (info === null) return;
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(info.dir);
    } catch (reason: unknown) {
      setNotice({ tone: 'error', text: `tidak bisa membuka folder: ${toLocalError(reason).message}` });
    }
  }

  return (
    <section aria-label="penyimpanan" style={{ borderBottom: '1px solid var(--cy-border)', paddingBottom: '8px' }}>
      <div
        style={{
          fontSize: '9px',
          letterSpacing: '.18em',
          color: 'var(--cy-text-muted)',
          padding: '8px 12px 3px',
        }}
      >
        PENYIMPANAN
      </div>

      {loadError !== null ? (
        <p role="alert" style={{ ...ROW, color: '#ff4d4d' }}>
          folder kepustakaan tidak terbaca: {loadError}
        </p>
      ) : info === null ? (
        <p style={{ ...ROW, color: 'var(--cy-text-muted)' }}>membaca folder kepustakaan…</p>
      ) : (
        <>
          <dl style={{ ...ROW, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0 }}>
            <dt style={DT}>FOLDER</dt>
            <dd data-testid="store-dir" title={info.dir} style={{ ...DD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {info.dir}
            </dd>
            <dt style={DT}>UKURAN</dt>
            <dd data-testid="store-bytes" style={DD}>
              {formatStoreBytes(info.bytes)}
            </dd>
            <dt style={DT}>ISI</dt>
            <dd data-testid="store-count" style={DD}>
              {info.tracks} lagu · {info.projects} project
            </dd>
            <dt style={DT}>SKEMA</dt>
            <dd data-testid="store-schema" style={DD}>
              v{info.schemaVersion}
            </dd>
          </dl>

          <p style={{ ...ROW, color: 'var(--cy-text-muted)', margin: '4px 0 6px' }}>{STORE_HELP}</p>

          {phase.kind === 'confirm' ? (
            <div role="group" aria-label="konfirmasi pindah" style={{ ...ROW, display: 'grid', gap: '6px' }}>
              <span style={{ color: '#ffb020' }}>{confirmRelocateMessage(info, phase.newDir)}</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <Button size="sm" onClick={() => void relocate(phase.newDir)}>
                  PINDAHKAN
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPhase({ kind: 'idle' })}>
                  BATAL
                </Button>
              </div>
            </div>
          ) : phase.kind === 'relocating' ? (
            <div style={{ ...ROW, display: 'grid', gap: '4px' }}>
              <ProgressBar label="MENYALIN KE FOLDER BARU" value={relocatePercent(phase.progress)} showValue />
              <span data-testid="store-progress" style={{ color: 'var(--cy-text-muted)' }}>
                {formatBytes(phase.progress.done)} / {formatBytes(phase.progress.total)} · {phase.newDir}
              </span>
            </div>
          ) : (
            <div style={{ ...ROW, display: 'flex', gap: '6px' }}>
              <Button size="sm" variant="outline" onClick={() => void pickFolder()}>
                PINDAHKAN FOLDER…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void reveal()}>
                {revealLabel(navigator.userAgent)}
              </Button>
            </div>
          )}
        </>
      )}

      {notice !== null ? (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          style={{ ...ROW, margin: '6px 0 0', color: notice.tone === 'error' ? '#ff4d4d' : 'var(--cy-accent)' }}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}

const ROW = { fontSize: '10px', padding: '2px 12px', fontFamily: 'var(--cy-font-mono)' } as const;
const DT = { color: 'var(--cy-text-muted)', letterSpacing: '.12em' } as const;
const DD = { margin: 0, color: 'var(--cy-text)' } as const;
