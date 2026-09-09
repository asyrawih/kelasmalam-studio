import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { ORT_DIST_ALIAS, ortDistDir } from './ort-dist';

export default defineConfig({
  plugins: [react()],
  // Sama dengan `vite.config.ts`: modul yang memakai `@ort-dist` harus bisa
  // di-import oleh tes tanpa konfigurasi berbeda dari build.
  resolve: { alias: { [ORT_DIST_ALIAS]: ortDistDir() } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
