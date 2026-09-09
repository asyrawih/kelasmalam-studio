/**
 * `RobloxBackend` DESKTOP (docs/21 §3, docs/25 §1c): apa yang dulu bercabang
 * `if (kind === 'desktop')` di `RobloxRoute`, kini satu objek yang didaftarkan
 * `main.tsx` lewat `registerRobloxBackend`.
 *
 * - `transport`: command Tauri (`roblox_upload_start` / `roblox_operation_poll`);
 *   unggah dan poll dilakukan Rust, API key dibaca dari berkas rahasia — tidak
 *   pernah lewat IPC.
 * - `grantApi`: `roblox_grant_*` / `roblox_assets_*` yang bicara ke Roblox
 *   langsung dari Rust dengan cookie di berkas rahasia (§3f, R5).
 * - `saveTarget`: creator → `roblox_target_set`; kunci → `secret_set`
 *   (docs/21 §1f), lalu kolom kunci di store DIKOSONGKAN — salinan di memori
 *   WebView tidak punya alasan hidup lebih lama daripada perjalanan ke berkas
 *   rahasia.
 * - `probe`: kesiapan = kunci ada di berkas rahasia + target dari tabel
 *   `setting`; keduanya baru terisi setelah `restoreRobloxQueue`, jadi probe
 *   menunggu itu dulu.
 * - `onApproved`: tidak ada — baris `done` di tabel SUDAH katalog (§3d).
 */

import { createDesktopTransport, hasStoredApiKey } from './desktop-transport';
import { createLocalGrantApi } from './grant-local-api';
import { localInvoke } from './invoke';
import type { RobloxBackend } from '@app-web/roblox/backend/backend'; // TODO(P3)
import { restoreRobloxQueue, robloxActions, robloxStore } from '@app-web/roblox/store'; // TODO(P3)

export function createDesktopRobloxBackend(): RobloxBackend {
  const transport = createDesktopTransport({
    creatorId: () => robloxStore.getState().target.creatorId,
    rowIdOf: (operationId) =>
      robloxStore.getState().items.find((it) => it.operationId === operationId)?.localId ?? null,
  });

  return {
    platform: 'desktop',
    transport,
    grantApi: createLocalGrantApi(),

    async saveTarget(target) {
      await localInvoke('roblox_target_set', {
        creatorKind: target.creatorKind,
        creatorId: target.creatorId.trim(),
        genreToDescription: target.genreToDescription,
      });
      if (target.apiKey.trim() !== '') {
        await localInvoke('secret_set', { key: 'roblox.api_key', value: target.apiKey.trim() });
        robloxActions.setApiKey('');
        robloxActions.setApiKeyStored(true);
      }
    },

    async probe() {
      await restoreRobloxQueue().catch(() => {});
      const stored = await hasStoredApiKey().catch(() => false);
      robloxActions.setApiKeyStored(stored);
      return transport.health();
    },
  };
}
