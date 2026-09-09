/**
 * Alias Vite/Vitest untuk paket workspace — DITURUNKAN dari `paths` di
 * `tsconfig.base.json`, bukan disalin.
 *
 * Kenapa bukan `paths` saja: Vite tidak membaca `paths` tsconfig, dan Vitest
 * pun tidak. Kenapa bukan dua daftar yang "dijaga sama": itu persis jenis
 * salinan yang lolos review lalu pecah diam-diam — tsc hijau sementara bundel
 * meresolusi ke berkas lain. Jadi daftar ini dihitung dari tsconfig, dan
 * `apps/web/src/__tests__/workspace-aliases.test.ts` memastikan tiap entri
 * `paths` punya alias padanan yang meresolusi ke tempat yang sama, dan tidak
 * ada alias yang tidak punya `paths`.
 *
 * Bentuk `pola/*` diterjemahkan jadi regex `^pola/(.*)$` → `target/$1`;
 * bentuk tanpa `*` jadi regex `^pola$` supaya `@kelasmalam/shell` tidak ikut
 * menangkap `@kelasmalam/shell/keys`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface WorkspaceAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

/** `paths` dari `tsconfig.base.json`, tanpa komentar. */
export function tsconfigPaths(rootDir: string): Record<string, readonly string[]> {
  const raw = readFileSync(resolve(rootDir, 'tsconfig.base.json'), 'utf8');
  // tsconfig boleh berkomentar; JSON.parse tidak. Blok `/* */` dan baris `//`
  // dibuang — string di tsconfig ini tidak pernah memuat keduanya.
  const json = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const parsed = JSON.parse(json) as { compilerOptions?: { paths?: Record<string, readonly string[]> } };
  return parsed.compilerOptions?.paths ?? {};
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function workspaceAliases(rootDir: string): WorkspaceAlias[] {
  const out: WorkspaceAlias[] = [];
  for (const [pattern, targets] of Object.entries(tsconfigPaths(rootDir))) {
    const target = targets[0];
    if (target === undefined) throw new Error(`paths["${pattern}"] kosong di tsconfig.base.json`);
    if (pattern.endsWith('/*')) {
      if (!target.endsWith('/*')) {
        throw new Error(`paths["${pattern}"] berpola /* tapi targetnya "${target}" tidak`);
      }
      out.push({
        find: new RegExp(`^${escapeRegex(pattern.slice(0, -2))}/(.*)$`),
        replacement: `${resolve(rootDir, target.slice(0, -2))}/$1`,
      });
    } else {
      out.push({ find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolve(rootDir, target) });
    }
  }
  return out;
}
