/**
 * @vitest-environment node
 *
 * Graf paket `@kelasmalam/*` adalah DAG, dan `package.json` tiap paket adalah
 * gambaran JUJUR dari impornya (docs/25 P3).
 *
 * KENAPA TES. Sebelum P3, `studio → library → studio` dan
 * `platform → studio/library/proof-stem` hidup diam-diam di balik impor
 * relatif dan alias sementara — sah bagi tsc, sah bagi Vite, dan tidak
 * terlihat siapa pun. Begitu modulnya jadi paket, siklus berarti dua paket
 * yang tidak bisa dipahami (apalagi diuji, apalagi dipisah ke `studio-core`
 * di P4) satu tanpa yang lain. `dependencies` yang tidak sesuai kenyataan
 * sama buruknya: ia daftar yang dibaca orang untuk memahami graf, dan daftar
 * yang salah lebih buruk daripada tidak ada.
 *
 * Tiga hal yang dijaga:
 *   1. tidak ada siklus di graf `dependencies` `@kelasmalam/*`;
 *   2. tiap impor `@kelasmalam/x/…` di `packages/y/src` (statis, dinamis,
 *      `vi.mock`, `@import` CSS) tercermin sebagai `y → x` di `package.json`;
 *   3. sebaliknya, tidak ada dependensi `@kelasmalam/*` yang tidak dipakai.
 *
 * Impor ke paket sendiri (`@kelasmalam/y/…` dari dalam `y`) tidak dihitung
 * sebagai dependensi dan juga TIDAK dilarang di sini — tapi di dalam paket
 * tulislah relatif; alias ke diri sendiri hanya membingungkan `git mv`.
 *
 * P4 menambah satu sisi yang dijaga secara eksplisit: `dj` TIDAK bergantung
 * pada `studio` (lane) — hanya pada `studio-core`. Itulah gerbang docs/24:
 * begitu `studio-fl` lahir, DJ tidak boleh ikut terikat pada salah satunya.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const PACKAGES = join(ROOT, 'packages');
const SCOPE = '@kelasmalam/';

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'wasm' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* sources(full);
      continue;
    }
    if (/\.(ts|tsx|css)$/.test(name)) yield full;
  }
}

/** Semua specifier impor di satu berkas: `from`, `import(`, `import 'x'`, `vi.mock(`, `@import` CSS. */
function specifiers(code: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+|vi\.mock\s*\(\s*|@import\s+)['"]([^'"]+)['"]/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) out.push(m[1]!);
  return out;
}

function packageOf(spec: string): string | null {
  if (!spec.startsWith(SCOPE)) return null;
  return spec.slice(SCOPE.length).split('/')[0]!;
}

const DIRS = readdirSync(PACKAGES).filter((n) => statSync(join(PACKAGES, n)).isDirectory());

/** `dir` → manifest, dan `dir` → paket yang benar-benar diimpor sumbernya. */
const MANIFESTS = new Map<string, Manifest>();
const IMPORTS = new Map<string, Map<string, string[]>>(); // dir → (paket → berkas pemakai)
for (const dir of DIRS) {
  MANIFESTS.set(dir, JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as Manifest);
  const used = new Map<string, string[]>();
  for (const file of sources(join(PACKAGES, dir, 'src'))) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const target = packageOf(spec);
      if (target === null || target === dir) continue;
      used.set(target, [...(used.get(target) ?? []), relative(PACKAGES, file)]);
    }
  }
  IMPORTS.set(dir, used);
}

function declared(dir: string): string[] {
  return Object.keys(MANIFESTS.get(dir)!.dependencies ?? {})
    .filter((n) => n.startsWith(SCOPE))
    .map((n) => n.slice(SCOPE.length));
}

/** Satu siklus (sebagai jalur `a → b → … → a`), atau `null`. DFS tiga warna. */
function findCycle(edges: (n: string) => readonly string[], nodes: readonly string[]): string[] | null {
  const state = new Map<string, 'masuk' | 'selesai'>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 'masuk');
    stack.push(n);
    for (const next of edges(n)) {
      const s = state.get(next);
      if (s === 'masuk') return [...stack.slice(stack.indexOf(next)), next];
      if (s === undefined) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(n, 'selesai');
    return null;
  };
  for (const n of nodes) {
    if (!state.has(n)) {
      const found = visit(n);
      if (found !== null) return found;
    }
  }
  return null;
}

describe('graf paket @kelasmalam/* (docs/25 P3)', () => {
  it('ada paket yang diperiksa, dan namanya = nama foldernya', () => {
    expect(DIRS.length).toBeGreaterThanOrEqual(10);
    for (const dir of DIRS) expect(MANIFESTS.get(dir)!.name).toBe(SCOPE + dir);
  });

  it('dependencies membentuk DAG — tidak ada siklus', () => {
    const cycle = findCycle((n) => declared(n), DIRS);
    expect(cycle, cycle === null ? '' : `siklus: ${cycle.join(' → ')}`).toBeNull();
  });

  it('impor yang sebenarnya pun bebas siklus (kalau package.json bohong, ini yang menangkapnya)', () => {
    const cycle = findCycle((n) => [...(IMPORTS.get(n)?.keys() ?? [])], DIRS);
    expect(cycle, cycle === null ? '' : `siklus: ${cycle.join(' → ')}`).toBeNull();
  });

  it.each(DIRS)('%s: tiap paket yang diimpor sumbernya ada di dependencies', (dir) => {
    const missing = [...IMPORTS.get(dir)!.entries()]
      .filter(([target]) => !declared(dir).includes(target))
      .map(([target, files]) => `${SCOPE}${target} (dipakai ${files[0]}${files.length > 1 ? ` +${files.length - 1}` : ''})`);
    expect(missing).toEqual([]);
  });

  it.each(DIRS)('%s: tidak ada dependencies @kelasmalam/* yang tidak dipakai', (dir) => {
    const unused = declared(dir).filter((target) => !IMPORTS.get(dir)!.has(target));
    expect(unused).toEqual([]);
  });

  it.each(DIRS)('%s: dependencies @kelasmalam/* menunjuk paket workspace yang ada', (dir) => {
    for (const target of declared(dir)) {
      expect(DIRS, `${dir} → ${target}`).toContain(target);
      expect(MANIFESTS.get(dir)!.dependencies![SCOPE + target]).toBe('workspace:*');
    }
  });
});

describe('dj hanya bergantung pada studio-core (docs/25 P4)', () => {
  it('package.json dj tidak memuat @kelasmalam/studio, dan memuat studio-core', () => {
    expect(declared('dj')).not.toContain('studio');
    expect(declared('dj')).toContain('studio-core');
  });

  it('tidak ada satu pun impor @kelasmalam/studio/ di packages/dj/src', () => {
    const hits = [...sources(join(PACKAGES, 'dj', 'src'))]
      .filter((f) => readFileSync(f, 'utf8').includes(`${SCOPE}studio/`))
      .map((f) => relative(PACKAGES, f));
    expect(hits).toEqual([]);
  });

  it('studio-core sendiri tidak tahu lane: tidak mengimpor studio, dj, library', () => {
    for (const forbidden of ['studio', 'dj', 'library', 'soundcloud', 'roblox']) {
      expect(declared('studio-core')).not.toContain(forbidden);
      expect([...(IMPORTS.get('studio-core')?.keys() ?? [])]).not.toContain(forbidden);
    }
  });
});
