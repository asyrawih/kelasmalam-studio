/**
 * Kontrak `LibraryApi` untuk implementasi LOKAL (Tauri) — daftar janjinya
 * SATU dengan klien Worker (`apps/web/src/library/api-contract.ts`,
 * dijalankan di web untuk Worker). Sejak docs/25 P2 implementasi lokal hanya
 * ada di app ini, jadi separuh `describe.each` lama pindah ke sini; yang
 * diskrip hanya `invoke`.
 */
import { vi } from 'vitest';

import { createLocalLibraryApi } from './local-api';
import { libraryApiContract, type Backend, type Step } from '@kelasmalam/library/library/api-contract';

const invoke = vi.fn(async (_cmd: string, _args?: unknown, _opts?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown, opts?: unknown) => invoke(cmd, args, opts),
}));

function localBackend(): Backend {
  const queue: Step[] = [];
  const push = (value: unknown, kind: Step['kind'] = 'ok'): void => {
    queue.push({ kind, value });
  };
  const uploaded: number[] = [];
  let lastArgs: unknown;
  return {
    name: 'lokal (Tauri)',
    setup() {
      queue.length = 0;
      uploaded.length = 0;
      invoke.mockReset();
      invoke.mockImplementation(async (cmd, args) => {
        if (cmd === 'library_put_bytes') {
          uploaded.push((args as Uint8Array).byteLength);
          return null;
        }
        lastArgs = args;
        const step = queue.shift();
        if (step === undefined) throw new Error(`skrip backend habis di ${cmd}`);
        if (step.kind === 'fail') throw step.value;
        return step.value;
      });
    },
    teardown() {
      invoke.mockReset();
      invoke.mockResolvedValue(null);
    },
    api: () => createLocalLibraryApi(),
    given: {
      // `me()` lokal tidak bertanya ke siapa pun — tidak ada langkah yang dikonsumsi.
      user: () => {},
      tracks: (list) => push(list.map((t) => ({ ...t, createdAt: 1 }))),
      blob: (bytes) => push(bytes),
      has: (exists) => push(exists),
      ok: () => push(null),
      projects: (list) => push(list),
      project: (body) => push({ ...body, updatedAt: 1 }),
      created: (id, version) => push({ id, version }),
      updated: (version) => push(version),
      conflict: (currentVersion, message) => push({ code: 'VERSION_CONFLICT', message, currentVersion }, 'fail'),
      removed: (deletedFromLibrary) => push(deletedFromLibrary),
      error: (code, message) => push({ code, message }, 'fail'),
    },
    uploaded: () => uploaded,
    lastJsonBody: () => lastArgs,
  };
}

libraryApiContract(localBackend());
