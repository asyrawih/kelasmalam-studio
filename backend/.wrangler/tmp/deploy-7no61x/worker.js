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

// src/roblox/open-cloud.ts
var DEFAULT_TIMEOUT_MS = 3e4;
function normalizeBase(base) {
  return base.replace(/\/+$/, "");
}
__name(normalizeBase, "normalizeBase");
async function createAudioAsset(cfg2, input) {
  const creator = input.creatorKind === "group" ? { groupId: input.creatorId } : { userId: input.creatorId };
  const meta = JSON.stringify({
    assetType: "Audio",
    displayName: input.name,
    description: input.description,
    creationContext: { creator }
  });
  const form = new FormData();
  form.append("request", meta);
  form.append("fileContent", new Blob([input.bytes], { type: input.mime }), input.fileName);
  const res = await call(cfg2, `${normalizeBase(cfg2.base)}/assets/v1/assets`, {
    method: "POST",
    body: form
  });
  if (!res.ok) return res;
  const body = res.value;
  const operationId = readOperationId(body);
  if (operationId === null) {
    return {
      ok: false,
      status: 502,
      code: "BALASAN_TIDAK_DIKENALI",
      message: "Roblox menerima berkasnya tapi tidak menyebut id operasinya"
    };
  }
  return {
    ok: true,
    value: {
      operationId,
      done: body.done === true,
      assetId: readAssetId(body),
      moderationState: readModerationState(body)
    }
  };
}
__name(createAudioAsset, "createAudioAsset");
async function getOperation(cfg2, operationId) {
  const res = await call(
    cfg2,
    `${normalizeBase(cfg2.base)}/assets/v1/operations/${encodeURIComponent(operationId)}`,
    { method: "GET" }
  );
  if (!res.ok) return res;
  const body = res.value;
  const assetId = readAssetId(body);
  const err = body.error;
  if (body.done === true && err !== void 0 && err !== null) {
    return {
      ok: false,
      status: 422,
      code: typeof err.code === "string" ? err.code : "OPERASI_GAGAL",
      message: typeof err.message === "string" && err.message !== "" ? err.message : "Roblox menolak asset ini tanpa menyebut alasannya"
    };
  }
  return {
    ok: true,
    value: {
      done: body.done === true,
      assetId,
      moderationState: readModerationState(body)
    }
  };
}
__name(getOperation, "getOperation");
async function call(cfg2, url, init) {
  const doFetch = cfg2.fetchImpl ?? globalThis.fetch;
  const timeoutMs = cfg2.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res;
  try {
    res = await doFetch(url, {
      method: init.method,
      // Content-Type SENGAJA tidak dipasang untuk FormData: boundary-nya
      // dihasilkan runtime, dan menuliskannya sendiri menghasilkan boundary
      // yang tidak cocok dengan badan yang benar-benar dikirim.
      headers: { "x-api-key": cfg2.apiKey, accept: "application/json" },
      ...init.body === void 0 ? null : { body: init.body },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      status: 504,
      code: aborted ? "WAKTU_HABIS" : "JARINGAN",
      message: aborted ? `Roblox tidak menjawab dalam ${Math.round(timeoutMs / 1e3)} detik` : `tidak bisa menghubungi Roblox: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const text = await res.text();
  const body = parseJson(text);
  if (!res.ok) return { ok: false, ...describeFailure(res.status, body, text) };
  if (body === null) {
    return {
      ok: false,
      status: 502,
      code: "BALASAN_TIDAK_DIKENALI",
      message: "Roblox menjawab dengan sesuatu yang bukan JSON"
    };
  }
  return { ok: true, value: body };
}
__name(call, "call");
function parseJson(text) {
  if (text.trim() === "") return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
__name(parseJson, "parseJson");
function describeFailure(status, body, raw) {
  const detail = typeof body?.message === "string" && body.message || typeof body?.error?.message === "string" && body.error.message || raw.slice(0, 200);
  const code = typeof body?.code === "string" && body.code || typeof body?.error?.code === "string" && body.error.code || `HTTP_${status}`;
  const say = /* @__PURE__ */ __name((s) => ({
    status,
    code,
    message: detail === "" ? s : `${s} (${detail})`
  }), "say");
  if (status === 400) return say("Roblox menolak metadata unggahan ini");
  if (status === 401) return say("API key tidak dikenali atau sudah dicabut");
  if (status === 403) {
    return say(
      "API key ditolak: pastikan ia punya izin asset (write) untuk pemilik ini, dan allowlist IP-nya mengizinkan 0.0.0.0/0 \u2014 IP keluar Worker tidak tetap"
    );
  }
  if (status === 404) return say("endpoint atau operasi tidak ditemukan di Roblox");
  if (status === 413) return say("berkas ditolak Roblox karena terlalu besar");
  if (status === 429) return say("kuota unggah Roblox habis atau permintaan terlalu cepat");
  if (status >= 500) return say("Roblox sedang bermasalah");
  return say(`Roblox menolak permintaan ini (HTTP ${status})`);
}
__name(describeFailure, "describeFailure");
function readOperationId(body) {
  if (typeof body.operationId === "string" && body.operationId !== "") return body.operationId;
  if (typeof body.path === "string") {
    const tail = body.path.split("/").filter((s) => s !== "").pop();
    if (tail !== void 0 && tail !== "operations") return tail;
  }
  return null;
}
__name(readOperationId, "readOperationId");
function readAssetId(body) {
  const direct = body.response?.assetId ?? body.assetId;
  if (typeof direct === "string" && direct !== "") return direct;
  if (typeof direct === "number") return String(direct);
  const path = body.response?.path;
  if (typeof path === "string" && path.startsWith("assets/")) {
    const tail = path.slice("assets/".length);
    if (tail !== "") return tail;
  }
  return null;
}
__name(readAssetId, "readAssetId");
function readModerationState(body) {
  const raw = body.response?.moderationResult?.moderationState ?? body.moderationResult?.moderationState;
  if (typeof raw !== "string") return null;
  const normalized = raw.toLowerCase();
  if (normalized.endsWith("approved")) return "approved";
  if (normalized.endsWith("rejected")) return "rejected";
  if (normalized.endsWith("reviewing")) return "reviewing";
  return null;
}
__name(readModerationState, "readModerationState");

// src/roblox/limits.ts
var MAX_BYTES = 20 * 1024 * 1024;
var MAX_SECONDS = 7 * 60;
var MAX_NAME_LEN = 50;
var MAX_DESC_LEN = 1e3;
var AUDIO_EXTS = [".mp3", ".ogg"];
var MIME_OF = {
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg"
};
function extOf(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? "" : fileName.slice(dot).toLowerCase();
}
__name(extOf, "extOf");

// src/roblox/upload-request.ts
var bad = /* @__PURE__ */ __name((code, message) => ({ ok: false, code, message }), "bad");
function field(form, name) {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}
__name(field, "field");
async function parseUpload(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return bad("BUKAN_MULTIPART", "kirim sebagai multipart/form-data dengan bagian `file`");
  }
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return bad("MULTIPART_RUSAK", `badan permintaan tidak bisa dibaca: ${String(err)}`);
  }
  const file = form.get("file");
  if (file === null || typeof file === "string") {
    return bad("FILE_HILANG", "bagian `file` tidak ada di badan permintaan");
  }
  const fileName = "name" in file && typeof file.name === "string" && file.name !== "" ? file.name : field(form, "fileName");
  if (fileName === "") return bad("NAMA_BERKAS_HILANG", "nama berkas tidak ikut terkirim");
  const ext = extOf(fileName);
  if (!AUDIO_EXTS.includes(ext)) {
    return bad("FORMAT", `format ${ext === "" ? "?" : ext} tidak didukung \u2014 pakai MP3 atau OGG`);
  }
  if (file.size > MAX_BYTES) {
    return bad("UKURAN", `berkas ${file.size} byte melewati batas ${MAX_BYTES} byte`);
  }
  if (file.size === 0) return bad("KOSONG", "berkasnya kosong");
  const name = field(form, "name").trim();
  if (name === "") return bad("NAMA_KOSONG", "nama asset wajib diisi");
  if (name.length > MAX_NAME_LEN) {
    return bad("NAMA_PANJANG", `nama ${name.length} karakter, maksimum ${MAX_NAME_LEN}`);
  }
  const description = field(form, "description");
  if (description.length > MAX_DESC_LEN) {
    return bad("DESKRIPSI_PANJANG", `deskripsi ${description.length} karakter, maksimum ${MAX_DESC_LEN}`);
  }
  const creatorKind = field(form, "creatorKind") === "group" ? "group" : "user";
  const creatorId = field(form, "creatorId").trim();
  if (!/^\d+$/.test(creatorId)) {
    return bad("PEMILIK", creatorId === "" ? "ID pemilik belum diisi" : "ID pemilik harus angka");
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) {
    return bad("UKURAN", `berkas ${bytes.byteLength} byte melewati batas ${MAX_BYTES} byte`);
  }
  return {
    ok: true,
    value: {
      bytes,
      fileName,
      mime: MIME_OF[ext] ?? "application/octet-stream",
      name,
      description,
      creatorKind,
      creatorId
    }
  };
}
__name(parseUpload, "parseUpload");

// src/roblox/worker.ts
var DEFAULT_BASE = "https://apis.roblox.com";
var SERVICE = "dawonweb-roblox";
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
__name(json, "json");
var fail = /* @__PURE__ */ __name((status, code, message) => json({ code, message }, status), "fail");
async function handleRequest(request, env, deps = {}) {
  const allowed = parseOrigins(env.ALLOWED_ORIGINS);
  const cors = decideCors(request.headers.get("origin"), allowed);
  if (request.method === "OPTIONS") return preflight(cors.allowOrigin);
  if (cors.rejected) {
    return fail(403, "ORIGIN_DITOLAK", "origin ini tidak ada di ALLOWED_ORIGINS");
  }
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const res = await safeRoute(request, env, deps, path);
  return withCors(res, cors.allowOrigin);
}
__name(handleRequest, "handleRequest");
async function safeRoute(request, env, deps, path) {
  try {
    return await route(request, env, deps, path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${request.method} ${path}]`, message);
    return fail(500, "GALAT_INTERNAL", message);
  }
}
__name(safeRoute, "safeRoute");
async function route(request, env, deps, path) {
  if (path === "/health" || path === "/") {
    if (request.method !== "GET") return fail(405, "METODE", "pakai GET");
    return json({ ok: true, service: SERVICE });
  }
  const apiKey = request.headers.get("x-roblox-api-key")?.trim() ?? "";
  if (path === "/roblox/uploads") {
    if (request.method !== "POST") return fail(405, "METODE", "pakai POST");
    if (apiKey === "") return fail(401, "KUNCI_HILANG", "header x-roblox-api-key wajib diisi");
    const parsed = await parseUpload(request);
    if (!parsed.ok) return fail(400, parsed.code, parsed.message);
    const created = await createAudioAsset(cfg(env, apiKey, deps), parsed.value);
    if (!created.ok) return fail(statusFor(created.status), created.code, created.message);
    return json(created.value, created.value.done ? 200 : 202);
  }
  const op = path.match(/^\/roblox\/operations\/(.+)$/);
  if (op !== null) {
    if (request.method !== "GET") return fail(405, "METODE", "pakai GET");
    if (apiKey === "") return fail(401, "KUNCI_HILANG", "header x-roblox-api-key wajib diisi");
    const state = await getOperation(cfg(env, apiKey, deps), decodeURIComponent(op[1] ?? ""));
    if (!state.ok) return fail(statusFor(state.status), state.code, state.message);
    return json(state.value);
  }
  return fail(404, "TIDAK_ADA", `tidak ada endpoint ${path}`);
}
__name(route, "route");
function cfg(env, apiKey, deps) {
  return {
    base: env.ROBLOX_API_BASE ?? DEFAULT_BASE,
    apiKey,
    ...deps.fetchImpl === void 0 ? null : { fetchImpl: deps.fetchImpl },
    ...deps.timeoutMs === void 0 ? null : { timeoutMs: deps.timeoutMs }
  };
}
__name(cfg, "cfg");
function statusFor(robloxStatus) {
  if (robloxStatus >= 500) return 502;
  if (robloxStatus === 400) return 400;
  return robloxStatus;
}
__name(statusFor, "statusFor");
var worker_default = {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
export {
  worker_default as default,
  handleRequest
};
//# sourceMappingURL=worker.js.map
