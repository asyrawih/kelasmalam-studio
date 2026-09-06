/**
 * `GrantApi` untuk DESKTOP (docs/21 §3f, fase R5): tiap method dipetakan ke
 * satu command Tauri dari kontrak (`platform/local-commands.ts`), dan Rust
 * yang bicara ke Roblox — bukan Worker kepustakaan, bukan `fetch` dari
 * WebView. Tidak ada aturan bisnis di sini; `GrantAccess.tsx` tetap sama
 * untuk web dan desktop.
 *
 * ## Rahasia tidak pernah lewat sini
 *
 * - `saveSettings` menaruh API key ke berkas rahasia lewat `secret_set` dan cookie
 *   lewat `roblox_grant_cookie_set` — sekali jalan, ke OS.
 * - `settings()` mengembalikan `apiKey`/`robloxCookie` KOSONG dan hanya dua
 *   flag `hasApiKey`/`hasRobloxCookie`: Rust (`roblox_grant_settings_get`)
 *   memang tidak pernah mengembalikan nilainya.
 * - `grant()` menerima `apiKey` karena itu tanda tangan `GrantApi` (web
 *   mengirimnya di header), tapi TIDAK meneruskannya: `roblox_grant` membaca
 *   kunci dari berkas rahasia sendiri. Kolom kunci di tab GRANT hanya untuk
 *   mengganti kunci lewat SIMPAN.
 *
 * ## Galat
 *
 * Rust menolak dengan `LocalError`; di sini dibungkus jadi `GrantError`
 * dengan `message` apa adanya — kalimatnya sudah kalimat Worker (disalin di
 * `roblox_grant.rs`), jadi UI web dan desktop membaca hal yang sama.
 */

import type { LocalCommandName, LocalCommands } from '../../platform/local-commands';
import { localInvoke } from '../local/invoke';
import { GrantError, type GrantApi } from './api';

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  const m = (reason as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : 'perintah lokal gagal tanpa pesan';
}

async function call<K extends LocalCommandName>(
  cmd: K,
  args: LocalCommands[K]['args'],
): Promise<LocalCommands[K]['result']> {
  try {
    return await localInvoke(cmd, args);
  } catch (reason: unknown) {
    throw new GrantError(messageOf(reason));
  }
}

export function createLocalGrantApi(): GrantApi {
  return {
    async settings() {
      const saved = await call('roblox_grant_settings_get', {});
      return {
        creatorKind: saved.creatorKind,
        creatorId: saved.creatorId,
        apiKey: '',
        hasApiKey: saved.hasApiKey,
        hasRobloxCookie: saved.hasCookie,
        robloxCookie: '',
      };
    },

    async saveSettings({ creatorKind, creatorId, apiKey, robloxCookie }) {
      // `genreToDescription` bukan urusan tab ini; nilai yang tersimpan
      // dipertahankan supaya menyimpan user dari GRANT tidak diam-diam
      // mengubah opsi di panel TUJUAN.
      const current = await call('roblox_target_get', {});
      await call('roblox_target_set', {
        creatorKind,
        creatorId: creatorId.trim(),
        genreToDescription: current.genreToDescription,
      });
      // Kosong = "jangan ganti", bukan "hapus": kunci yang sudah ada di
      // berkas rahasia tetap ada (web: Worker menolak kunci kosong dengan 400).
      if (apiKey.trim() !== '') await call('secret_set', { key: 'roblox.api_key', value: apiKey.trim() });
      if ((robloxCookie ?? '').trim() !== '') {
        await call('roblox_grant_cookie_set', { cookie: (robloxCookie ?? '').trim() });
      }
    },

    async syncAssets() {
      return call('roblox_assets_sync', {});
    },

    async assets(query = '') {
      return call('roblox_assets_list', { query });
    },

    async importAssets(assets) {
      return call('roblox_assets_import', {
        assets: assets.map((asset) => ({ ...asset, source: 'import' as const })),
      });
    },

    async recordAsset(asset) {
      await call('roblox_assets_record', { asset: { ...asset, source: 'upload' as const } });
    },

    async experiences(ownerType, ownerId) {
      return call('roblox_experiences', { ownerType, ownerId });
    },

    async resolvePlace(placeId) {
      return call('roblox_resolve_place', { placeId });
    },

    async grant(assetIds, subjectType, subjectId, _apiKey) {
      // `_apiKey` sengaja tidak dipakai — lihat kepala berkas.
      return call('roblox_grant', { assetIds, subjectType, subjectId });
    },
  };
}
