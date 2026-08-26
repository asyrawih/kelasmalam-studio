/**
 * Penggerak antrean, dengan transport palsu.
 *
 * Yang dijaga adalah janji-janji yang dilihat user di layar: satu berkas pada
 * satu waktu, progres yang sampai ke baris yang benar, moderasi yang ditunggu
 * sampai `done`, dan kegagalan yang berhenti di SATU baris alih-alih
 * menjatuhkan sisa antrean.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunner } from './runner';
import { UploadError, type OperationState, type StartedUpload, type Transport } from './transport';
import { robloxActions, robloxStore } from '../store';
import type { QueueItem } from '../model';

const mp3 = (name: string): File =>
  new File([new Uint8Array(16)], name, { type: 'audio/mpeg' });

const state = () => robloxStore.getState();
const items = (): readonly QueueItem[] => state().items;
const byName = (name: string): QueueItem => {
  const it = items().find((x) => x.fileName === name);
  if (it === undefined) throw new Error(`tidak ada baris ${name}`);
  return it;
};

/** Transport yang bisa diatur per-tes; `sleep` dibuat instan. */
function fakeTransport(over: Partial<Transport> = {}): Transport {
  return {
    health: async () => true,
    upload: async (): Promise<StartedUpload> => ({
      operationId: 'op-1',
      done: false,
      assetId: null,
    }),
    operation: async (): Promise<OperationState> => ({
      done: true,
      assetId: '111',
      moderationState: 'approved',
    }),
    ...over,
  };
}

const runnerOf = (t: Transport) =>
  createRunner(t, { firstPollMs: 0, maxPollMs: 0, uploadRetryMs: 0, sleep: async () => {} });

function seed(names: readonly string[]): void {
  robloxActions.addFiles(names.map(mp3));
  robloxActions.setCreatorId('123');
  robloxActions.setApiKey('kunci');
}

beforeEach(() => robloxActions.__resetForTest());

describe('jalur bahagia', () => {
  it('melanjutkan polling moderasi dari operationId yang dipulihkan setelah refresh', async () => {
    seed(['a.mp3']);
    const item = byName('a.mp3');
    await robloxActions.markProcessing(item.id, 'op-persisted');
    const operation = vi.fn(async (operationId: string) => ({
      done: true,
      assetId: '909',
      moderationState: 'approved' as const,
      operationId,
    }));
    const runner = runnerOf(fakeTransport({ operation }));

    runner.resume?.(items());
    await runner.idle();

    expect(operation).toHaveBeenCalledWith('op-persisted', 'kunci');
    expect(byName('a.mp3')).toMatchObject({ status: 'done', assetId: '909', operationId: null });
  });

  it('mengunggah, menunggu moderasi, lalu menyimpan asset id', async () => {
    seed(['a.mp3']);
    const runner = runnerOf(fakeTransport());

    runner.run(items());
    await runner.idle();

    expect(byName('a.mp3')).toMatchObject({ status: 'done', assetId: '111' });
  });

  it('melewati polling kalau Roblox sudah selesai saat itu juga', async () => {
    seed(['a.mp3']);
    const operation = vi.fn(async () => ({
      done: true,
      assetId: 'x',
      moderationState: 'approved' as const,
    }));
    const runner = runnerOf(
      fakeTransport({
        upload: async () => ({
          operationId: 'op-9',
          done: true,
          assetId: '999',
          moderationState: 'approved',
        }),
        operation,
      }),
    );

    runner.run(items());
    await runner.idle();

    expect(byName('a.mp3')).toMatchObject({ status: 'done', assetId: '999' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('menyimpan assetId dari response upload walau moderasi masih berjalan', async () => {
    seed(['a.mp3']);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = vi.fn(async () => {
      await gate;
      return { done: true, assetId: '555', moderationState: 'approved' as const };
    });
    const runner = runnerOf(
      fakeTransport({
        upload: async () => ({
          operationId: 'op-555',
          done: false,
          assetId: '555',
          moderationState: 'reviewing',
        }),
        operation,
      }),
    );

    runner.run(items());
    await vi.waitFor(() =>
      expect(byName('a.mp3')).toMatchObject({
        status: 'processing',
        operationId: 'op-555',
        assetId: '555',
      }),
    );
    release();
    await runner.idle();
  });

  it('progres unggah mendarat di baris yang benar', async () => {
    seed(['a.mp3', 'b.mp3']);
    const seen: number[] = [];
    const runner = runnerOf(
      fakeTransport({
        upload: async (item, _file, _target, onProgress) => {
          if (item.fileName === 'b.mp3') {
            onProgress(50);
            seen.push(byName('b.mp3').progress);
          }
          return { operationId: 'op', done: false, assetId: null };
        },
      }),
    );

    runner.run(items());
    await runner.idle();
    expect(seen).toEqual([50]);
  });

  it('mengirim paralel dengan batas maksimum 10', async () => {
    seed(Array.from({ length: 12 }, (_, i) => `${i}.mp3`));
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = runnerOf(
      fakeTransport({
        upload: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await gate;
          inFlight -= 1;
          return { operationId: 'op', done: false, assetId: null };
        },
      }),
    );

    runner.run(items());
    await vi.waitFor(() => expect(peak).toBe(10));
    expect(inFlight).toBe(10);
    release();
    await runner.idle();
    expect(peak).toBe(10);
    expect(items().every((it) => it.status === 'done')).toBe(true);
  });

  it('menunggu sampai operasi benar-benar selesai, bukan tanya sekali', async () => {
    seed(['a.mp3']);
    const answers: OperationState[] = [
      { done: false, assetId: null },
      { done: false, assetId: null },
      { done: true, assetId: '777', moderationState: 'approved' },
    ];
    const operation = vi.fn(async () =>
      answers.shift() ?? { done: true, assetId: '777', moderationState: 'approved' as const },
    );
    const runner = runnerOf(fakeTransport({ operation }));

    runner.run(items());
    await runner.idle();

    expect(operation).toHaveBeenCalledTimes(3);
    expect(byName('a.mp3')).toMatchObject({ status: 'done', assetId: '777' });
  });
});

describe('kegagalan', () => {
  it('mencoba ulang gangguan jaringan yang terjadi sebelum byte selesai terkirim', async () => {
    seed(['a.mp3']);
    const upload = vi
      .fn<Transport['upload']>()
      .mockRejectedValueOnce(new UploadError('JARINGAN_SEBELUM_TERKIRIM', 'koneksi putus', true))
      .mockResolvedValue({ operationId: 'op-2', done: false, assetId: null });
    const runner = runnerOf(fakeTransport({ upload }));

    runner.run(items());
    await runner.idle();

    expect(upload).toHaveBeenCalledTimes(2);
    expect(byName('a.mp3')).toMatchObject({ status: 'done', assetId: '111' });
  });

  it('tidak retry bila status pengiriman tidak pasti agar asset tidak duplikat', async () => {
    seed(['a.mp3']);
    const upload = vi.fn(async () => {
      throw new UploadError('JARINGAN_STATUS_TIDAK_PASTI', 'periksa Creator Hub');
    });
    const runner = runnerOf(fakeTransport({ upload }));

    runner.run(items());
    await runner.idle();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(byName('a.mp3')).toMatchObject({ status: 'failed', error: 'periksa Creator Hub' });
  });

  it('tetap MODERASI saat reviewing lalu selesai hanya setelah approved', async () => {
    seed(['a.mp3']);
    const answers: OperationState[] = [
      { done: false, assetId: '111', moderationState: 'reviewing' },
      { done: true, assetId: '111', moderationState: 'approved' },
    ];
    const operation = vi.fn(async () => answers.shift()!);
    const runner = runnerOf(fakeTransport({ operation }));

    runner.run(items());
    await runner.idle();

    expect(operation).toHaveBeenCalledTimes(2);
    expect(byName('a.mp3')).toMatchObject({ status: 'done', assetId: '111' });
  });

  it('menampilkan kegagalan kalau moderasi Roblox menolak audio', async () => {
    seed(['a.mp3']);
    const runner = runnerOf(
      fakeTransport({
        operation: async () => ({
          done: true,
          assetId: '111',
          moderationState: 'rejected',
        }),
      }),
    );

    runner.run(items());
    await runner.idle();

    expect(byName('a.mp3')).toMatchObject({ status: 'failed' });
    expect(byName('a.mp3').error).toMatch(/menolak.*moderasi/i);
  });

  it('galat satu berkas tidak menjatuhkan sisanya', async () => {
    seed(['a.mp3', 'b.mp3']);
    const runner = runnerOf(
      fakeTransport({
        upload: async (item) => {
          if (item.fileName === 'a.mp3') throw new UploadError('KUOTA', 'kuota unggah habis');
          return { operationId: 'op', done: false, assetId: null };
        },
      }),
    );

    runner.run(items());
    await runner.idle();

    expect(byName('a.mp3')).toMatchObject({ status: 'failed', error: 'kuota unggah habis' });
    expect(byName('b.mp3')).toMatchObject({ status: 'done' });
  });

  it('operasi yang selesai tanpa asset id dihitung gagal', async () => {
    seed(['a.mp3']);
    const runner = runnerOf(
      fakeTransport({ operation: async () => ({ done: true, assetId: null }) }),
    );

    runner.run(items());
    await runner.idle();
    expect(byName('a.mp3').status).toBe('failed');
  });

  it('moderasi yang kelewat lama TIDAK bilang "gagal unggah" — byte-nya sudah sampai', async () => {
    seed(['a.mp3']);
    let clock = 0;
    const runner = createRunner(
      fakeTransport({ operation: async () => ({ done: false, assetId: null }) }),
      {
        firstPollMs: 0,
        maxPollMs: 0,
        moderationTimeoutMs: 10,
        sleep: async () => {
          clock += 20;
        },
        now: () => clock,
      },
    );

    runner.run(items());
    await runner.idle();

    const row = byName('a.mp3');
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/sudah terkirim/i);
    expect(row.error).toMatch(/op-1/);
  });

  it('baris yang dihapus user saat antrean berjalan dilewati diam-diam', async () => {
    seed(['a.mp3', 'b.mp3']);
    const snapshot = items();
    const target = byName('b.mp3').id;
    robloxActions.remove(target);

    const runner = runnerOf(fakeTransport());
    runner.run(snapshot);
    await runner.idle();

    expect(items()).toHaveLength(1);
    expect(byName('a.mp3').status).toBe('done');
  });
});

describe('perlindungan pemanggilan ganda', () => {
  it('menekan UNGGAH dua kali tidak mengirim dua kali', async () => {
    seed(['a.mp3']);
    const upload = vi.fn(async () => ({ operationId: 'op', done: false, assetId: null }));
    const runner = runnerOf(fakeTransport({ upload }));

    runner.run(items());
    runner.run(items());
    await runner.idle();

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('antrean kosong tidak melakukan apa-apa', async () => {
    const upload = vi.fn();
    const runner = runnerOf(fakeTransport({ upload: upload as unknown as Transport['upload'] }));
    runner.run([]);
    await runner.idle();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('target dibaca ulang per berkas', () => {
  it('kunci yang diganti di tengah antrean berlaku untuk sisanya', async () => {
    seed(['a.mp3', 'b.mp3']);
    const keys: string[] = [];
    const runner = runnerOf(
      fakeTransport({
        upload: async (item, _file, target) => {
          keys.push(target.apiKey);
          if (item.fileName === 'a.mp3') robloxActions.setApiKey('kunci-baru');
          return { operationId: 'op', done: false, assetId: null };
        },
      }),
    );

    runner.run(items());
    await runner.idle();
    expect(keys).toEqual(['kunci', 'kunci-baru']);
  });
});
