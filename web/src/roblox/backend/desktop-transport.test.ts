/**
 * Transport desktop dengan `invoke`/`listen` di-mock. Yang dijaga adalah
 * pemetaan ke KONTRAK: `send` → `roblox_upload_start` dengan id BARIS dan
 * progres dari event `daw://roblox-progress`; `operation` → `roblox_operation_poll`
 * dengan id baris yang dipetakan dari operationId; `health` = kunci di
 * berkas rahasia DAN creator id terisi. Tidak ada byte maupun API key yang lewat.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDesktopTransport } from './desktop-transport';
import { UploadError } from './transport';
import type { QueueItem } from '../model';

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
let progress: ((e: { payload: unknown }) => void) | null = null;
const unlisten = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, h: (e: { payload: unknown }) => void) => {
    progress = h;
    return unlisten;
  },
}));

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 1, localId: 'row-1', hash: 'a'.repeat(64), fileName: 'lagu.mp3', bytes: 3, seconds: 60, name: 'LAGU',
  description: '', status: 'queued', progress: 0, error: null, assetId: null, operationId: null,
  categoryId: 'c1', genreId: 'g1', ...over,
});
const file = new File([new Uint8Array(3)], 'lagu.mp3', { type: 'audio/mpeg' });
const target = { creatorKind: 'user' as const, creatorId: '1', apiKey: '', genreToDescription: true };

let creatorId = '123';
const rows = new Map<string, string>([['op-1', 'row-1']]);
const transport = () => createDesktopTransport({ creatorId: () => creatorId, rowIdOf: (op) => rows.get(op) ?? null });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  unlisten.mockClear();
  progress = null;
  creatorId = '123';
});

describe('upload', () => {
  it('memanggil roblox_upload_start dengan id baris — tanpa byte, tanpa kunci', async () => {
    invoke.mockResolvedValue({ operationId: 'op-1', done: false, assetId: '55', moderationState: 'reviewing' });
    const started = await transport().upload(item(), file, target, () => {});
    expect(invoke).toHaveBeenCalledWith('roblox_upload_start', { id: 'row-1' });
    expect(started).toEqual({ operationId: 'op-1', done: false, assetId: '55', moderationState: 'reviewing' });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('progres datang dari event daw://roblox-progress milik baris ini saja, dalam persen', async () => {
    const seen: number[] = [];
    invoke.mockImplementation(async () => {
      progress?.({ payload: { id: 'row-1', sent: 50, total: 200 } });
      progress?.({ payload: { id: 'row-lain', sent: 200, total: 200 } });
      progress?.({ payload: { id: 'row-1', sent: 200, total: 200 } });
      return { operationId: 'op-1', done: false, assetId: null, moderationState: null };
    });
    await transport().upload(item(), file, target, (pct) => seen.push(pct));
    expect(seen).toEqual([25, 100]);
  });

  it('LocalError Rust menjadi UploadError yang tidak retryable — Rust yang tahu apakah byte sudah sampai', async () => {
    invoke.mockRejectedValue({ code: 'HTTP', message: 'Open Cloud menjawab 429', status: 429 });
    const err = await transport().upload(item(), file, target, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err).toMatchObject({ code: 'HTTP', message: 'Open Cloud menjawab 429', retryable: false });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('baris yang belum masuk kepustakaan ditolak sebelum menyentuh Rust', async () => {
    await expect(transport().upload(item({ hash: null }), file, target, () => {})).rejects.toMatchObject({ code: 'BELUM_DI_KEPUSTAKAAN' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('operation', () => {
  it('poll memakai id BARIS yang dipetakan dari operationId; kunci diabaikan', async () => {
    invoke.mockResolvedValue({ done: true, assetId: '99', moderationState: 'approved' });
    const state = await transport().operation('op-1', 'kunci-yang-tidak-dipakai');
    expect(invoke).toHaveBeenCalledWith('roblox_operation_poll', { id: 'row-1' });
    expect(state).toEqual({ done: true, assetId: '99', moderationState: 'approved' });
  });

  it('operationId yang tidak dikenal store gagal dengan kalimat, bukan poll id kosong', async () => {
    await expect(transport().operation('op-hilang', '')).rejects.toMatchObject({ code: 'BARIS_TIDAK_DIKENALI' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('health', () => {
  it('siap hanya kalau kunci ada di berkas rahasia DAN creator id terisi', async () => {
    invoke.mockResolvedValue('kunci');
    expect(await transport().health()).toBe(true);
    expect(invoke).toHaveBeenCalledWith('secret_get', { key: 'roblox.api_key' });

    creatorId = '  ';
    expect(await transport().health()).toBe(false);

    creatorId = '1';
    invoke.mockResolvedValue(null);
    expect(await transport().health()).toBe(false);
  });

  it('berkas rahasia yang tidak bisa dibaca berarti belum siap, bukan galat', async () => {
    invoke.mockRejectedValue({ code: 'SECRET_UNAVAILABLE', message: 'berkas rahasia rusak' });
    expect(await transport().health()).toBe(false);
  });
});
