export interface RobloxCatalogAsset {
  readonly assetId: string;
  readonly creatorKind: 'user' | 'group';
  readonly creatorId: string;
  readonly name: string;
  readonly moderationState: string | null;
  readonly source: string;
}

export interface RobloxExperience {
  readonly universeId: string;
  readonly placeId: string;
  readonly name: string;
}

export interface GrantApi {
  settings(): Promise<{ creatorKind: 'user' | 'group'; creatorId: string; apiKey: string; hasRobloxCookie: boolean } | null>;
  saveSettings(settings: { creatorKind: 'user' | 'group'; creatorId: string; apiKey: string; robloxCookie?: string }): Promise<void>;
  syncAssets(): Promise<number>;
  assets(query?: string): Promise<readonly RobloxCatalogAsset[]>;
  importAssets(assets: readonly Omit<RobloxCatalogAsset, 'moderationState' | 'source'>[]): Promise<number>;
  recordAsset(asset: Omit<RobloxCatalogAsset, 'source'>): Promise<void>;
  experiences(ownerType: 'user' | 'group', ownerId: string): Promise<readonly RobloxExperience[]>;
  resolvePlace(placeId: string): Promise<string>;
  grant(assetIds: readonly string[], subjectType: 'Universe' | 'Group' | 'User', subjectId: string, apiKey: string): Promise<number>;
}

export class GrantError extends Error {}

export function createGrantApi(baseUrl: string, fetchImpl: typeof fetch = fetch): GrantApi {
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetchImpl(`${base}${path}`, { credentials: 'include', ...init });
    if (!res.ok) {
      let message = `server menjawab ${res.status}`;
      try {
        const body = await res.json() as { message?: unknown };
        if (typeof body.message === 'string') message = body.message;
      } catch { /* balasan non-JSON */ }
      throw new GrantError(message);
    }
    return res;
  };
  const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  return {
    async settings() {
      const res = await call('/roblox/settings');
      return ((await res.json()) as { settings?: { creatorKind: 'user' | 'group'; creatorId: string; apiKey: string; hasRobloxCookie: boolean } | null }).settings ?? null;
    },
    async saveSettings(settings) {
      await call('/roblox/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
    },
    async syncAssets() {
      const res = await jsonPost('/roblox/assets/sync', {});
      return ((await res.json()) as { synced?: number }).synced ?? 0;
    },
    async assets(query = '') {
      const res = await call(`/roblox/assets?q=${encodeURIComponent(query)}`);
      return ((await res.json()) as { assets?: readonly RobloxCatalogAsset[] }).assets ?? [];
    },
    async importAssets(assets) {
      const res = await jsonPost('/roblox/assets', { assets: assets.map((asset) => ({ ...asset, source: 'import' })) });
      return ((await res.json()) as { imported?: number }).imported ?? 0;
    },
    async recordAsset(asset) {
      await jsonPost('/roblox/assets', { assets: [{ ...asset, source: 'upload' }] });
    },
    async experiences(ownerType, ownerId) {
      const res = await call(`/roblox/experiences?ownerType=${ownerType}&ownerId=${encodeURIComponent(ownerId)}`);
      return ((await res.json()) as { experiences?: readonly RobloxExperience[] }).experiences ?? [];
    },
    async resolvePlace(placeId) {
      const res = await call(`/roblox/resolve-place?placeId=${encodeURIComponent(placeId)}`);
      return String(((await res.json()) as { universeId?: unknown }).universeId ?? '');
    },
    async grant(assetIds, subjectType, subjectId, apiKey) {
      const res = await jsonPost('/roblox/grants', { assetIds, subjectType, subjectId }, { 'x-roblox-api-key': apiKey });
      return ((await res.json()) as { granted?: number }).granted ?? 0;
    },
  };
}
