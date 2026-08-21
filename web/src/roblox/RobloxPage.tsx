/**
 * Halaman `/roblox` — menyiapkan asset audio untuk diunggah ke Roblox.
 *
 * ## Apa yang SUDAH dan BELUM dilakukan halaman ini
 *
 * Sudah: menerima berkas (drop & dialog), menyaring yang bukan audio, mengukur
 * durasinya, menyunting nama & deskripsi tiap asset, memvalidasi semuanya
 * terhadap batas Roblox (MP3/OGG · 7 menit · 20 MB · nama 50 karakter), dan
 * memilih pemilik + kunci Open Cloud.
 *
 * Belum: mengirimnya. Lapisan unggah dan collection dikerjakan agent lain, dan
 * halaman ini sengaja berhenti tepat di depan pintu itu — bukan memalsukannya.
 * Tombol UNGGAH mati dengan alasan tertulis selama `backendReady === false`,
 * karena tombol yang menyala lalu diam adalah bug yang paling mahal untuk
 * ditemukan: user mengira berkasnya sudah terkirim.
 *
 * ## Seam untuk agent unggah
 *
 * Satu prop, `onUpload`, dan satu store. Pemasangnya:
 *
 *   1. memanggil `robloxActions.setBackendReady(true, sisaKuota)` saat siap —
 *      badge header dan tombol UNGGAH hidup dengan sendirinya;
 *   2. menerima daftar baris siap kirim di `onUpload`;
 *   3. mengambil byte-nya lewat `fileOf(item.id)`;
 *   4. melapor balik lewat `markUploading` / `markProgress` / `markProcessing`
 *      / `markDone` / `markFailed`.
 *
 * Tidak ada yang perlu diubah di berkas ini untuk itu.
 */

import { useCallback, useState } from 'react';

import { useCommands } from '../app-shell';
import { Button } from '../ui/cyber';
import { RobloxHeader } from './header/RobloxHeader';
import { GrantAccess } from './grant/GrantAccess';
import type { GrantApi } from './grant/api';
import { TargetPanel } from './destination/TargetPanel';
import { DetailPanel } from './upload/DetailPanel';
import { DropZone } from './upload/DropZone';
import { UploadQueue } from './upload/UploadQueue';
import { useDurations } from './upload/useDurations';
import { isBusy, readyItems, targetProblems, type QueueItem } from './model';
import { robloxActions, robloxStore, useRoblox } from './store';
import './roblox.css';

export interface RobloxPageProps {
  readonly onClose?: () => void;
  readonly onOpenStudio?: () => void;
  /**
   * Kirim baris-baris ini ke Roblox. Belum dipasang siapa pun; selama
   * `undefined` ATAU selama store berkata backend belum siap, tombol UNGGAH
   * mati dan halaman mengatakan alasannya.
   */
  readonly onUpload?: (items: readonly QueueItem[]) => void;
  readonly grantApi?: GrantApi | null;
}

export function RobloxPage({ onClose, onOpenStudio, onUpload, grantApi }: RobloxPageProps): JSX.Element {
  const state = useRoblox();
  const [rejected, setRejected] = useState<readonly string[]>([]);
  const [tab, setTab] = useState<'upload' | 'grant'>('upload');

  useDurations();

  const busy = isBusy(state);
  const ready = readyItems(state);
  const problems = targetProblems(state.target);
  const selected = state.items.find((it) => it.id === state.selected) ?? null;

  const onFiles = useCallback((files: readonly File[]): void => {
    setRejected(robloxActions.addFiles(files));
  }, []);

  /*
   * Kenapa tombolnya mati, dinyatakan sebagai KALIMAT dan bukan cuma
   * `disabled`. Urutannya dari yang paling struktural ke yang paling mudah
   * diperbaiki user, dan hanya yang pertama yang dipajang: memberi tiga alasan
   * sekaligus membuat user memperbaiki yang salah lebih dulu.
   */
  const blockedBecause =
    onUpload === undefined || !state.backendReady
      ? 'Lapisan unggah belum tersambung — halaman ini masih UI saja.'
      : busy
        ? 'Antrean sedang berjalan.'
        : problems.length > 0
          ? problems[0]
          : ready.length === 0
            ? 'Belum ada berkas yang siap dikirim.'
            : null;

  /*
   * Tanpa chord bawaan, keduanya. Halaman ini bukan permukaan yang dipakai
   * sambil menahan tangan di keyboard seperti DJ — dan aksi yang MENGHAPUS
   * baris adalah kandidat terburuk untuk tombol tunggal yang bisa tersenggol.
   */
  useCommands(
    [
      {
        id: 'roblox.bersihkan-selesai',
        title: 'ROBLOX: bersihkan yang sudah selesai',
        group: 'Roblox',
        defaultChord: null,
        enabled: () => {
          const current = robloxStore.getState();
          return !isBusy(current) && current.items.some((it) => it.status === 'done');
        },
        run: () => robloxActions.clearDone(),
      },
      {
        id: 'roblox.kosongkan',
        title: 'ROBLOX: kosongkan antrean',
        group: 'Roblox',
        defaultChord: null,
        enabled: () => {
          const current = robloxStore.getState();
          return !isBusy(current) && current.items.length > 0;
        },
        run: () => {
          robloxActions.clearAll();
          setRejected([]);
        },
      },
    ],
    [],
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--cy-bg)',
        color: 'var(--cy-text)',
        fontFamily: 'var(--cy-font-mono)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <RobloxHeader onClose={onClose} onOpenStudio={onOpenStudio} />

      <nav className="rbx-tabs" aria-label="Fitur Roblox">
        <button aria-selected={tab === 'upload'} onClick={() => setTab('upload')}>AUDIO UPLOAD</button>
        <button aria-selected={tab === 'grant'} onClick={() => setTab('grant')}>GRANT ACCESS</button>
      </nav>

      {tab === 'upload' ? <><div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          // Dua kolom di layar lebar, satu kolom di bawah 900px. Kolom kanan
          // (tujuan + detail) adalah tempat metadata disunting; ia tidak lebih
          // penting dari antrean, tapi juga tidak boleh terdorong ke bawah
          // lipatan di layar lebar.
          gridTemplateColumns: 'minmax(0,1fr) minmax(300px, 380px)',
          gap: '16px',
          padding: '16px',
          alignContent: 'start',
        }}
        className="rbx-body"
      >
        <div style={{ display: 'grid', gap: '16px', minWidth: 0, alignContent: 'start' }}>
          <DropZone onFiles={onFiles} disabled={busy} />

          {rejected.length > 0 ? (
            <p
              role="status"
              style={{
                margin: 0,
                padding: '8px 10px',
                border: '1px solid #ff4d4d59',
                background: '#ff4d4d0f',
                color: '#ff4d4d',
                fontSize: '10px',
                lineHeight: 1.7,
              }}
            >
              {rejected.length} berkas dilewati karena bukan MP3/OGG: {rejected.join(', ')}
            </p>
          ) : null}

          <UploadQueue
            state={state}
            onSelect={robloxActions.select}
            onRemove={robloxActions.remove}
            onRetry={robloxActions.retry}
            onClearDone={robloxActions.clearDone}
            onClearAll={() => {
              robloxActions.clearAll();
              setRejected([]);
            }}
          />
        </div>

        <div style={{ display: 'grid', gap: '16px', minWidth: 0, alignContent: 'start' }}>
          <TargetPanel
            target={state.target}
            onCreatorKind={robloxActions.setCreatorKind}
            onCreatorId={robloxActions.setCreatorId}
            onApiKey={robloxActions.setApiKey}
            locked={busy}
          />
          <DetailPanel
            item={selected}
            onName={robloxActions.setName}
            onDescription={robloxActions.setDescription}
            locked={busy}
          />
        </div>
      </div>

      {/* Baris aksi menempel di bawah: keputusan "kirim" harus terjangkau
          berapa pun panjang antrean, tanpa menggulir kembali ke atas. */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          padding: '10px 16px',
          borderTop: '1px solid var(--cy-border)',
          background: 'var(--cy-surface-1)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: '10px', letterSpacing: '.12em', color: 'var(--cy-text-dim)' }}>
          {ready.length} DARI {state.items.length} SIAP KIRIM
        </span>
        {blockedBecause !== null ? (
          <span style={{ fontSize: '10px', lineHeight: 1.6, color: 'var(--cy-warning)' }}>
            {blockedBecause}
          </span>
        ) : null}
        <div style={{ marginLeft: 'auto' }}>
          <Button
            size="md"
            disabled={blockedBecause !== null}
            onClick={() => onUpload?.(ready)}
            title={blockedBecause ?? `Kirim ${ready.length} asset ke Roblox`}
          >
            UNGGAH {ready.length > 0 ? ready.length : ''}
          </Button>
        </div>
      </div></> : <GrantAccess api={grantApi ?? null} uploadTarget={state.target} uploadItems={state.items} />}
    </div>
  );
}
