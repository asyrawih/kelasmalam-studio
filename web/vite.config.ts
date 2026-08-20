import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { build, defineConfig, type Plugin } from 'vite';

/**
 * Header COOP/COEP — prasyarat `crossOriginIsolated === true`, yang merupakan
 * prasyarat SharedArrayBuffer (docs/01 §1d). Tanpa ini seluruh jalur SAB mati
 * dan aplikasi jatuh ke degraded mode.
 *
 * `require-corp` berarti SEMUA sub-resource lintas origin harus opt-in — jadi
 * self-host font/gambar. `credentialless` sengaja tidak dipakai (Safari belum).
 */
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * `audioWorkletPlugin()` — mem-build `worklet-processor.ts` sebagai entry
 * TERPISAH berformat IIFE dan mengembalikan URL hash-nya.
 *
 * Kenapa perlu plugin sama sekali (docs/04 §Vite config):
 *   - `audioWorklet.addModule(url)` menerima URL, bukan modul, dan memuat file
 *     itu sebagai **classic script**. Satu `import` statement saja di hasil
 *     build = SyntaxError saat addModule, dan itu terjadi di runtime, bukan
 *     saat build.
 *   - Rollup default menghasilkan ESM. `format: 'iife'` memaksa semuanya
 *     ter-inline ke satu file tanpa import — termasuk glue wasm-bindgen kalau
 *     suatu saat worklet membutuhkannya.
 *
 * Pemakaian di kode aplikasi:
 *   import workletUrl from './audio/worklet-processor.ts?worklet&url';
 */
function audioWorkletPlugin(): Plugin {
  const SUFFIX = '?worklet&url';
  const built = new Map<string, string>();

  return {
    name: 'daw-audio-worklet',
    enforce: 'pre',

    async resolveId(id, importer) {
      if (!id.endsWith(SUFFIX)) return null;
      const bare = id.slice(0, -SUFFIX.length);
      const resolved = await this.resolve(bare, importer, { skipSelf: true });
      return resolved ? `\0worklet:${resolved.id}` : null;
    },

    async load(id) {
      if (!id.startsWith('\0worklet:')) return null;
      const file = id.slice('\0worklet:'.length);

      // DEV: Vite men-serve TS apa adanya dengan transform ESM, yang tidak
      // boleh untuk classic script. Jadi di dev pun kita build sekali ke
      // memori dan meng-inline-nya sebagai blob URL — perilakunya identik
      // dengan produksi, jadi bug worklet tidak muncul hanya saat build.
      if (this.meta.watchMode || process.env.NODE_ENV !== 'production') {
        const code = built.get(file) ?? (await bundleWorklet(file));
        built.set(file, code);
        return `
const code = ${JSON.stringify(code)};
export default URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
`;
      }

      // BUILD: emit sebagai asset dengan hash; Rollup mengganti referensinya.
      const code = await bundleWorklet(file);
      const ref = this.emitFile({
        type: 'asset',
        name: 'worklet-processor.js',
        source: code,
      });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}

/** Bundle satu file worklet jadi IIFE tanpa import. */
async function bundleWorklet(entry: string): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      write: false,
      target: 'esnext',
      minify: 'esbuild',
      rollupOptions: {
        input: entry,
        output: { format: 'iife', inlineDynamicImports: true },
      },
    },
  });
  const output = Array.isArray(result) ? result[0]!.output : 'output' in result ? result.output : [];
  const chunk = output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('gagal mem-build worklet: tidak ada chunk');
  if (/\bimport\s*[({'"]/.test(chunk.code)) {
    throw new Error(
      'Hasil build worklet masih mengandung `import` — addModule() akan gagal saat runtime.',
    );
  }
  return chunk.code;
}

/**
 * Menjalankan perintah baca-saja dan mengembalikan keluarannya, atau `''` kalau
 * gagal. Build TIDAK BOLEH mati hanya karena git tidak ada — di runner yang
 * memakai tarball sumber (tanpa `.git`) itu keadaan normal, bukan galat.
 */
function tryRun(cmd: string, args: readonly string[]): string {
  try {
    const out = execFileSync(cmd, args, {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return '';
  }
}

/** Nilai pertama yang benar-benar ada isinya; `''` kalau semuanya kosong. */
function firstOf(...candidates: readonly (string | undefined)[]): string {
  for (const c of candidates) {
    if (c !== undefined && c !== '') return c;
  }
  return '';
}

/**
 * Identitas build yang ditanam ke bundel (dibaca `src/build-info.ts`).
 *
 * Urutan sumbernya bukan selera: bundel produksi repo ini DI-BUILD DI GITHUB
 * ACTIONS lalu dikirim dengan `vercel deploy --prebuilt`
 * (`.github/workflows/deploy.yml`), jadi `VERCEL_GIT_*` tidak pernah ada di
 * mesin yang membangunnya — `GITHUB_*` yang ada. `VERCEL_GIT_*` tetap
 * didahulukan supaya build yang suatu saat pindah ke Vercel tetap benar tanpa
 * perubahan di sini. Git jadi jalur terakhir, untuk build lokal.
 *
 * Checkout di CI itu detached, dan di situ `git rev-parse --abbrev-ref HEAD`
 * menjawab literal `HEAD` — nama branch yang tidak berarti apa-apa, jadi ia
 * dibuang, bukan ditampilkan.
 */
function buildInfoDefines(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const sha = firstOf(
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
    tryRun('git', ['rev-parse', 'HEAD']),
  );
  const rawBranch = firstOf(
    process.env.VERCEL_GIT_COMMIT_REF,
    process.env.GITHUB_REF_NAME,
    tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
  );
  const branch = rawBranch === 'HEAD' ? '' : rawBranch;

  return {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version ?? ''),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(sha.slice(0, 7)),
    'import.meta.env.VITE_BUILD_BRANCH': JSON.stringify(branch),
    // Waktu build, bukan waktu deploy — keduanya berjarak beberapa detik dan
    // hanya inilah yang bisa diketahui dari dalam bundel.
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  };
}

export default defineConfig({
  plugins: [audioWorkletPlugin(), react()],

  define: buildInfoDefines(),

  server: { headers: COI_HEADERS },
  preview: { headers: COI_HEADERS },

  worker: {
    // Export & import worker memakai `import()` dinamis untuk glue wasm-bindgen.
    format: 'es',
  },

  optimizeDeps: {
    // Pre-bundler esbuild akan memproses glue wasm-bindgen dan merusak
    // resolusi `new URL('...wasm', import.meta.url)` (docs/04).
    exclude: ['@daw/wasm', '@breezystack/lamejs', 'vorbis-encoder-js'],
  },

  build: {
    // esnext dibutuhkan untuk top-level await, import.meta.url, dan supaya
    // esbuild tidak men-downlevel BigInt (playhead u64 lewat BigInt64Array).
    target: 'esnext',
    // Sourcemap MATI di produksi: ia menyumbang sebagian besar dari ~17 MB
    // dist dan mengekspos seluruh source. Nyalakan lewat
    // `VITE_SOURCEMAP=1 vite build` kalau perlu menelusuri bug produksi.
    sourcemap: process.env.VITE_SOURCEMAP === '1',
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
    },
  },

  // Artefak WASM diperlakukan sebagai asset, bukan diproses.
  assetsInclude: ['**/*.wasm'],
});
