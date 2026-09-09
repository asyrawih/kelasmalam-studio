/**
 * @vitest-environment node
 *
 * `paths` di `tsconfig.base.json` dan alias Vite/Vitest (`workspace-aliases.ts`)
 * harus meresolusi specifier yang sama ke berkas yang sama.
 *
 * Kalau keduanya berbeda, `tsc --noEmit` hijau tidak membuktikan apa pun
 * tentang bundel: tsc memeriksa satu berkas, Vite membundel berkas lain, dan
 * yang salah baru terlihat di runtime. Alias memang DITURUNKAN dari tsconfig,
 * tapi tes ini memeriksa hasil akhirnya — termasuk bahwa target yang ditunjuk
 * benar-benar ada di disk, supaya entri `paths` yang menunjuk ke folder yang
 * sudah pindah tidak lolos diam-diam.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tsconfigPaths, workspaceAliases, type WorkspaceAlias } from '../../../../workspace-aliases';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const PATHS = tsconfigPaths(ROOT);
const ALIASES = workspaceAliases(ROOT);

/** Specifier contoh untuk sebuah pola `paths` dan hasil yang diharapkan tsc. */
function sample(pattern: string, target: string): { readonly spec: string; readonly expected: string } {
  const probe = 'sub/dir/berkas';
  return {
    spec: pattern.replace('*', probe),
    expected: resolve(ROOT, target.replace('*', probe)),
  };
}

function applyAlias(spec: string): { readonly alias: WorkspaceAlias; readonly resolved: string } | null {
  for (const alias of ALIASES) {
    if (alias.find.test(spec)) return { alias, resolved: spec.replace(alias.find, alias.replacement) };
  }
  return null;
}

describe('workspace-aliases ↔ tsconfig.base.json paths', () => {
  it('ada entri paths yang diperiksa', () => {
    expect(Object.keys(PATHS).length).toBeGreaterThanOrEqual(7);
  });

  it.each(Object.entries(PATHS))('%s → alias meresolusi ke tempat yang sama', (pattern, targets) => {
    const { spec, expected } = sample(pattern, targets[0]!);
    const hit = applyAlias(spec);
    expect(hit, `tidak ada alias untuk ${spec}`).not.toBeNull();
    expect(hit!.resolved).toBe(expected);
  });

  it.each(Object.entries(PATHS))('%s menunjuk ke folder/berkas yang ada', (_pattern, targets) => {
    const base = targets[0]!.replace(/\/\*$/, '');
    expect(existsSync(resolve(ROOT, base)), `${base} tidak ada`).toBe(true);
  });

  it('tidak ada alias tanpa entri paths (dan sebaliknya, jumlahnya sama)', () => {
    expect(ALIASES.length).toBe(Object.keys(PATHS).length);
    const used = new Set<WorkspaceAlias>();
    for (const [pattern, targets] of Object.entries(PATHS)) {
      const hit = applyAlias(sample(pattern, targets[0]!).spec);
      if (hit !== null) used.add(hit.alias);
    }
    const unused = ALIASES.filter((a) => !used.has(a)).map((a) => String(a.find));
    expect(unused).toEqual([]);
  });

  it('alias tanpa /* tidak menangkap subpath (shell vs shell/keys)', () => {
    const bare = applyAlias('@kelasmalam/shell');
    const sub = applyAlias('@kelasmalam/shell/keys');
    expect(bare?.resolved).toBe(resolve(ROOT, 'packages/shell/src/index.ts'));
    expect(sub?.resolved).toBe(resolve(ROOT, 'packages/shell/src/keys'));
  });
});
