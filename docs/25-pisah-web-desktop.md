# 25 — Memisahkan ulang komponen web dan desktop

Rencana memecah `web/` menjadi **dua aplikasi** di atas **paket-paket
bersama**: `apps/web` (Vercel, tetap seperti sekarang) dan `apps/desktop`
(frontend Tauri). Tujuannya satu: desktop boleh berbeda dari web — mulai dari
Studio ala FL Studio (docs/24) — tanpa memaksa web ikut berubah, dan tanpa
menyalin 45 ribu baris kode.

Ini **merevisi** docs/20 §1a ("satu frontend, satu build Vite, tidak ada fork
komponen"). Prinsip yang dipertahankan dari sana: perbedaan platform masuk
lewat kontrak, bukan `if (isTauri)` yang tersebar. Yang berubah: kontraknya
kini dipenuhi oleh **dua aplikasi**, bukan satu bundel yang menebak di runtime.

Prasyarat docs/24: fase F0 dan seterusnya di sana baru dimulai setelah P2 di
sini selesai.

## Status (9 Sep 2026)

| Fase | PR | Catatan |
|---|---|---|
| P0 | #78 | Selesai di branch. Dua hal yang baru ketahuan saat verifikasi dan masuk PR: (1) linker bun harus `hoisted` (`bunfig.toml`), karena linker `isolated` bawaan bun 1.3 membuat `tsc` tidak menemukan types `onnxruntime-web/wasm`; (2) `scnet-model.ts` menunjuk `../../node_modules/onnxruntime-web/dist` dan `vite build` tetap hijau saat path itu tidak ada — `ort-wasm-simd-threaded.{mjs,wasm}` lenyap dari `dist`. Kini alias `@ort-dist` lewat `require.resolve` + tes `ort-dist.test.ts`. Dua tes Rust yang membaca berkas frontend (`contract_tests.rs`, `local_server.rs`) ikut dipindah path-nya. |
| P1 | #79 | Selesai di branch, ditumpuk di atas #78. Bentuk aktual sedikit berbeda dari rencana awal — lihat §1a (letak wasm), §1d (resolver platform), §2 (lingkup `shell`), §1h (vitest). 156 berkas / 1817 tes; gzip JS +0,05%. |
| P2 | — | Titik suntiknya dirinci di §1c (tabel) dan §3 P2. |

---

## 0. Dari mana kita mulai

Diukur dari repo pada 9 Sep 2026 (non-tes, `.ts/.tsx`):

| Folder `web/src/` | Baris | Mengimpor `platform/`? | Sifat |
|---|---|---|---|
| `studio/` | 23.772 | 3 file (`ClipArea`, `url-to-lane`, `export-bridge`) | inti produk, dipakai web dan desktop |
| `dj/` | 10.600 | 1 file (`CollectionBrowser`) | halaman `/dj`, mengimpor `studio/` di 40+ tempat |
| `roblox/` | 5.352 | 17 file | dua jalur: Worker (web) dan SQLite lokal (desktop) |
| `library/` | 3.888 | 6 file | `LibraryApi` dengan dua implementasi (Worker, lokal) |
| `ui/` | 3.447 | 0 | design system `cyber` + shell panel docs/08 |
| `audio/` | 3.136 | 0 | `EngineClient`, worklet, SAB, export worker |
| `app-shell/` | 2.071 | 1 file + `desktop.ts` | routing, registry command, keymap, palette, menu native |
| `landing/` | 1.643 | 1 file | halaman muka web |
| `platform/` | 1.437 | — | kontrak `PlatformHost` + dua implementasi + `local-commands` (tipe 50 command Tauri) |
| `state/` | 1.224 | 0 | mirror engine untuk shell panel docs/08 |
| `proof-stem/` | 1.027 | 2 file | model SCNet, unduh via adapter |
| `youtube/` | 545 | 3 file (semuanya) | **hanya desktop** |
| `stem/`, `encoders/`, `soundcloud/` | 557 / 461 / 465 | 0 / 0 / 3 | soundcloud punya transport desktop in-process |

Yang ditemukan dari angka itu:

1. **Adapter `platform/` bekerja untuk berkas, dialog, drop, model** — itu yang
   dijanjikan docs/20 §2c, dan komponen memang tidak memanggil `isTauri()`
   sendiri untuk hal-hal itu.
2. **Tapi fitur desktop-only tumbuh di luar adapter.** 46 file non-tes
   bercabang pada `kind === 'desktop'`, `localInvoke`, atau `@tauri-apps/*`:
   tombol YOUTUBE di `StudioHeader`, `StoreSettings` kepustakaan lokal,
   seluruh `roblox/local/`, `soundcloud/desktop-transport`, `library/local-api`.
   Adapter menjawab "bagaimana", tapi tidak menjawab "fitur ini ada atau
   tidak" — dan pertanyaan kedua itulah yang dijawab dengan `if` di komponen.
3. **Bundel web membawa kode yang tidak pernah jalan di browser**:
   `local-commands.ts` (tipe saja, ringan) tapi juga `youtube/`, `roblox/local`,
   `library/local-api`, dan lima paket `@tauri-apps/*` di `web/package.json`.
   `app-shell/desktop.ts` mengimpor dinamis supaya hemat — bukti bahwa masalah
   ini sudah dirasakan dan ditambal per kasus.
4. **Studio dan DJ saling terikat**: `dj/` mengimpor `studio/` (model, peaks,
   waveform, stem), `library/` mengimpor keduanya. Memisahkan Studio web dari
   Studio desktop tanpa memisahkan lapisan yang dipakai DJ akan memutus DJ.
5. **Toolchain**: skrip root sudah `bun`; `pnpm-workspace.yaml` dan
   `pnpm-lock.yaml` masih ada tapi tidak dipakai. Belum ada alias path di
   `tsconfig`; semua impor relatif. CI: `native`, `native-host`, `wasm`,
   `deploy` (Vercel); desktop dirilis dari mesin lokal (docs/22).

---

## 1. Keputusan yang mengikat

### a) Dua aplikasi, paket bersama, satu workspace bun

```
apps/
  web/                 ← `web/` hari ini, dipindah (git mv), Vercel
  desktop/             ← frontend Tauri: entry, routes, komposisi halaman, adapter desktop
    src-tauri/         ← `desktop/src-tauri` hari ini, dipindah (git mv); frontendDist → ../dist
packages/
  engine/              ← src/audio/ (EngineClient, worklet, SAB), src/encoders/, src/state/, src/wasm/ (artefak build, gitignored)
  ui/                  ← ui/cyber, ui/lib, ui/panels
  shell/               ← app-shell tanpa desktop.ts: registry command, keymap, palette, VersionTag
  platform/            ← KONTRAK saja: host.ts, hooks (useAudioFilePicker, useNativeFileDrop)
  studio/              ← studio/ (lane) — dipakai apps/web selamanya, apps/desktop sampai docs/24 F8
  studio-core/         ← (P4) bagian studio yang tidak tahu lane: peaks, waveform, import/decode, analysis, fade, snap, export pipeline, stem
  dj/                  ← dj/
  library/             ← kontrak LibraryApi + UI dock/browser; implementasi Worker dan lokal disuntik apps
  proof-stem/          ← model SCNet + halaman
backend/               ← tetap
```

Semua paket menaruh sumbernya di `src/` dengan **kedalaman folder yang sama
seperti di `apps/web/src`** (`packages/engine/src/audio/…`, bukan
`packages/engine/audio/…`). Itu bukan selera: impor relatif di dalam paket
(`state → ../audio`) dan path relatif ke `crates/…` di tes
(`audio/sab-layout.test.ts` membaca `../../../crates/rt/src/layout.rs`)
tidak perlu berubah, sehingga `git mv` tetap terdeteksi sebagai rename
(77 rename di P1) dan hanya impor LINTAS paket yang ditulis ulang.

Paket dikonsumsi sebagai sumber TypeScript — tidak ada build step. Alias
`@kelasmalam/<paket>/<subpath>` datang dari SATU sumber: `paths` di
`tsconfig.base.json` root dan `workspace-aliases.ts` root (untuk Vite dan
Vitest), dijaga `workspace-aliases.test.ts` agar keduanya selalu setara.

`package.json` root memakai `"workspaces": ["apps/*", "packages/*", "backend"]`.
`pnpm-workspace.yaml` dan `pnpm-lock.yaml` dihapus; `bun.lock` yang dipegang
(diputuskan 9 Sep 2026). `bunfig.toml` memaksa `linker = "hoisted"` —
lihat Status P0. Folder `desktop/` di root hilang: seluruh isinya
adalah `src-tauri`, dan tempat yang benar untuknya adalah di samping frontend
yang ia bungkus.

### b) Aturan impor, ditegakkan tes

| Siapa | Boleh mengimpor | Dilarang |
|---|---|---|
| `packages/*` | `packages/*` lain (tanpa siklus), React, pustaka netral | `@tauri-apps/*`, `@vercel/*`, `isTauri`, `kind === 'desktop'`, `localInvoke`, `apps/*` |
| `apps/web` | semua `packages/*`, `@vercel/*` | `@tauri-apps/*` |
| `apps/desktop` | semua `packages/*`, `@tauri-apps/*` | `@vercel/*` |

Satu tes vitest di root (`scripts/no-platform-leak.test.ts`) memindai
`packages/**` untuk string terlarang dan memeriksa `package.json` tiap paket
tidak mendeklarasikan dependensi terlarang. Merah = PR tidak masuk. Ini
pengganti "review saja" yang gagal menjaga docs/20 §1a.

### c) "Fitur ini ada atau tidak" dijawab lewat komposisi, bukan `if`

Pola yang dipakai untuk 46 file yang bercabang:

| Bentuk cabang hari ini | Bentuk sesudahnya |
|---|---|
| `StudioHeader` menampilkan tombol YOUTUBE kalau desktop | `StudioHeader` menerima prop `importActions: readonly ImportAction[]`; `apps/desktop` menyuntik YouTube, `apps/web` tidak |
| `LibraryDock` memilih `createLocalLibraryApi` vs Worker | `packages/library` mengekspor `LibraryApi` + UI; `apps/*` memanggil `createLibraryApi()` miliknya dan memberikannya lewat provider |
| `RobloxPage` memilih transport Worker vs lokal | `packages/roblox` berisi model + UI + `RobloxTransport` (kontrak); `apps/web` menyuntik `worker-transport`, `apps/desktop` menyuntik `desktop-transport` + `queue-persistence` SQLite |
| `soundcloud/api.ts` memilih fetch vs `soundcloud_json` | `packages/soundcloud` mengekspor kontrak `SoundCloudTransport`; implementasi di masing-masing app |
| `main.tsx` merender `<Analytics/>` kalau web | hanya ada di `apps/web/src/main.tsx` |
| `app-shell/desktop.ts` (judul jendela, tutup, menu native) | pindah ke `apps/desktop/src/window.ts`; `packages/shell` mengekspor `runCommand` yang dipanggilnya |
| `url-to-lane.ts` mengenali link YouTube lewat `platform` | `packages/studio` mengekspor `UrlImporter` (kontrak); `apps/desktop` mendaftarkan importer YouTube |

Aturannya: **paket menerima kemampuan sebagai nilai** (prop, provider,
registry), tidak pernah bertanya di mana ia berjalan.

Titik suntik yang harus ada sejak P2 (karena modul-modul ini belum jadi
paket, registrasinya untuk sementara diekspor dari `apps/web/src/*` dan
dipanggil `apps/desktop` lewat alias `@app-web/*` dengan `TODO(P3)`):

| Modul di `apps/web/src` | Hari ini | Titik suntik P2 |
|---|---|---|
| `App.tsx` (halaman Studio) | `useMemo(() => getPlatformHost().kind === 'desktop')`, mengimpor `./youtube/YouTubeDialog` | prop `extras` / `importActions` — desktop menyuntik tombol + dialog YouTube; web tidak tahu YouTube ada |
| `studio/timeline/url-to-lane.ts` | cabang `kind === 'desktop'` + impor `../../youtube` | registry `registerUrlImporter({ matches, import })`; desktop mendaftarkan importer YouTube |
| `library/api.ts` + `platform/{web,desktop}.ts` | host memilih `createLibraryApi` (Worker) vs `createLocalLibraryApi` (SQLite) | tetap lewat `PlatformHost.libraryApi()`; `local-api.ts`, `store-settings.ts`, `StoreSettings.tsx` pindah ke `apps/desktop`; `KeymapEditor` menerima slot `storeSettings?: ReactNode` |
| `roblox/store.ts` | `persistence ??= kind === 'desktop' ? createLocalQueuePersistence() : createWebPersistence()` | `registerRobloxPersistence(factory)`; bawaan web |
| `roblox/RobloxRoute.tsx` | memilih `createDesktopTransport`/`createLocalGrantApi`/`localInvoke` dari `kind` | prop/registry `RobloxBackend { transport, grantApi, saveTarget }`; implementasi desktop pindah ke `apps/desktop/src/roblox-local/` |
| `soundcloud/api.ts` | `kind === 'desktop' ? desktopTransport : fetch` | `registerSoundCloudTransport(transport)`; bawaan `fetch` |
| `main.tsx` | `kind === 'web' ? <Analytics/>` | hanya ada di `apps/web` |
| `app-shell/AppShell.tsx` + `desktop.ts` | `isDesktop()` untuk judul jendela, tutup, menu native, gerbang login | `apps/desktop/src/app-shell/AppShell.tsx` sendiri (rute tanpa landing/legal, tanpa gerbang login) + `window.ts`; `apps/web` kehilangan seluruh cabang itu |
| `proof-stem/scnet-model.ts` | `host.kind !== 'desktop'` untuk prefetch model di main thread | tetap: ini pertanyaan ke KONTRAK host (`modelBytes` ada/tidak), bukan `isTauri`; diganti `host.modelBytes === undefined` bila kontraknya dibuat opsional |

### d) `PlatformHost` tetap, tapi menjadi milik tiap app

`packages/platform` hanya menyimpan `host.ts` (kontrak) dan dua hook yang
bekerja di atas kontrak. `web.ts` pindah ke `apps/web/src/platform/`,
`desktop.ts` + `local-invoke.ts` + `local-commands.ts` ke
`apps/desktop/src/platform/`. `getPlatformHost()` di paket tidak tahu
`isTauri()`: paket menyimpan **resolver** yang didaftarkan app
(`registerPlatformHostResolver`, `packages/platform/src/host-registry.ts`),
dan `apps/*/src/platform/index.ts` mendaftarkannya di level modul. Ini yang
membuat worker tetap benar: worker tidak menjalankan `main.tsx`, tapi modul
yang butuh host di worker (`proof-stem/scnet-model.ts` lewat
`auto-stem.worker.ts`) mengimpor `../platform` milik app, yang mendaftarkan
resolvernya sendiri. Hook (`useAudioFilePicker`, `useNativeFileDrop`) hidup
di paket dan diekspor ke app lewat `apps/web/src/platform/hooks.ts`, BUKAN
lewat index, supaya worker yang mengimpor `../platform` tidak menarik React
(terukur +2,7 KB gzip per worker kalau lewat index).

### e) Studio web tidak berubah; Studio desktop boleh berbeda

`packages/studio` adalah Studio lane hari ini, dipakai `apps/web` **tanpa
batas waktu**. `apps/desktop` juga memakainya sampai docs/24 F8, lalu
berganti ke `packages/studio-fl`. Keduanya berdiri di atas
`packages/studio-core` (P4), sehingga perbaikan pada waveform, import, BPM,
stem, atau export mengalir ke dua Studio sekaligus. DJ hanya bergantung pada
`studio-core`, bukan pada `studio` maupun `studio-fl`.

### f) Satu konfigurasi Vite dasar, dua entry

`packages/engine/vite/base.ts` mengekspor plugin worklet, header COOP/COEP,
`define` build-info, dan aturan `optimizeDeps` yang sekarang ada di
`apps/web/vite.config.ts` (P1 belum mengekstraknya; itu pekerjaan P2 karena
baru di P2 ada konsumen kedua). `apps/web/vite.config.ts` dan
`apps/desktop/vite.config.ts` memanggilnya dan menambah yang khas: web
menambah `_headers`/Analytics; desktop menambah `envPrefix: ['VITE_',
'TAURI_']` dan `clearScreen: false`. Artefak WASM ditulis
`scripts/build-wasm.sh` ke `packages/engine/wasm/` (dari `web/src/wasm/`).

### h) Satu konfigurasi Vitest, root = akar repo

Tes di `packages/*/src/**` dijalankan oleh `apps/web/vitest.config.ts` yang
`root`-nya akar repo (`include: ['apps/web/src/**', 'packages/*/src/**']`),
bukan `vitest.workspace`. Paket dikonsumsi sebagai sumber, jadi ia butuh
setup (`vitest-canvas-mock`, stub pointer capture), plugin, dan alias yang
IDENTIK dengan app — workspace berarti dua tempat yang harus dijaga sama.
`apps/desktop` (P2) memakai config yang sama bentuknya dengan `include`
miliknya; tes paket tidak dijalankan dua kali (hanya dari `apps/web`).

### g) Kode Rust tidak berubah; `src-tauri` pindah folder

`crates/*` dan isi `src-tauri` tidak disentuh. `desktop/src-tauri` dipindah
utuh (`git mv`) ke `apps/desktop/src-tauri`, tetap anggota workspace Cargo
dan tetap dikecualikan dari job CI Ubuntu (docs/20 §1e). Semua yang
menyebut path lama diperbarui dalam PR yang sama — daftar lengkapnya dari
`grep -rn "desktop/src-tauri"`:

| Berkas | Yang berubah |
|---|---|
| `Cargo.toml` (root) | anggota workspace `"apps/desktop/src-tauri"` |
| `package.json` (root) | `dev:desktop`, `build:desktop` → `cd apps/desktop/src-tauri` |
| `apps/desktop/src-tauri/tauri.conf.json` | `frontendDist: "../dist"`, `beforeDevCommand: "cd .. && bun run dev"` |
| `.github/workflows/ci.yml` | `working-directory: apps/desktop/src-tauri` |
| `scripts/release-desktop.sh` | `TAURI_DIR="$ROOT/apps/desktop/src-tauri"` |
| `scripts/desktop-version.sh` | `TAURI_CONF` path baru |
| docs/20 §1e, §1c, §2d; docs/21 §0; docs/22; docs/23 | path baru, satu kalimat "dipindah oleh docs/25" |

---

## 2. Peta pemindahan

| Dari `web/src/` | Ke | Catatan |
|---|---|---|
| `audio/`, `encoders/`, `state/`, `wasm/`, `worklet.d.ts` | `packages/engine/src/` | nol cabang platform; `export-worker` mengimpor `studio/export` → pindah bersama ke `studio-core` di P4, sementara alias |
| `ui/` | `packages/ui/src/` | `ui/panels` mengimpor `state/` → dependensi `ui → engine` (searah, boleh) |
| `app-shell/{command,keymap,keys,useCommands,CommandPalette,useKeyDispatch}` | `packages/shell/src/` | **P1 (aktual):** hanya registry + keymap + dispatch + palette. `AppShell.tsx`, `routes.ts`, `VersionTag.tsx` (build-info), `KeymapEditor.tsx` (StoreSettings) tetap di app — komposisi halaman adalah urusan P2, dan tiap app punya `AppShell`-nya sendiri |
| `app-shell/desktop.ts`, `menu-ids.ts` | `apps/desktop/src/window/` | menu native = pintu ketiga registry (docs/15), tetap |
| `platform/host.ts`, `useAudioFilePicker`, `useNativeFileDrop` | `packages/platform/src/` | kontrak |
| `platform/web.ts` | `apps/web/src/platform/` | |
| `platform/desktop.ts`, `local-invoke.ts`, `local-commands.ts` | `apps/desktop/src/platform/` | `local-commands` = tipe 50 command Tauri; tesnya (`contract_tests.rs` ↔ `LOCAL_COMMAND_NAMES`) ikut |
| `library/` | `packages/library/src/` + `apps/web/src/library-worker/` + `apps/desktop/src/library-local/` | `api.ts` dipecah: kontrak + Worker impl; `local-api.ts`, `store-settings.ts`, `StoreSettings.tsx` ke desktop |
| `roblox/` | `packages/roblox/src/` + `apps/*/src/roblox-*/` | `backend/desktop-transport.ts`, `local/`, `grant/local-api.ts`, `persistence` SQLite ke desktop; Worker transport ke web |
| `soundcloud/` | `packages/soundcloud/src/` + transport per app | |
| `youtube/` | `apps/desktop/src/youtube/` | seluruhnya desktop |
| `studio/` | `packages/studio/src/` | tiga file bercabang dibersihkan lewat §1c |
| `dj/` | `packages/dj/src/` | `CollectionBrowser` memakai hook kontrak, sudah benar |
| `proof-stem/`, `stem/` | `packages/proof-stem/src/`, `packages/studio-core` (P4) | |
| `landing/`, `App.tsx`, `main.tsx`, `index.css`, `public/` | `apps/web/src/` | |
| `desktop/src-tauri/` (di luar `web/`) | `apps/desktop/src-tauri/` | utuh, `git mv`; rujukan path di §1g |

---

## 3. Fase

```
P0 workspace ─► P1 paket netral ─► P2 apps/desktop lahir ─► P3 studio/dj/library jadi paket ─► P4 studio-core ─► docs/24 F0…
```

P1 dan P2 bisa dikerjakan paralel setelah P0, asal P2 memakai alias ke folder
lama untuk paket yang belum diekstrak. P3 menunggu keduanya.

### P0 — Workspace bun dan pemindahan `web/` → `apps/web`

Perubahan tanpa perilaku baru: `git mv web apps/web`, `workspaces` di root,
hapus `pnpm-*`, perbarui skrip root, `vercel.json`, `deploy.yml`, `ci.yml`
(artefak `web-dist`), `scripts/build-wasm.sh`, `scripts/size-check.sh`,
`scripts/release-desktop.sh`, `tauri.conf.json` (`frontendDist` sementara
→ `../../apps/web/dist`), docs/04 dan docs/20 §2a.

**Done:**
1. `bun install` bersih dari root; `bun run build`, `bun run test`,
   `bun run dev:desktop` berjalan seperti sebelum pemindahan.
2. CI hijau dengan `deploy.yml` mengunggah `apps/web/dist`; Vercel preview
   memutar `/studio`.
3. `git log --follow apps/web/src/studio/store.ts` menampilkan riwayat lama
   (pemindahan terdeteksi sebagai rename, bukan hapus-tambah).

### P1 — Paket netral: `engine`, `ui`, `shell`, `platform`

Ekstrak empat folder yang hari ini nol cabang platform (kecuali `shell` yang
melepas `desktop.ts`). Tiap paket punya `package.json` (`name`,
`exports`, `dependencies` eksplisit), `tsconfig.json` mewarisi
`tsconfig.base.json` root, dan `vitest` yang sama. Tes §1b mulai hidup.

**Done:**
1. `apps/web` mengimpor `@kelasmalam/engine`, `@kelasmalam/ui`,
   `@kelasmalam/shell`, `@kelasmalam/platform`; tidak ada impor relatif ke
   folder yang sudah pindah.
2. Tes `no-platform-leak` hijau untuk empat paket.
3. Semua tes yang ada lolos; jumlahnya tidak berkurang (dihitung dari
   ringkasan vitest sebelum/sesudah).
4. Ukuran `apps/web/dist` (gzip, `size-check.sh`) tidak bertambah.

### P2 — `apps/desktop` lahir

Entry sendiri, `AppShell` dengan tabel route sendiri (tanpa `landing`,
`privacy-policy`, `terms-of-service`; buka langsung `/studio`), host desktop
dipasang di `main.tsx`, `window.ts` untuk judul/tutup/menu, `youtube/`,
kepustakaan lokal, roblox lokal, soundcloud in-process. Dalam PR yang sama,
`desktop/src-tauri` dipindah ke `apps/desktop/src-tauri` dengan semua
rujukan path §1g — supaya `tauri.conf.json` hanya diubah sekali, bukan dua
kali (P0 lalu P2). Untuk folder yang
belum jadi paket (`studio`, `dj`, `library`, `roblox`), `apps/desktop`
memakai alias sementara `@app-web/*` → `apps/web/src/*`, dan cabang
`kind === 'desktop'` di dalamnya **belum** dibersihkan — itu P3.

Ke-46 file bercabang ditinjau satu per satu di P2 dengan tabel §1c: yang
mengimpor `@tauri-apps`/`localInvoke`/`local-commands` **harus** pindah ke
`apps/desktop` di P2 (kalau tidak, bundel web masih membawa Tauri), dan itu
memaksa titik suntik di tabel §1c dibuat sekarang meski modulnya masih di
`apps/web`. Cabang `kind` yang tersisa di `apps/web` (mis. `RobloxRoute`
memilih teks "UI ONLY") boleh tinggal sampai P3, diberi `TODO(P3)` yang
dihitung tes.

`apps/desktop/src/` yang lahir di P2:

```
main.tsx            ← host desktop didaftarkan, tanpa Analytics
index.html, vite.config.ts (base bersama §1f), vitest.config.ts, tsconfig.json, package.json (@tauri-apps/* pindah ke sini)
platform/           ← desktop.ts, local-invoke.ts, local-commands.ts, index.ts (resolver desktop) — dari apps/web/src/platform
window/             ← app-shell/desktop.ts, menu-ids.ts (judul, tutup, menu native → runCommand)
app-shell/          ← AppShell.tsx + routes.ts sendiri: /studio, /dj, /roblox, /proof-stem; tanpa gerbang login
youtube/            ← seluruhnya
library-local/      ← library/local-api.ts, store-settings.ts, StoreSettings.tsx
roblox-local/       ← roblox/local/, backend/desktop-transport.ts, grant/local-api.ts, persistence lokal
soundcloud/         ← desktop-transport.ts
src-tauri/          ← desktop/src-tauri (git mv), lihat §1g
```

**Done:**
1. `bun run dev:desktop` dan `bun run build:desktop` berjalan dari
   `apps/desktop/src-tauri`; `git log --follow apps/desktop/src-tauri/src/lib.rs`
   menampilkan riwayat lama; folder `desktop/` di root tidak ada lagi. Studio
   memutar, export menulis berkas, drop dari Finder, YouTube, kepustakaan
   lokal, Roblox lokal, SoundCloud in-process — semua alur docs/20–23
   yang sudah terbukti tetap lolos (daftar uji manual di docs/22 dijalankan).
2. `apps/web/dist` **tidak lagi** memuat `@tauri-apps/*`, `youtube/`,
   `roblox/local`, `library/local-api` (dicek `vite build --report` atau grep
   pada chunk).
3. `apps/web/package.json` tanpa `@tauri-apps/*`; `apps/desktop/package.json`
   tanpa `@vercel/*`.
4. `main.tsx` desktop tidak memanggil `isTauri()`; `getPlatformHost()` di
   paket tidak lagi mengimpor `@tauri-apps/api/core`.
5. Tes `desktop.test.tsx`, `local-invoke.test.ts`, `contract_tests.rs` pindah
   dan lolos; `cargo test --workspace` dan job `native` CI hijau dengan
   anggota workspace di path baru.
6. `scripts/release-desktop.sh` dan `scripts/desktop-version.sh` dijalankan
   sekali sampai tahap build (tanpa notarisasi) untuk membuktikan path.

### P3 — `studio`, `dj`, `library`, `roblox`, `soundcloud`, `proof-stem` jadi paket

Cabang platform dibersihkan menurut §1c. `LibraryApi` dan `RobloxTransport`
menjadi kontrak yang disuntik. `AppShell` menerima provider untuk
`libraryApi`, `importActions`, `urlImporters`.

**Done:**
1. `grep -rE "kind === 'desktop'|isTauri|localInvoke|@tauri-apps" packages/`
   kosong; tes `no-platform-leak` hijau untuk semua paket.
2. Alias `@app-web/*` dihapus dari `apps/desktop`.
3. Tes 84 file di `studio/` + `dj/__tests__` + `library/*.test` + `roblox`
   lolos di lokasi baru; tes yang dulu mem-mock `@tauri-apps/api` kini
   mem-mock kontrak (lebih kecil) — dan yang menguji implementasi desktop
   pindah ke `apps/desktop`.
4. Web: perilaku identik (uji manual docs/09 M5–M8 + smoke test).

### P4 — `studio-core`: lapisan yang tidak tahu lane

Dari `packages/studio` diekstrak: `model.ts` bagian asset/peaks, `timeline/`
non-lane (`waveform`, `wave-window`, `fade`, `clip-trim`, `clip-snap`,
`normalize`, `content-hash`, `sniff`, `audio-import`, `url-import`,
`import-sink`, `beat-*`, `envelope`, `stem*`), `analysis/`, `export/`,
`persist/decode-asset`, dan `stem/`. `dj/` dialihkan ke `studio-core`.

**Done:**
1. `packages/dj` tidak mengimpor `@kelasmalam/studio` sama sekali (hanya
   `studio-core`).
2. `packages/studio` (lane) hanya berisi: `StudioLane`, `store`, `shell/`,
   `rail/`, `fx/`, `timeline/{ClipArea,LaneHeaders,…}`, `preview/`,
   `persist/persistence`, `commands`.
3. Semua tes lolos; ini gerbang docs/24 F0.

---

## 4. Yang tidak berubah

- `crates/*`, `backend/`, `schema/`, isi `src-tauri` (hanya foldernya yang
  pindah), kontrak event/command Tauri (`LOCAL_COMMAND_NAMES` ↔
  `contract_tests.rs`), format project (`SCHEMA_VERSION`).
- Design system `cyber` dan `design/*.dc.html`.
- Alur rilis desktop docs/22, kecuali path `dist`.
- URL publik web, routing `/studio`, `/dj`, `/roblox`, `/proof-stem`.

## 5. Utang yang dinyatakan terbuka

- **`ui/panels` + `state/`** (shell panel docs/08 yang membaca engine
  langsung) hidup berdampingan dengan `studio/` yang sebenarnya dipakai.
  Rencana ini memindahkannya apa adanya ke `packages/ui` dan `packages/engine`;
  memutuskan nasibnya (dipakai docs/24 atau dihapus) adalah bagian docs/24 F3.
- **Landing di desktop**: tidak ada; desktop membuka `/studio`. Kalau nanti
  butuh "halaman pembuka" desktop, itu halaman baru di `apps/desktop`, bukan
  `landing/` yang dibagi.
- **Login desktop** (docs/20 §1d) tetap ditunda; `authHeaders()` di kontrak
  tetap ada.
- **Windows** tetap "lewat CI sampai ada mesin" (docs/20 §5b); P2 diuji di
  macOS, `mt` lewat server loopback (PR #65).
