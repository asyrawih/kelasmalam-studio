var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/http/cors.ts
var ALLOWED_HEADERS = "content-type,x-roblox-api-key,if-match";
function parseOrigins(raw) {
  return (raw ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => s !== "");
}
__name(parseOrigins, "parseOrigins");
function decideCors(origin, allowed) {
  if (origin === null) return { allowOrigin: null, rejected: false };
  if (allowed.includes("*")) return { allowOrigin: origin, rejected: false };
  const clean = origin.replace(/\/+$/, "");
  return allowed.includes(clean) ? { allowOrigin: origin, rejected: false } : { allowOrigin: null, rejected: true };
}
__name(decideCors, "decideCors");
function withCors(res, allowOrigin, extras = {}) {
  const out = new Response(res.body, res);
  out.headers.set("vary", "origin");
  if (allowOrigin !== null) {
    out.headers.set("access-control-allow-origin", allowOrigin);
    out.headers.set("access-control-expose-headers", "content-type,etag");
    if (extras.credentials === true) out.headers.set("access-control-allow-credentials", "true");
  }
  return out;
}
__name(withCors, "withCors");
function preflight(allowOrigin, extras = {}) {
  const headers = new Headers({
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": "86400",
    vary: "origin"
  });
  if (allowOrigin !== null) {
    headers.set("access-control-allow-origin", allowOrigin);
    if (extras.credentials === true) headers.set("access-control-allow-credentials", "true");
  }
  return new Response(null, { status: 204, headers });
}
__name(preflight, "preflight");

// src/library/session.ts
var SESSION_COOKIE = "__Host-lib_session";
var OAUTH_COOKIE = "__Host-lib_oauth";
function readCookie(header, name) {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
__name(readCookie, "readCookie");
function buildCookie(name, value, opts) {
  const path = opts.path ?? "/";
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}
__name(buildCookie, "buildCookie");
function clearCookie(name, path = "/") {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
__name(clearCookie, "clearCookie");
function newToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
__name(newToken, "newToken");
async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashToken, "hashToken");
function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(base64url, "base64url");

// src/library/oauth.ts
var AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
var TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
async function newPkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
__name(newPkce, "newPkce");
function authorizeUrl(input) {
  const q = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    // Tidak ada `access_type=offline`: kami tidak pernah memanggil API Google
    // atas nama user setelah login, jadi refresh token adalah rahasia yang
    // tidak dibutuhkan siapa pun di sini.
    prompt: "select_account"
  });
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}
__name(authorizeUrl, "authorizeUrl");
async function exchangeCode(input, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
        code_verifier: input.verifier
      }).toString(),
      signal: AbortSignal.timeout(15e3)
    });
  } catch (err) {
    return { ok: false, message: `tidak bisa menghubungi Google: ${String(err)}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, message: `Google menolak penukaran code: ${text.slice(0, 200)}` };
  let idToken;
  try {
    idToken = JSON.parse(text).id_token;
  } catch {
    return { ok: false, message: "balasan Google bukan JSON" };
  }
  if (typeof idToken !== "string") return { ok: false, message: "Google tidak mengirim id_token" };
  const claims = decodeJwtPayload(idToken);
  if (claims === null) return { ok: false, message: "id_token tidak bisa dibaca" };
  if (claims.aud !== input.clientId) {
    return { ok: false, message: "id_token ini bukan untuk aplikasi ini" };
  }
  if (typeof claims.sub !== "string" || claims.sub === "") {
    return { ok: false, message: "id_token tanpa `sub`" };
  }
  return {
    ok: true,
    profile: {
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : "",
      // Google tidak selalu mengirim `name` (akun tanpa profil publik). Email
      // adalah cadangan yang jauh lebih berguna daripada string kosong di
      // topbar.
      name: typeof claims.name === "string" && claims.name !== "" ? claims.name : typeof claims.email === "string" ? claims.email : "Tanpa nama"
    }
  };
}
__name(exchangeCode, "exchangeCode");
function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === void 0) return null;
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json2 = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(json2, (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
__name(decodeJwtPayload, "decodeJwtPayload");

// src/library/presign.ts
var ALGORITHM = "AWS4-HMAC-SHA256";
var REGION = "auto";
var SERVICE = "s3";
var UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
function uriEncode(value, encodeSlash = true) {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}
__name(uriEncode, "uriEncode");
function amzDates(now) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}
__name(amzDates, "amzDates");
async function presignPut(input) {
  const { amzDate, dateStamp } = amzDates(input.now);
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const canonicalUri = `/${uriEncode(input.bucket)}/${uriEncode(input.key, false)}`;
  const params = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"]
  ];
  const canonicalQuery = params.map(([k, v]) => [uriEncode(k), uriEncode(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    `host:${host}
`,
    "host",
    UNSIGNED_PAYLOAD
  ].join("\n");
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    hex(await sha256(canonicalRequest))
  ].join("\n");
  const signingKey = await deriveSigningKey(input.secretAccessKey, dateStamp);
  const signature = hex(await hmac(signingKey, stringToSign));
  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    canonicalRequest,
    stringToSign
  };
}
__name(presignPut, "presignPut");
async function deriveSigningKey(secretAccessKey, dateStamp) {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  return await hmac(kService, "aws4_request");
}
__name(deriveSigningKey, "deriveSigningKey");
async function sha256(data) {
  return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
}
__name(sha256, "sha256");
async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}
__name(hmac, "hmac");
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hex, "hex");

// src/library/store.ts
var Store = class {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }
  db;
  now;
  static {
    __name(this, "Store");
  }
  // ── User & sesi ───────────────────────────────────────────────────────────
  /**
   * Cari user berdasarkan `sub` Google, buat kalau belum ada.
   *
   * `sub` yang jadi kunci, BUKAN email: email Google bisa berganti, dan user
   * yang berganti alamat kemudian akan mendapati kepustakaannya kosong.
   * Email tetap disimpan, tapi hanya untuk ditampilkan.
   */
  async upsertUser(profile) {
    const found = await this.db.prepare("SELECT id, google_sub, email, name FROM user WHERE google_sub = ?").bind(profile.sub).first();
    if (found !== null) {
      await this.db.prepare("UPDATE user SET email = ?, name = ? WHERE id = ?").bind(profile.email, profile.name, found.id).run();
      return { ...found, email: profile.email, name: profile.name };
    }
    const id = crypto.randomUUID();
    await this.db.prepare("INSERT INTO user (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, profile.sub, profile.email, profile.name, this.now()).run();
    return { id, google_sub: profile.sub, email: profile.email, name: profile.name };
  }
  async createSession(tokenHash, userId, ttlMs) {
    const t = this.now();
    await this.db.prepare(
      "INSERT INTO session (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).bind(tokenHash, userId, t, t + ttlMs).run();
  }
  /** User pemilik sesi, atau `null` kalau tidak ada / sudah kedaluwarsa. */
  async userForSession(tokenHash) {
    return await this.db.prepare(
      `SELECT u.id, u.google_sub, u.email, u.name
           FROM session s JOIN user u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?`
    ).bind(tokenHash, this.now()).first();
  }
  async revokeSession(tokenHash) {
    await this.db.prepare("DELETE FROM session WHERE token_hash = ?").bind(tokenHash).run();
  }
  // ── Roblox asset catalog & grant history ─────────────────────────────────
  async putRobloxAsset(userId, asset) {
    await this.db.prepare(
      `INSERT INTO roblox_asset
          (user_id, asset_id, creator_kind, creator_id, name, moderation_state, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, asset_id) DO UPDATE SET
           creator_kind = excluded.creator_kind,
           creator_id = excluded.creator_id,
           name = excluded.name,
           moderation_state = COALESCE(excluded.moderation_state, roblox_asset.moderation_state),
           source = excluded.source,
           updated_at = excluded.updated_at`
    ).bind(
      userId,
      asset.assetId,
      asset.creatorKind,
      asset.creatorId,
      asset.name,
      asset.moderationState ?? null,
      asset.source,
      asset.createdAt ?? null,
      this.now()
    ).run();
  }
  async listRobloxAssets(userId, query) {
    const like = `%${query.replace(/[%_]/g, "\\$&")}%`;
    const { results } = await this.db.prepare(
      `SELECT asset_id, creator_kind, creator_id, name, moderation_state, source, created_at, updated_at
           FROM roblox_asset
          WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR asset_id LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC LIMIT 500`
    ).bind(userId, like, like).all();
    return results;
  }
  async recordRobloxGrant(userId, assetId, subjectType, subjectId, status, error) {
    await this.db.prepare(
      `INSERT INTO roblox_grant
          (id, user_id, asset_id, subject_type, subject_id, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), userId, assetId, subjectType, subjectId, status, error, this.now()).run();
  }
  async getRobloxCredential(userId) {
    return this.db.prepare(
      "SELECT creator_kind, creator_id, api_key_cipher, roblox_cookie_cipher FROM roblox_credential WHERE user_id = ?"
    ).bind(userId).first();
  }
  async putRobloxCookie(userId, cipher) {
    await this.db.prepare(
      "UPDATE roblox_credential SET roblox_cookie_cipher = ?, updated_at = ? WHERE user_id = ?"
    ).bind(cipher, this.now(), userId).run();
  }
  async putRobloxCredential(userId, creatorKind, creatorId, apiKeyCipher) {
    await this.db.prepare(
      `INSERT INTO roblox_credential (user_id, creator_kind, creator_id, api_key_cipher, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET creator_kind = excluded.creator_kind,
         creator_id = excluded.creator_id, api_key_cipher = excluded.api_key_cipher,
         updated_at = excluded.updated_at`
    ).bind(userId, creatorKind, creatorId, apiKeyCipher, this.now()).run();
  }
  // ── Tracks ────────────────────────────────────────────────────────────────
  async listTracks(userId) {
    const { results } = await this.db.prepare(
      `SELECT t.hash, t.name, t.bytes, t.mime, t.frames, t.sample_rate, t.created_at,
                m.json AS marks
           FROM track t
           LEFT JOIN marks m ON m.hash = t.hash AND m.user_id = t.user_id
          WHERE t.user_id = ?
          ORDER BY t.created_at DESC`
    ).bind(userId).all();
    return results;
  }
  async hasClaim(userId, hash) {
    const row = await this.db.prepare("SELECT 1 AS ok FROM track WHERE user_id = ? AND hash = ?").bind(userId, hash).first();
    return row !== null;
  }
  /**
   * Catat klaim. Idempoten: commit yang diulang (jaringan putus di antara PUT
   * dan commit) tidak boleh gagal, dan tidak boleh menggandakan barisnya.
   */
  async claimTrack(userId, t) {
    await this.db.prepare(
      `INSERT INTO track (hash, user_id, name, bytes, mime, frames, sample_rate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hash, user_id) DO UPDATE SET name = excluded.name`
    ).bind(t.hash, userId, t.name, t.bytes, t.mime, t.frames, t.sampleRate, this.now()).run();
  }
  /** Total byte yang diklaim user — dasar penegakan kuota di `/tracks/init`. */
  async bytesUsed(userId) {
    const row = await this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM track WHERE user_id = ?").bind(userId).first();
    return row?.total ?? 0;
  }
  async putMarks(userId, hash, json2) {
    await this.db.prepare(
      `INSERT INTO marks (hash, user_id, json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (hash, user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
    ).bind(hash, userId, json2, this.now()).run();
  }
  /**
   * Lepas klaim user ini. Objek R2-nya TIDAK disentuh (§8d): ia bisa dipakai
   * user lain, dan pembersih yatim yang menghitungnya dengan benar belum ada.
   * Membayar penyimpanan lebih murah daripada menghapus milik orang.
   */
  async releaseTrack(userId, hash) {
    await this.db.prepare("DELETE FROM marks WHERE user_id = ? AND hash = ?").bind(userId, hash).run();
    const res = await this.db.prepare("DELETE FROM track WHERE user_id = ? AND hash = ?").bind(userId, hash).run();
    return res.meta.changes > 0;
  }
  // ── Projects ──────────────────────────────────────────────────────────────
  async listProjects(userId) {
    const { results } = await this.db.prepare(
      `SELECT id, name, updated_at, version FROM project
          WHERE user_id = ? ORDER BY updated_at DESC`
    ).bind(userId).all();
    return results;
  }
  async getProject(userId, id) {
    return await this.db.prepare("SELECT id, name, json, version FROM project WHERE user_id = ? AND id = ?").bind(userId, id).first();
  }
  async createProject(userId, name, json2) {
    const id = crypto.randomUUID();
    await this.db.prepare(
      `INSERT INTO project (id, user_id, name, json, updated_at, version, tracks_indexed)
         VALUES (?, ?, ?, ?, ?, 1, 1)`
    ).bind(id, userId, name, json2, this.now()).run();
    return { id, version: 1 };
  }
  /** Ganti seluruh daftar lagu satu project. Dipanggil tiap kali ia disimpan. */
  async replaceProjectTracks(projectId, userId, hashes) {
    await this.db.prepare("DELETE FROM project_track WHERE project_id = ?").bind(projectId).run();
    for (const hash of hashes) {
      await this.db.prepare(
        "INSERT OR IGNORE INTO project_track (project_id, user_id, hash) VALUES (?, ?, ?)"
      ).bind(projectId, userId, hash).run();
    }
  }
  /** Tambahkan lagu ke folder project tanpa mengubah isi timeline project. */
  async addProjectTrack(userId, projectId, hash) {
    await this.db.prepare(
      "INSERT OR IGNORE INTO project_track (project_id, user_id, hash) VALUES (?, ?, ?)"
    ).bind(projectId, userId, hash).run();
  }
  /** Lepaskan lagu dari folder project, bukan dari kepustakaan user. */
  async removeProjectTrack(userId, projectId, hash) {
    const res = await this.db.prepare("DELETE FROM project_track WHERE project_id = ? AND user_id = ? AND hash = ?").bind(projectId, userId, hash).run();
    return res.meta.changes > 0;
  }
  async listProjectTracks(userId, projectId) {
    const { results } = await this.db.prepare("SELECT hash FROM project_track WHERE project_id = ? AND user_id = ? ORDER BY rowid").bind(projectId, userId).all();
    return results.map((row) => row.hash);
  }
  /** Project milik user ini yang belum punya baris `project_track`. */
  async unindexedProjects(userId) {
    const { results } = await this.db.prepare("SELECT id, json FROM project WHERE user_id = ? AND tracks_indexed = 0").bind(userId).all();
    return results;
  }
  async markIndexed(projectId) {
    await this.db.prepare("UPDATE project SET tracks_indexed = 1 WHERE id = ?").bind(projectId).run();
  }
  /**
   * Simpan kalau versinya masih yang diharapkan.
   *
   * Perbandingan versi ada DI DALAM `WHERE`, bukan sebagai SELECT lalu UPDATE:
   * dua tab yang menyimpan bersamaan akan sama-sama lolos pemeriksaan terpisah
   * dan yang belakangan menimpa yang duluan tanpa jejak. Di sini yang kalah
   * mendapat `changes = 0`, dan itu jawaban yang bisa diberitahukan ke user
   * (§8c) alih-alih tulisan yang hilang diam-diam.
   */
  async updateProject(userId, id, name, json2, expectedVersion) {
    const next = expectedVersion + 1;
    const res = await this.db.prepare(
      `UPDATE project SET name = ?, json = ?, updated_at = ?, version = ?, tracks_indexed = 1
          WHERE id = ? AND user_id = ? AND version = ?`
    ).bind(name, json2, this.now(), next, id, userId, expectedVersion).run();
    if (res.meta.changes > 0) return { ok: true, version: next };
    const row = await this.db.prepare("SELECT version FROM project WHERE id = ? AND user_id = ?").bind(id, userId).first();
    return { ok: false, current: row?.version ?? null };
  }
  async deleteProject(userId, id) {
    await this.db.prepare("DELETE FROM project_track WHERE project_id = ?").bind(id).run();
    const res = await this.db.prepare("DELETE FROM project WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return res.meta.changes > 0;
  }
  /**
   * Project milik user ini yang memakai hash tertentu.
   *
   * Dulu `json LIKE '%hash%'`. Itu bekerja sampai project mulai besar, lalu D1
   * menolak dengan `LIKE or GLOB pattern too complex` — dan yang terlihat user
   * adalah lagu yang tidak bisa dihapus, tanpa satu pun petunjuk soal SQL.
   * Polanya sendiri cuma 66 karakter; yang membuatnya jatuh adalah ukuran TEKS
   * yang dipindai, dan itu tumbuh mengikuti isi project.
   *
   * Sekarang lewat `project_track`, yang punya indeks untuk persis pertanyaan
   * ini — lebih murah bahkan sebelum batas itu tersentuh.
   */
  async projectsReferencing(userId, hash) {
    const { results } = await this.db.prepare(
      `SELECT p.id, p.name FROM project_track t
           JOIN project p ON p.id = t.project_id
          WHERE t.user_id = ? AND t.hash = ?`
    ).bind(userId, hash).all();
    return results;
  }
};

// src/library/worker.ts
var HASH_RE = /^[0-9a-f]{64}$/;
var MIME_ALLOW = /* @__PURE__ */ new Set(["audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav", "audio/flac"]);
var DEFAULT_MAX_TRACK_BYTES = 100 * 1024 * 1024;
var DEFAULT_SESSION_TTL_DAYS = 30;
var UPLOAD_URL_TTL_SECONDS = 15 * 60;
var MAX_MARKS_BYTES = 256 * 1024;
var MAX_PROJECT_BYTES = 8 * 1024 * 1024;
async function credentialKey(secret) {
  if ((secret ?? "").length < 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY belum dipasang atau terlalu pendek");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
__name(credentialKey, "credentialKey");
async function encryptCredential(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await credentialKey(secret),
    new TextEncoder().encode(value)
  ));
  return btoa(String.fromCharCode(...iv, ...cipher));
}
__name(encryptCredential, "encryptCredential");
async function decryptCredential(value, secret) {
  const packed = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, 12) },
    await credentialKey(secret),
    packed.slice(12)
  );
  return new TextDecoder().decode(plain);
}
__name(decryptCredential, "decryptCredential");
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
  });
}
__name(json, "json");
var fail = /* @__PURE__ */ __name((status, code, message) => json({ code, message }, status), "fail");
var num = /* @__PURE__ */ __name((raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}, "num");
async function handleRequest(request, env, deps = {}) {
  const configured = parseOrigins(env.ALLOWED_ORIGINS);
  const allowed = configured.length > 0 ? configured : parseOrigins(env.APP_ORIGIN);
  const cors = decideCors(request.headers.get("origin"), allowed);
  if (request.method === "OPTIONS") return preflight(cors.allowOrigin, { credentials: true });
  if (cors.rejected) return fail(403, "ORIGIN_DITOLAK", "origin ini tidak diizinkan");
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const res = await safeRoute(request, env, deps, url, path);
  return withCors(res, cors.allowOrigin, { credentials: true });
}
__name(handleRequest, "handleRequest");
async function safeRoute(request, env, deps, url, path) {
  try {
    return await route(request, env, deps, url, path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${request.method} ${path}]`, message);
    return fail(500, "GALAT_INTERNAL", message);
  }
}
__name(safeRoute, "safeRoute");
async function route(request, env, deps, url, path) {
  const store = new Store(env.DB);
  const method = request.method;
  if (path === "/health" || path === "/") {
    return json({ ok: true, service: "dawonweb-library", bindings: missingBindings(env).length === 0 });
  }
  const missing = missingBindings(env);
  if (missing.length > 0) {
    return fail(
      500,
      "BINDING_HILANG",
      `binding ${missing.join(" dan ")} tidak terpasang \u2014 periksa nama binding di wrangler.library.toml`
    );
  }
  if (path === "/auth/google") {
    if (method !== "GET") return fail(405, "METODE", "pakai GET");
    const { verifier, challenge } = await newPkce();
    const state = newToken();
    const back = safePath(url.searchParams.get("next"));
    return new Response(null, {
      status: 302,
      headers: {
        location: authorizeUrl({
          clientId: env.GOOGLE_CLIENT_ID,
          redirectUri: `${env.API_ORIGIN}/auth/callback`,
          state,
          challenge
        }),
        "set-cookie": buildCookie(OAUTH_COOKIE, `${state}.${verifier}.${btoa(back)}`, {
          maxAgeSeconds: 600
        })
      }
    });
  }
  if (path === "/auth/callback") {
    if (method !== "GET") return fail(405, "METODE", "pakai GET");
    const cookie = readCookie(request.headers.get("cookie"), OAUTH_COOKIE);
    if (cookie === null) return fail(400, "STATE_HILANG", "alur login kedaluwarsa \u2014 ulangi");
    const [state, verifier, backB64] = cookie.split(".");
    if (state === void 0 || verifier === void 0) {
      return fail(400, "STATE_RUSAK", "alur login tidak bisa dilanjutkan \u2014 ulangi");
    }
    if (url.searchParams.get("state") !== state) {
      return fail(400, "STATE_TIDAK_COCOK", "state tidak cocok \u2014 permintaan ditolak");
    }
    const code = url.searchParams.get("code");
    if (code === null) {
      const err = url.searchParams.get("error") ?? "tanpa alasan";
      return fail(400, "DIBATALKAN", `Google tidak memberi code (${err})`);
    }
    const exchanged = await exchangeCode(
      {
        code,
        verifier,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: `${env.API_ORIGIN}/auth/callback`
      },
      deps.fetchImpl ?? globalThis.fetch
    );
    if (!exchanged.ok) return fail(401, "LOGIN_GAGAL", exchanged.message);
    const user2 = await store.upsertUser(exchanged.profile);
    const token = newToken();
    const ttlMs = num(env.SESSION_TTL_DAYS, DEFAULT_SESSION_TTL_DAYS) * 864e5;
    await store.createSession(await hashToken(token), user2.id, ttlMs);
    const back = backB64 === void 0 ? "/" : safePath(safeAtob(backB64));
    const headers = new Headers({ location: `${env.APP_ORIGIN}${back}` });
    headers.append("set-cookie", buildCookie(SESSION_COOKIE, token, { maxAgeSeconds: ttlMs / 1e3 }));
    headers.append("set-cookie", clearCookie(OAUTH_COOKIE));
    return new Response(null, { status: 302, headers });
  }
  if (path === "/auth/logout") {
    if (method !== "POST") return fail(405, "METODE", "pakai POST");
    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (token !== null) await store.revokeSession(await hashToken(token));
    return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
  }
  const user = await currentUser(request, store);
  if (path === "/me") {
    if (method !== "GET") return fail(405, "METODE", "pakai GET");
    return user === null ? fail(401, "BELUM_LOGIN", "belum login") : json({ id: user.id, email: user.email, name: user.name });
  }
  if (user === null) return fail(401, "BELUM_LOGIN", "belum login");
  if (path === "/roblox/settings") {
    if (method === "GET") {
      const saved = await store.getRobloxCredential(user.id);
      if (saved === null) return json({ settings: null });
      return json({ settings: {
        creatorKind: saved.creator_kind,
        creatorId: saved.creator_id,
        apiKey: await decryptCredential(saved.api_key_cipher, env.CREDENTIAL_ENCRYPTION_KEY),
        hasRobloxCookie: saved.roblox_cookie_cipher !== null
      } });
    }
    if (method === "PUT") {
      const body = await readJson(request);
      const creatorKind = body?.creatorKind === "group" ? "group" : "user";
      const creatorId = String(body?.creatorId ?? "").trim();
      const apiKey = String(body?.apiKey ?? "").trim();
      const robloxCookie = String(body?.robloxCookie ?? "").trim();
      if (!/^\d+$/.test(creatorId)) return fail(400, "PEMILIK", "Creator ID harus angka");
      if (apiKey.length < 10) return fail(400, "KUNCI", "API key Roblox tidak sah");
      const cipher = await encryptCredential(apiKey, env.CREDENTIAL_ENCRYPTION_KEY);
      await store.putRobloxCredential(user.id, creatorKind, creatorId, cipher);
      if (robloxCookie !== "") {
        await store.putRobloxCookie(user.id, await encryptCredential(robloxCookie, env.CREDENTIAL_ENCRYPTION_KEY));
      }
      return json({ ok: true });
    }
    return fail(405, "METODE", "pakai GET atau PUT");
  }
  if (path === "/roblox/assets/sync") {
    if (method !== "POST") return fail(405, "METODE", "pakai POST");
    const saved = await store.getRobloxCredential(user.id);
    if (saved?.roblox_cookie_cipher == null) {
      return fail(409, "COOKIE_HILANG", "Simpan cookie .ROBLOSECURITY untuk mengambil asset lama");
    }
    const cookie = await decryptCredential(saved.roblox_cookie_cipher, env.CREDENTIAL_ENCRYPTION_KEY);
    const fetchRoblox = deps.fetchImpl ?? fetch;
    const auth = await fetchRoblox("https://users.roblox.com/v1/users/authenticated", {
      headers: { cookie: `.ROBLOSECURITY=${cookie}` },
      signal: AbortSignal.timeout(15e3)
    });
    if (!auth.ok) return fail(401, "COOKIE_TIDAK_VALID", "Cookie Roblox tidak valid atau kedaluwarsa");
    const profile = await auth.json();
    if (saved.creator_kind === "user" && String(profile.id ?? "") !== saved.creator_id) {
      return fail(409, "USER_BEDA", `Cookie Roblox bukan milik User ID ${saved.creator_id}`);
    }
    let cursor = "";
    let synced = 0;
    for (let page = 0; page < 100; page += 1) {
      const params = new URLSearchParams({ assetType: "Audio", isArchived: "false", limit: "50" });
      if (cursor !== "") params.set("cursor", cursor);
      if (saved.creator_kind === "group") params.set("groupId", saved.creator_id);
      const upstream = await fetchRoblox(
        `https://itemconfiguration.roblox.com/v1/creations/get-assets?${params}`,
        { headers: { cookie: `.ROBLOSECURITY=${cookie}` }, signal: AbortSignal.timeout(3e4) }
      );
      if (!upstream.ok) return fail(502, "SYNC_GAGAL", `Roblox gagal mengambil audio (HTTP ${upstream.status})`);
      const body = await upstream.json();
      for (const raw of body.data ?? []) {
        const assetId = String(raw.assetId ?? raw.id ?? raw.targetId ?? "");
        if (!/^\d+$/.test(assetId)) continue;
        const created = Date.parse(String(raw.created ?? raw.createdUtc ?? ""));
        await store.putRobloxAsset(user.id, {
          assetId,
          creatorKind: saved.creator_kind,
          creatorId: saved.creator_id,
          name: String(raw.name ?? `Asset ${assetId}`).slice(0, 200),
          source: "import",
          createdAt: Number.isFinite(created) ? created : null
        });
        synced += 1;
      }
      cursor = typeof body.nextPageCursor === "string" ? body.nextPageCursor : "";
      if (cursor === "") break;
    }
    return json({ ok: true, synced });
  }
  if (path === "/roblox/assets") {
    if (method === "GET") {
      const rows = await store.listRobloxAssets(user.id, url.searchParams.get("q") ?? "");
      return json({
        assets: rows.map((row) => ({
          assetId: row.asset_id,
          creatorKind: row.creator_kind,
          creatorId: row.creator_id,
          name: row.name,
          moderationState: row.moderation_state,
          source: row.source,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      });
    }
    if (method === "POST") {
      const body = await readJson(request);
      if (body === null || !Array.isArray(body.assets)) {
        return fail(400, "ASSET", "field assets wajib berupa daftar");
      }
      if (body.assets.length > 1e3) return fail(413, "TERLALU_BANYAK", "maksimum 1000 asset sekali import");
      let imported = 0;
      for (const raw of body.assets) {
        if (typeof raw !== "object" || raw === null) continue;
        const item = raw;
        const assetId = String(item.assetId ?? "").trim();
        const creatorId = String(item.creatorId ?? "").trim();
        const creatorKind = item.creatorKind === "group" ? "group" : "user";
        if (!/^\d+$/.test(assetId) || !/^\d+$/.test(creatorId)) continue;
        await store.putRobloxAsset(user.id, {
          assetId,
          creatorKind,
          creatorId,
          name: String(item.name ?? `Asset ${assetId}`).slice(0, 200),
          moderationState: typeof item.moderationState === "string" ? item.moderationState : null,
          source: item.source === "upload" ? "upload" : "import",
          createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : null
        });
        imported += 1;
      }
      return json({ ok: true, imported });
    }
    return fail(405, "METODE", "pakai GET atau POST");
  }
  if (path === "/roblox/experiences") {
    if (method !== "GET") return fail(405, "METODE", "pakai GET");
    const ownerId = (url.searchParams.get("ownerId") ?? "").trim();
    const ownerType = url.searchParams.get("ownerType") === "group" ? "group" : "user";
    if (!/^\d+$/.test(ownerId)) return fail(400, "PEMILIK", "ownerId harus angka");
    const endpoint = ownerType === "group" ? `https://games.roblox.com/v2/groups/${ownerId}/gamesV2?accessFilter=2&limit=50&sortOrder=Desc` : `https://games.roblox.com/v2/users/${ownerId}/games?accessFilter=2&limit=50&sortOrder=Desc`;
    const upstream = await (deps.fetchImpl ?? fetch)(endpoint, { signal: AbortSignal.timeout(15e3) });
    if (!upstream.ok) return fail(502, "ROBLOX", `Roblox gagal mengambil experience (HTTP ${upstream.status})`);
    const body = await upstream.json();
    return json({
      experiences: (body.data ?? []).map((game) => {
        const root = typeof game.rootPlace === "object" && game.rootPlace !== null ? game.rootPlace : {};
        return {
          universeId: String(game.id ?? game.universeId ?? ""),
          placeId: String(root.id ?? game.rootPlaceId ?? ""),
          name: String(game.name ?? "Tanpa nama")
        };
      }).filter((game) => /^\d+$/.test(game.universeId))
    });
  }
  if (path === "/roblox/resolve-place") {
    if (method !== "GET") return fail(405, "METODE", "pakai GET");
    const placeId = (url.searchParams.get("placeId") ?? "").trim();
    if (!/^\d+$/.test(placeId)) return fail(400, "PLACE", "Place ID harus angka");
    const upstream = await (deps.fetchImpl ?? fetch)(
      `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
      { signal: AbortSignal.timeout(15e3) }
    );
    if (!upstream.ok) return fail(502, "ROBLOX", `Roblox gagal mencari Universe ID (HTTP ${upstream.status})`);
    const body = await upstream.json();
    const universeId = String(body.universeId ?? "");
    if (!/^\d+$/.test(universeId)) return fail(404, "TIDAK_ADA", "Universe ID tidak ditemukan");
    return json({ placeId, universeId });
  }
  if (path === "/roblox/grants") {
    if (method !== "POST") return fail(405, "METODE", "pakai POST");
    const apiKey = request.headers.get("x-roblox-api-key")?.trim() ?? "";
    if (apiKey === "") return fail(401, "KUNCI_HILANG", "API key Roblox wajib diisi");
    const body = await readJson(request);
    const assetIds = Array.isArray(body?.assetIds) ? [...new Set(body.assetIds.map(String).filter((id) => /^\d+$/.test(id)))] : [];
    const subjectType = ["Universe", "Group", "User"].includes(String(body?.subjectType)) ? String(body?.subjectType) : "";
    const subjectId = String(body?.subjectId ?? "").trim();
    if (assetIds.length === 0 || assetIds.length > 100) return fail(400, "ASSET", "pilih 1 sampai 100 asset");
    if (subjectType === "" || !/^\d+$/.test(subjectId)) return fail(400, "TARGET", "target grant tidak sah");
    const upstream = await (deps.fetchImpl ?? fetch)(
      "https://apis.roblox.com/asset-permissions-api/v1/assets/permissions",
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          subjectType,
          subjectId,
          action: "Use",
          requests: assetIds.map((assetId) => ({ assetId }))
        }),
        signal: AbortSignal.timeout(3e4)
      }
    );
    const text = await upstream.text();
    if (!upstream.ok) {
      for (const assetId of assetIds) {
        await store.recordRobloxGrant(user.id, assetId, subjectType, subjectId, "failed", text.slice(0, 500));
      }
      return fail(upstream.status === 403 ? 403 : 502, "GRANT_GAGAL", text.slice(0, 500) || `Roblox menjawab ${upstream.status}`);
    }
    for (const assetId of assetIds) {
      await store.recordRobloxGrant(user.id, assetId, subjectType, subjectId, "granted", null);
    }
    return json({ ok: true, granted: assetIds.length });
  }
  if (path === "/tracks") {
    if (method !== "GET") return fail(405, "METODE", "pakai GET");
    const rows = await store.listTracks(user.id);
    return json({
      tracks: rows.map((t) => ({
        hash: t.hash,
        name: t.name,
        bytes: t.bytes,
        mime: t.mime,
        frames: t.frames,
        sampleRate: t.sample_rate,
        // Marks dikirim SUDAH terurai, bukan sebagai string JSON di dalam JSON.
        // Pemanggil yang harus mem-parse dua kali pasti suatu saat lupa.
        marks: t.marks === null ? null : safeParse(t.marks)
      }))
    });
  }
  if (path === "/tracks/init") {
    if (method !== "POST") return fail(405, "METODE", "pakai POST");
    const body = await readJson(request);
    if (body === null) return fail(400, "JSON", "badan permintaan bukan JSON");
    const hash = String(body.hash ?? "");
    if (!HASH_RE.test(hash)) return fail(400, "HASH", "hash harus SHA-256 heksadesimal 64 karakter");
    const bytes = Number(body.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0) return fail(400, "UKURAN", "ukuran tidak masuk akal");
    const maxTrack = num(env.MAX_TRACK_BYTES, DEFAULT_MAX_TRACK_BYTES);
    if (bytes > maxTrack) {
      return fail(
        413,
        "TERLALU_BESAR",
        `berkas ${bytes} byte melewati batas ${maxTrack} byte; unggahan sebesar itu butuh multipart yang belum ada`
      );
    }
    const mime = String(body.mime ?? "");
    if (!MIME_ALLOW.has(mime)) return fail(400, "MIME", `jenis berkas ${mime || "?"} tidak didukung`);
    const quota = Number(env.MAX_USER_BYTES);
    if (Number.isFinite(quota) && quota > 0) {
      const used = await store.bytesUsed(user.id);
      if (used + bytes > quota) {
        return fail(
          409,
          "KUOTA",
          `kepustakaan kamu sudah memakai ${used} dari ${quota} byte \u2014 hapus lagu lain dulu`
        );
      }
    }
    const existing = await env.TRACKS.head(objectKey(hash));
    if (existing !== null) return json({ exists: true });
    const signed = await presignPut({
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      key: objectKey(hash),
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      now: /* @__PURE__ */ new Date()
    });
    return json({ exists: false, uploadUrl: signed.url, expiresIn: UPLOAD_URL_TTL_SECONDS });
  }
  if (path === "/tracks/commit") {
    if (method !== "POST") return fail(405, "METODE", "pakai POST");
    const body = await readJson(request);
    if (body === null) return fail(400, "JSON", "badan permintaan bukan JSON");
    const hash = String(body.hash ?? "");
    if (!HASH_RE.test(hash)) return fail(400, "HASH", "hash harus SHA-256 heksadesimal 64 karakter");
    const head = await env.TRACKS.head(objectKey(hash));
    if (head === null) {
      return fail(409, "BELUM_TERUNGGAH", "byte-nya belum ada di penyimpanan \u2014 ulangi unggahannya");
    }
    const bytes = Number(body.bytes);
    if (Number.isFinite(bytes) && bytes > 0 && head.size !== bytes) {
      return fail(
        409,
        "UKURAN_TIDAK_COCOK",
        `yang terunggah ${head.size} byte, yang dicatatkan ${bytes} byte`
      );
    }
    await store.claimTrack(user.id, {
      hash,
      name: String(body.name ?? "Tanpa nama").slice(0, 200),
      bytes: head.size,
      mime: String(body.mime ?? "application/octet-stream"),
      frames: Math.max(0, Math.trunc(Number(body.frames) || 0)),
      sampleRate: Math.max(0, Math.trunc(Number(body.sampleRate) || 0))
    });
    return json({ ok: true, hash });
  }
  const blob = path.match(/^\/tracks\/([0-9a-f]{64})\/blob$/);
  if (blob !== null) {
    if (method !== "GET") return fail(405, "METODE", "pakai GET");
    const hash = blob[1] ?? "";
    if (!await store.hasClaim(user.id, hash)) {
      return fail(404, "TIDAK_ADA", "lagu ini tidak ada di kepustakaanmu");
    }
    const object = await env.TRACKS.get(objectKey(hash));
    if (object === null || object.body === null) {
      return fail(404, "HILANG", "byte-nya tidak ada di penyimpanan");
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        // Inti §5a. Tanpa baris ini, halaman ber-COEP require-corp menolak
        // hasil unduhan ini tanpa menyebut CORP sama sekali.
        "cross-origin-resource-policy": "cross-origin",
        // Isinya ditentukan oleh hash-nya, jadi ia tidak akan pernah berubah.
        "cache-control": "private, max-age=31536000, immutable",
        etag: `"${hash}"`
      }
    });
  }
  const marks = path.match(/^\/tracks\/([0-9a-f]{64})\/marks$/);
  if (marks !== null) {
    if (method !== "PUT") return fail(405, "METODE", "pakai PUT");
    const hash = marks[1] ?? "";
    if (!await store.hasClaim(user.id, hash)) {
      return fail(404, "TIDAK_ADA", "lagu ini tidak ada di kepustakaanmu");
    }
    const text = await request.text();
    if (text.length > MAX_MARKS_BYTES) return fail(413, "TERLALU_BESAR", "cue/grid terlalu besar");
    if (safeParse(text) === null) return fail(400, "JSON", "badan permintaan bukan JSON");
    await store.putMarks(user.id, hash, text);
    return json({ ok: true });
  }
  const track = path.match(/^\/tracks\/([0-9a-f]{64})$/);
  if (track !== null) {
    if (method !== "DELETE") return fail(405, "METODE", "pakai DELETE");
    const hash = track[1] ?? "";
    const used = await store.projectsReferencing(user.id, hash);
    if (used.length > 0) {
      return json(
        {
          code: "MASIH_DIPAKAI",
          message: `lagu ini masih ada di ${used.length} folder project: ${used.map((p) => p.name).join(", ")} \u2014 keluarkan dari folder itu dulu`,
          projects: used
        },
        409
      );
    }
    const removed = await store.releaseTrack(user.id, hash);
    return removed ? json({ ok: true }) : fail(404, "TIDAK_ADA", "lagu ini tidak ada di kepustakaanmu");
  }
  if (path === "/projects") {
    if (method === "GET") {
      const rows = await store.listProjects(user.id);
      return json({
        projects: rows.map((p) => ({
          id: p.id,
          name: p.name,
          updatedAt: p.updated_at,
          version: p.version
        }))
      });
    }
    if (method === "POST") {
      const parsed = await readProjectBody(request);
      if ("error" in parsed) return parsed.error;
      const missing2 = await missingClaims(store, user.id, parsed.json);
      if (missing2.length > 0) return missingResponse(missing2);
      const made = await store.createProject(user.id, parsed.name, parsed.json);
      return json({ id: made.id, version: made.version }, 201);
    }
    return fail(405, "METODE", "pakai GET atau POST");
  }
  const projectTrack = path.match(
    /^\/projects\/([A-Za-z0-9-]+)\/tracks\/([0-9a-f]{64})$/
  );
  if (projectTrack !== null) {
    const projectId = projectTrack[1] ?? "";
    const hash = projectTrack[2] ?? "";
    const row = await store.getProject(user.id, projectId);
    if (row === null) return fail(404, "TIDAK_ADA", "project tidak ditemukan");
    if (method === "POST") {
      if (!await store.hasClaim(user.id, hash)) {
        return fail(404, "TIDAK_ADA", "lagu ini tidak ada di kepustakaanmu");
      }
      await store.addProjectTrack(user.id, projectId, hash);
      return json({ ok: true });
    }
    if (method === "DELETE") {
      const removed = await store.removeProjectTrack(user.id, projectId, hash);
      let deletedFromLibrary = false;
      if (removed && (await store.projectsReferencing(user.id, hash)).length === 0) {
        deletedFromLibrary = await store.releaseTrack(user.id, hash);
      }
      return json({ ok: true, deletedFromLibrary });
    }
    return fail(405, "METODE", "pakai POST atau DELETE");
  }
  const project = path.match(/^\/projects\/([A-Za-z0-9-]+)$/);
  if (project !== null) {
    const id = project[1] ?? "";
    if (method === "GET") {
      const row = await store.getProject(user.id, id);
      if (row === null) return fail(404, "TIDAK_ADA", "project tidak ditemukan");
      const tracks = await store.listProjectTracks(user.id, id);
      return json(
        { id: row.id, name: row.name, json: safeParse(row.json), version: row.version, tracks },
        200,
        { etag: `"${row.version}"` }
      );
    }
    if (method === "PUT") {
      const ifMatch = request.headers.get("if-match");
      if (ifMatch === null) {
        return fail(428, "BUTUH_VERSI", "sertakan If-Match berisi versi yang kamu suntik");
      }
      const expected = Number(ifMatch.replace(/"/g, ""));
      if (!Number.isFinite(expected)) return fail(400, "VERSI", "If-Match harus berisi angka versi");
      const parsed = await readProjectBody(request);
      if ("error" in parsed) return parsed.error;
      const missing2 = await missingClaims(store, user.id, parsed.json);
      if (missing2.length > 0) return missingResponse(missing2);
      const saved = await store.updateProject(
        user.id,
        id,
        parsed.name,
        parsed.json,
        expected
      );
      if (saved.ok) return json({ ok: true, version: saved.version }, 200, { etag: `"${saved.version}"` });
      if (saved.current === null) return fail(404, "TIDAK_ADA", "project tidak ditemukan");
      return json(
        {
          code: "VERSI_BASI",
          message: "project ini sudah berubah di tempat lain \u2014 muat ulang sebelum menyimpan",
          currentVersion: saved.current
        },
        412
      );
    }
    if (method === "DELETE") {
      const row = await store.getProject(user.id, id);
      if (row === null) return fail(404, "TIDAK_ADA", "project tidak ditemukan");
      const members = await store.listProjectTracks(user.id, id);
      const gone = await store.deleteProject(user.id, id);
      if (!gone) return fail(404, "TIDAK_ADA", "project tidak ditemukan");
      for (const hash of members) {
        if ((await store.projectsReferencing(user.id, hash)).length === 0) {
          await store.releaseTrack(user.id, hash);
        }
      }
      return json({ ok: true });
    }
    return fail(405, "METODE", "pakai GET, PUT, atau DELETE");
  }
  return fail(404, "TIDAK_ADA", `tidak ada endpoint ${path}`);
}
__name(route, "route");
function missingBindings(env) {
  const out = [];
  if (env.DB === void 0 || env.DB === null) out.push("DB (d1_databases)");
  if (env.TRACKS === void 0 || env.TRACKS === null) out.push("TRACKS (r2_buckets)");
  return out;
}
__name(missingBindings, "missingBindings");
function objectKey(hash) {
  return `tracks/${hash}`;
}
__name(objectKey, "objectKey");
async function currentUser(request, store) {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token === null) return null;
  return await store.userForSession(await hashToken(token));
}
__name(currentUser, "currentUser");
async function readJson(request) {
  try {
    const parsed = await request.json();
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
__name(readJson, "readJson");
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
__name(safeParse, "safeParse");
function safeAtob(value) {
  try {
    return atob(value);
  } catch {
    return "/";
  }
}
__name(safeAtob, "safeAtob");
function safePath(value) {
  if (value === null || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
__name(safePath, "safePath");
async function readProjectBody(request) {
  const text = await request.text();
  if (text.length > MAX_PROJECT_BYTES) {
    return { error: fail(413, "TERLALU_BESAR", "project terlalu besar") };
  }
  const body = safeParse(text);
  if (body === null) return { error: fail(400, "JSON", "badan permintaan bukan JSON") };
  if (body.json === void 0 || body.json === null) {
    return { error: fail(400, "KOSONG", "field `json` wajib ada") };
  }
  return {
    name: String(body.name ?? "Tanpa judul").slice(0, 200),
    // Disimpan sebagai TEXT apa adanya. Bentuknya milik `serialize()` di sisi
    // web, dan server tidak punya pendapat tentang isinya (§3).
    json: JSON.stringify(body.json)
  };
}
__name(readProjectBody, "readProjectBody");
function hashesIn(projectJson) {
  const out = /* @__PURE__ */ new Set();
  const walk = /* @__PURE__ */ __name((node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === "contentHash" || key === "content_hash") && typeof value === "string" && HASH_RE.test(value)) {
        out.add(value);
      } else if (key === "assetGridsByHash" && typeof value === "object" && value !== null) {
        for (const h of Object.keys(value)) if (HASH_RE.test(h)) out.add(h);
      } else {
        walk(value);
      }
    }
  }, "walk");
  walk(safeParse(projectJson));
  return [...out];
}
__name(hashesIn, "hashesIn");
async function missingClaims(store, userId, projectJson) {
  const missing = [];
  for (const hash of hashesIn(projectJson)) {
    if (!await store.hasClaim(userId, hash)) missing.push(hash);
  }
  return missing;
}
__name(missingClaims, "missingClaims");
function missingResponse(missing) {
  return json(
    {
      code: "ASSET_BELUM_TERSIMPAN",
      message: `${missing.length} lagu yang dipakai project ini belum ada di kepustakaan \u2014 unggah dulu`,
      missing
    },
    409
  );
}
__name(missingResponse, "missingResponse");
var worker_default = {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
export {
  worker_default as default,
  handleRequest,
  hashesIn
};
//# sourceMappingURL=worker.js.map
