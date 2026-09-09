/// <reference types="vite/client" />

/** Variabel env yang dibaca paket ini (`api.ts`); lihat `packages/shell/src/vite-env.d.ts`. */
interface ImportMetaEnv {
  /** Basis URL soundclaude-server. Default pengembangan: http://localhost:8080. */
  readonly VITE_SOUNDCLAUDE_API?: string;
}
