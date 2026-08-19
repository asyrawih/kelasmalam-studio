/**
 * Sisipan Beat FX terhadap jalur sinyal.
 *
 * Yang dijaga di sini adalah satu aturan yang kegagalannya tidak terlihat
 * sebagai kesalahan melainkan sebagai **hilangnya suara**: efek yang MATI tidak
 * boleh berada di jalur sinyal sama sekali.
 *
 * Versi pertamanya menyisipkan node begitu sebuah efek DIPILIH, lalu
 * mengandalkan bypass di dalam rak. `fx.kind` ikut tersimpan antar sesi, jadi
 * satu efek yang pernah dipilih terpasang lagi di setiap boot — dan kalau
 * worklet-nya gagal memproses karena alasan apa pun, yang terjadi bukan "efeknya
 * tidak terdengar" melainkan seluruh mix diam.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EffectDesc } from '../../audio/fx-catalog';
import { defaultFx, type FxState } from '../model';
import { FxInsertSlot } from './fx-insert';
import type { DjGraph } from './dj-graph';

vi.mock('../../studio/preview/fx-node', () => ({
  createFxNode: vi.fn(() => ({
    port: { postMessage: vi.fn(), onmessage: null },
    onprocessorerror: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  })),
  pushFxParams: vi.fn(),
  pushFxTempo: vi.fn(),
}));

/** Node palsu yang MENCATAT ke mana ia tersambung. */
function node(name: string) {
  return {
    name,
    out: [] as unknown[],
    connect(n: unknown) {
      this.out.push(n);
      return n;
    },
    disconnect(n?: unknown) {
      if (n === undefined) this.out.length = 0;
      else {
        const i = this.out.indexOf(n);
        if (i >= 0) this.out.splice(i, 1);
      }
    },
  };
}

const desc = {
  id: 'echo',
  name: 'ECHO',
  params: [{ id: 'mix', name: 'LEVEL', flags: 4, min: 0, max: 1, default: 0.5, taper: { kind: 'linear' } }],
} as unknown as EffectDesc;

const catalog = new Map<string, EffectDesc>([['echo', desc]]);

let graph: DjGraph;
let faderA: ReturnType<typeof node>;
let crossA: ReturnType<typeof node>;

beforeEach(() => {
  faderA = node('faderA');
  crossA = node('crossA');
  faderA.connect(crossA);
  graph = {
    ctx: {} as AudioContext,
    channels: { A: { fader: faderA, cross: crossA }, B: { fader: node('faderB'), cross: node('crossB') } },
    masterFxIn: node('masterFxIn'),
    master: node('master'),
  } as unknown as DjGraph;
});

const fx = (over: Partial<FxState> = {}): FxState => ({ ...defaultFx(), kind: 'echo', target: 'A', ...over });

describe('efek yang MATI', () => {
  it('tidak disisipkan sama sekali — kanal tetap tersambung langsung', () => {
    const slot = new FxInsertSlot();
    slot.sync(graph, fx({ on: false }), catalog, null);
    expect(faderA.out).toEqual([crossA]);
  });

  it('dilepas lagi saat dimatikan, dan jalur langsungnya PULIH', () => {
    const slot = new FxInsertSlot();
    slot.sync(graph, fx({ on: true }), catalog, null);
    expect(faderA.out).not.toEqual([crossA]);

    slot.sync(graph, fx({ on: false }), catalog, null);
    // Kalau jalur langsung tidak dipasang kembali, kanalnya senyap selamanya.
    expect(faderA.out).toEqual([crossA]);
  });
});

describe('efek yang menyala', () => {
  it('menyisip DI ANTARA fader dan crossfader, bukan menggantikan salah satunya', () => {
    const slot = new FxInsertSlot();
    slot.sync(graph, fx({ on: true }), catalog, null);
    expect(faderA.out).toHaveLength(1);
    expect(faderA.out[0]).not.toBe(crossA);
  });

  it('katalog yang belum termuat tidak menyentuh jalur sinyal', () => {
    const slot = new FxInsertSlot();
    slot.sync(graph, fx({ on: true }), null, null);
    expect(faderA.out).toEqual([crossA]);
  });
});

describe('node yang rusak', () => {
  it('dilepas dari jalur dan dilaporkan, bukan dibiarkan menahan sinyal', () => {
    const slot = new FxInsertSlot();
    const faults: string[] = [];
    slot.sync(graph, fx({ on: true }), catalog, null, (m) => faults.push(m));

    const inserted = faderA.out[0] as { port: { onmessage: ((e: MessageEvent) => void) | null } };
    inserted.port.onmessage?.({ data: { type: 'fault', message: 'wasm hilang' } } as MessageEvent);

    expect(faults[0]).toMatch(/wasm hilang/);
    expect(faderA.out).toEqual([crossA]);
  });
});
