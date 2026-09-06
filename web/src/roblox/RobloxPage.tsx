/**
 * Halaman `/roblox` — menyiapkan asset audio untuk diunggah ke Roblox.
 *
 * ## Empat tab, satu store
 *
 *   UNGGAH     antrean + kategori/genre WAJIB (docs/21 §1d), pilihan massal
 *   KATALOG    yang sudah selesai, dikelompokkan kategori → genre (§3a)
 *   TAKSONOMI  sunting kategori/genre; hapus ditolak kalau dipakai
 *   GRANT      Grant Access (web); di desktop "belum tersedia" (§3f)
 *
 * Halaman ini UI MURNI: ia tidak tahu apa pun tentang HTTP maupun Tauri.
 * Yang membedakan web dan desktop masuk lewat prop (`platform`, `onUpload`,
 * `onSaveTarget`, `grantApi`) yang dipasang `RobloxRoute`. Dengan begitu
 * halaman yang sama bisa dites tanpa jaringan dan tanpa Tauri.
 *
 * ## Tombol UNGGAH mati dengan alasan tertulis
 *
 * Tombol yang menyala lalu diam adalah bug yang paling mahal untuk ditemukan:
 * user mengira berkasnya sudah terkirim. Selama `backendReady === false`
 * tombolnya mati DAN kalimatnya menyebut penyebab yang bisa diperbaiki user —
 * di web "lapisan unggah belum tersambung", di desktop "API key belum ada".
 */

import { useCallback, useState } from 'react';

import { useCommands } from '../app-shell';
import type { PlatformKind } from '../platform';
import { Button } from '../ui/cyber';
import { RobloxHeader } from './header/RobloxHeader';
import { GrantAccess } from './grant/GrantAccess';
import type { GrantApi } from './grant/api';
import { TargetPanel } from './destination/TargetPanel';
import { TaxonomyPanel } from './taxonomy/TaxonomyPanel';
import { DetailPanel } from './upload/DetailPanel';
import { DropZone } from './upload/DropZone';
import { UploadQueue } from './upload/UploadQueue';
import { useDurations } from './upload/useDurations';
import { isBusy, readyItems, targetProblems, type QueueItem, type RobloxTarget } from './model';
import { robloxActions, robloxStore, useRoblox } from './store';
import './roblox.css';

export type RobloxTab = 'upload' | 'catalog' | 'taxonomy' | 'grant';

export interface RobloxPageProps {
  readonly onClose?: () => void;
  readonly onOpenStudio?: () => void;
  /**
   * Kirim baris-baris ini ke Roblox. Selama `undefined` ATAU selama store
   * berkata backend belum siap, tombol UNGGAH mati dan halaman mengatakan
   * alasannya.
   */
  readonly onUpload?: (items: readonly QueueItem[]) => void;
  readonly grantApi?: GrantApi | null;
  readonly onSaveTarget?: (target: RobloxTarget) => Promise<void>;
  /** Mengubah kalimat & badge, bukan perilaku: tidak ada `if (isTauri)` di sini. */
  readonly platform?: PlatformKind;
}

export function RobloxPage({
  onClose,
  onOpenStudio,
  onUpload,
  grantApi,
  onSaveTarget,
  platform = 'web',
}: RobloxPageProps): JSX.Element {
  const state = useRoblox();
  const [rejected, setRejected] = useState<readonly string[]>([]);
  const [tab, setTab] = useState<RobloxTab>('upload');
  // Baris yang dicentang untuk pilihan massal. Hidup di halaman, bukan store:
  // ia tidak perlu bertahan melewati refresh, dan baris yang hilang dari
  // antrean cukup diabaikan saat diterapkan.
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());

  useDurations();

  const busy = isBusy(state);
  const ready = readyItems(state);
  const problems = targetProblems(state.target, state.apiKeyStored);
  const selected = state.items.find((it) => it.id === state.selected) ?? null;

  const onFiles = useCallback((files: readonly File[]): void => {
    setRejected(robloxActions.addFiles(files));
  }, []);

  const onCheck = useCallback((id: number, on: boolean): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /*
   * Kenapa tombolnya mati, dinyatakan sebagai KALIMAT dan bukan cuma
   * `disabled`. Urutannya dari yang paling struktural ke yang paling mudah
   * diperbaiki user, dan hanya yang pertama yang dipajang: memberi tiga alasan
   * sekaligus membuat user memperbaiki yang salah lebih dulu.
   */
  const blockedBecause =
    onUpload === undefined || !state.backendReady
      ? platform === 'desktop'
        ? !state.apiKeyStored
          ? 'API key Open Cloud belum tersimpan — tempel di panel TUJUAN lalu SIMPAN.'
          : 'ID pemilik belum diisi — isi di panel TUJUAN lalu SIMPAN.'
        : 'Lapisan unggah belum tersambung — halaman ini masih UI saja.'
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

  const tabs: readonly { readonly id: RobloxTab; readonly label: string }[] = [
    { id: 'upload', label: 'UNGGAH' },
    { id: 'taxonomy', label: 'TAKSONOMI' },
    { id: 'grant', label: 'GRANT ACCESS' },
  ];

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
      <RobloxHeader onClose={onClose} onOpenStudio={onOpenStudio} platform={platform} />

      <nav className="rbx-tabs" aria-label="Fitur Roblox">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'upload' ? (
        <>
          <div
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
                checked={checked}
                onSelect={robloxActions.select}
                onCheck={onCheck}
                onCheckAll={(ids) => setChecked(new Set(ids))}
                onRemove={robloxActions.remove}
                onRetry={robloxActions.retry}
                onCategory={robloxActions.setCategory}
                onGenre={robloxActions.setGenre}
                onClearDone={robloxActions.clearDone}
                onClearAll={() => {
                  robloxActions.clearAll();
                  setChecked(new Set());
                  setRejected([]);
                }}
              />
            </div>

            <div style={{ display: 'grid', gap: '16px', minWidth: 0, alignContent: 'start' }}>
              <TargetPanel
                target={state.target}
                apiKeyStored={state.apiKeyStored}
                onCreatorKind={robloxActions.setCreatorKind}
                onCreatorId={robloxActions.setCreatorId}
                onApiKey={robloxActions.setApiKey}
                onGenreToDescription={robloxActions.setGenreToDescription}
                onSave={onSaveTarget}
                storageNote={
                  platform === 'desktop'
                    ? 'Disimpan di keychain OS mesin ini. Tidak pernah masuk basis data maupun log aplikasi.'
                    : 'Disimpan terenkripsi di D1 untuk akun Google yang sedang login.'
                }
                locked={busy}
              />
              <DetailPanel
                item={selected}
                taxonomy={state.taxonomy}
                genreToDescription={state.target.genreToDescription}
                onName={robloxActions.setName}
                onDescription={robloxActions.setDescription}
                onCategory={(id, categoryId) => robloxActions.setCategory([id], categoryId)}
                onGenre={(id, genreId) => robloxActions.setGenre([id], genreId)}
                onNewGenre={robloxActions.addGenre}
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
          </div>
        </>
      ) : tab === 'taxonomy' ? (
        <TaxonomyPanel taxonomy={state.taxonomy} items={state.items} catalog={state.catalog} />
      ) : (
        <GrantAccess api={grantApi ?? null} uploadTarget={state.target} uploadItems={state.items} platform={platform} />
      )}
    </div>
  );
}
