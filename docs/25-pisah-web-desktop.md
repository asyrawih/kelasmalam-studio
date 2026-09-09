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
| P2 | #80 | Selesai di branch, ditumpuk di atas #79. `apps/desktop` lahir (port dev 5174), `src-tauri` pindah, bundel web bebas Tauri (gzip −3,1%), Vite base bersama `packages/engine/vite/base.ts` (`defineDawApp`). Registry host **dua tingkat** (web mendaftar bawaan, desktop menang) karena modul `apps/web` yang ditarik desktop ikut mendaftar host web. 28 berkas `apps/desktop/src` masih memakai `@app-web` (allowlist `app-web-imports.test.ts`) — P3 menurunkannya ke nol. Uji manual docs/22 dan job CI `desktop` di runner macOS/Windows belum dijalankan. |
| P4 | branch `feat/p4-studio-core` | `packages/studio-core` lahir: registry aset (`assetStore`) keluar dari store project, analisis/waveform/import/stem/cache PCM pindah; `dj → studio-core` dan TIDAK lagi `→ studio` (dijaga tes). Bentuk aktual sedikit berbeda dari rencana — §3 P4: import job tetap di studio (UI lane), `stem.ts`/`stem-bake`/`beat-cut`/`clip-*`/`library-drop` tetap di studio karena tahu clip/lane, `fader` ke `ui/lib`, `ScrollingWave` menerima jam lewat prop. Undo/penanda kotor untuk aset dipertahankan lewat snapshot gabungan di store project. |
| P3 | branch `feat/p3-paket-halaman` | Enam paket halaman lahir (`studio` berikut `stem/` dan `StudioPage`, `dj`, `library` berikut `local-error`, `roblox`, `soundcloud`, `proof-stem`); alias `@app-web/*` dihapus total dan dijaga tidak kembali (`app-web-imports.test.ts` kini memindai seluruh repo). Graf paket jadi DAG yang ditegakkan tes (`no-package-cycles.test.ts`, §1b). Cicilan P4 ikut masuk: pipeline export (`run-export`, `sinks`, `wasm-engine`, `loudness-analyzer`, bentuk payload) pindah ke `packages/engine/src/export/` supaya `export-worker` tidak mengimpor studio. Kontrak host kehilangan `libraryApi()` (diganti `registerLibraryApi` di paket library) dan `modelBytes` jadi opsional; NOL cabang `kind === 'desktop'` di `packages/*` dan `apps/web`. Detail di §1c, §1d, §2, P3. |

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
  studio/              ← studio/ (lane) + stem/ + StudioPage — dipakai apps/web selamanya, apps/desktop sampai docs/24 F8
  studio-core/         ← (P4) bagian studio yang tidak tahu lane: peaks, waveform, import/decode, analysis, fade, snap, stem. Pipeline export sudah di engine/src/export (cicilan P4 di P3)
  dj/                  ← dj/
  library/             ← kontrak LibraryApi + DTO + local-error, klien Worker, dok/browser, registry `registerLibraryApi`; implementasi lokal di apps/desktop
  roblox/              ← model, store, UI, transport Worker; backend lokal di apps/desktop, disuntik `registerRobloxBackend`
  soundcloud/          ← klien + dialog + `useSoundCloudImport()` (tombol/dialog yang disuntik ke StudioPage); transport in-process di apps/desktop
  proof-stem/          ← katalog + pemuat model SCNet + halaman
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
| `StudioHeader` menampilkan tombol YOUTUBE kalau desktop | `StudioHeader` menerima prop `importActions: readonly ImportAction[]`; `apps/desktop` menyuntik YouTube, `apps/web` tidak. **P3:** SoundCloud pun begitu — `useSoundCloudImport()` dari paket soundcloud dipasang kedua app, karena `soundcloud → studio` dan `StudioPage` tidak boleh mengimpor balik |
| `LibraryDock` memilih `createLocalLibraryApi` vs Worker | `packages/library` mengekspor `LibraryApi` + UI; `apps/*` mendaftarkan factory-nya lewat `registerLibraryApi()` (web: klien Worker dari env; desktop: lokal) dan `StudioPage` menerima `<LibraryDock/>` sebagai prop `dock` |
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
| `library/api.ts` + `platform/{web,desktop}.ts` | host memilih `createLibraryApi` (Worker) vs `createLocalLibraryApi` (SQLite) | P2: lewat `PlatformHost.libraryApi()`; `local-api.ts`, `store-settings.ts`, `StoreSettings.tsx` pindah ke `apps/desktop`; `KeymapEditor` menerima slot `storeSettings?: ReactNode`. **P3:** `libraryApi()` DIHAPUS dari kontrak (platform tidak boleh mengimpor paket halaman); `registerLibraryApi(factory)`/`getLibraryApi()` di `packages/library/src/library/registry.ts`, dipanggil `main.tsx` tiap app |
| `roblox/store.ts` | `persistence ??= kind === 'desktop' ? createLocalQueuePersistence() : createWebPersistence()` | `registerRobloxPersistence(factory)`; bawaan web |
| `roblox/RobloxRoute.tsx` | memilih `createDesktopTransport`/`createLocalGrantApi`/`localInvoke` dari `kind` | prop/registry `RobloxBackend { transport, grantApi, saveTarget }`; implementasi desktop pindah ke `apps/desktop/src/roblox-local/` |
| `soundcloud/api.ts` | `kind === 'desktop' ? desktopTransport : fetch` | `registerSoundCloudTransport(transport)`; bawaan `fetch` |
| `main.tsx` | `kind === 'web' ? <Analytics/>` | hanya ada di `apps/web` |
| `app-shell/AppShell.tsx` + `desktop.ts` | `isDesktop()` untuk judul jendela, tutup, menu native, gerbang login | `apps/desktop/src/app-shell/AppShell.tsx` sendiri (rute tanpa landing/legal, tanpa gerbang login) + `window.ts`; `apps/web` kehilangan seluruh cabang itu |
| `proof-stem/scnet-model.ts` | `host.kind !== 'desktop'` untuk prefetch model di main thread | **P3:** `modelBytes` OPSIONAL di kontrak dan `prefetchModelBytes` memeriksa `host.modelBytes === undefined`. Host web tidak punya `modelBytes` lagi: fetch + cache OPFS adalah jalur browser umum, pindah kembali ke `scnet-model.ts` (`fetchModelBytesInBrowser`) dan berjalan di worker — worker memang tidak punya host (§1d). Cabang serupa di `SoundCloudDialog` (DOWNLOAD: `<a download>` vs browser OS) jadi `host.downloadUrl` opsional |

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
di paket dan diekspor lewat `@kelasmalam/platform/hooks`, BUKAN lewat index,
supaya pemilih yang dimuat worker tidak menarik React (terukur +2,7 KB gzip
per worker kalau lewat index).

**P3 mengubah bagian worker.** Begitu `scnet-model.ts` jadi paket ia tidak
boleh mengimpor `../platform` milik app, jadi di worker TIDAK ADA host sama
sekali. Itu ternyata benar: satu-satunya yang worker minta ke host adalah
byte model, dan host yang punya cara istimewa (desktop, IPC) memang hanya bisa
dipanggil dari main thread. Maka `modelBytes` jadi opsional — main thread
memanggilnya bila ada dan mengirim byte-nya ke worker; bila tidak ada, worker
mengambil sendiri lewat jalur browser umum (fetch + OPFS) di `proof-stem`.
Host web tidak mendaftarkan apa-apa di worker, dan tidak perlu. Di tes, host
untuk komponen paket dipasang `apps/web/src/__tests__/setup.ts` (memuat
`../platform` → resolver bawaan web); setup desktop mengimpornya dan resolver
app desktop tetap menang.

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
| `audio/`, `encoders/`, `state/`, `wasm/`, `worklet.d.ts` | `packages/engine/src/` | nol cabang platform. **P3 (cicilan P4):** `studio/export/{run-export,sinks,wasm-engine,loudness-analyzer}` + tesnya dan BENTUK payload (`ExportPayload`, `ExportAssetSource`, `PCM_CHUNK_FRAMES`, `pcmFromChannels`, `audioBufferPcmSource`) → `packages/engine/src/export/`; `buildExportPayload` (butuh `StudioState`) tetap di studio. `ExportSink` (antarmuka) → `packages/platform/src/export-sink.ts` karena ia bagian `SaveTarget`; engine mengimpor tipenya (`engine → platform`, tipe saja) |
| `ui/` | `packages/ui/src/` | `ui/panels` mengimpor `state/` → dependensi `ui → engine` (searah, boleh) |
| `app-shell/{command,keymap,keys,useCommands,CommandPalette,useKeyDispatch}` | `packages/shell/src/` | **P1 (aktual):** hanya registry + keymap + dispatch + palette. **P3:** `VersionTag.tsx` + `build-info.ts` (dibaca dj/roblox/studio), `KeymapEditor.tsx` (dipakai kedua AppShell), dan `routes.ts` (konstanta path, `Route`, `pathOf`, `makeRouteOf`) ikut ke shell; TABEL route tetap per app (`apps/*/src/app-shell/routes.ts` membangunnya dari daftar route yang ia punya). `AppShell.tsx` tetap milik tiap app |
| `app-shell/desktop.ts`, `menu-ids.ts` | `apps/desktop/src/window/` | menu native = pintu ketiga registry (docs/15), tetap |
| `platform/host.ts`, `useAudioFilePicker`, `useNativeFileDrop` | `packages/platform/src/` | kontrak |
| `platform/web.ts` | `apps/web/src/platform/` | |
| `platform/desktop.ts`, `local-invoke.ts`, `local-commands.ts` | `apps/desktop/src/platform/` | `local-commands` = tipe 50 command Tauri; tesnya (`contract_tests.rs` ↔ `LOCAL_COMMAND_NAMES`) ikut |
| `library/`, `local-error.ts` | `packages/library/src/library/`, `packages/library/src/local-error.ts` (**P3 aktual**) + `apps/desktop/src/library-local/` | `api.ts` utuh (kontrak + klien Worker: fetch ke Worker itu netral); `registry.ts` baru; `local-api.ts`, `store-settings.ts`, `StoreSettings.tsx` di desktop sejak P2. Tidak ada `apps/web/src/library-worker/` — klien Worker cukup didaftarkan `main.tsx` |
| `roblox/` | `packages/roblox/src/roblox/` + `apps/desktop/src/roblox-local/` | prop `platform: PlatformKind` yang hanya memilih TEKS jadi `variant: 'web' \| 'local'` (`ui-variant.ts`) — sifat backend yang disuntik, bukan platform |
| `soundcloud/` | `packages/soundcloud/src/soundcloud/` + `apps/desktop/src/soundcloud/desktop-transport.ts` | `studio-import.tsx` baru: `useSoundCloudImport()` untuk `extras` StudioPage |
| `youtube/` | `apps/desktop/src/youtube/` | seluruhnya desktop; mengimpor `@kelasmalam/studio` |
| `studio/`, `stem/`, `App.tsx` | `packages/studio/src/studio/`, `packages/studio/src/StudioPage.tsx` | `StudioPage` menerima `dock` + `extras`; `commands.ts` menerima `registerSaveFallback` dari dok (studio tidak mengimpor library). CSS Studio → `packages/studio/src/studio.css`. **P4:** `stem/` dan bagian studio yang tidak tahu lane pindah ke `studio-core` (baris berikut) |
| `studio/{model,store}` bagian aset; `studio/analysis/{beat-grid,grid-edit,tap-tempo,tempo-client}`; `studio/timeline/{envelope,wave-window,waveform,content-hash,sniff,url-import,import-sink,normalize,fade,fade-draw,beat-draw,ScrollingWave}`; `audio-import` bagian aset; `stem/*`; `preview/fx-node`; `fx/useFxCatalog`; `persist/{asset-roots,decode-asset}`; cache PCM + AudioContext dari `preview/audio-preview` | `packages/studio-core/src/{assets,analysis,timeline,stem,preview,fx,persist}/` (**P4**) | `assets/model.ts` (`StudioAsset`, `AssetTempo`, `Samples`, `FxInsert`, `FadeCurve`), `assets/store.ts` (`assetStore`/`assetActions`/`useAssets`), `assets/usage.ts` (registry pemakaian — studio mendaftarkan penghitung lane), `preview/audio-context.ts` (`ensureContext`, `registerBuffer`, `getBuffer`, `previewSampleRate`). `rail/fader.ts` → `packages/ui/src/lib/fader.ts` (matematika UI murni) |
| `dj/` | `packages/dj/src/dj/` | `CollectionBrowser` memakai hook kontrak, sudah benar. **P4:** `dj → studio-core`, nol impor `@kelasmalam/studio/` (dijaga `no-package-cycles`); pemakaian aset oleh clip dijawab registry `assets/usage.ts`, sample rate untuk decode dari `previewSampleRate()` |
| `proof-stem/` | `packages/proof-stem/src/proof-stem/` | satu paket (tanpa `stem/`, lihat baris studio); `onnxruntime-web.d.ts` ikut ke sini |
| `landing/`, `main.tsx`, `index.css`, `public/` | `apps/web/src/` | `index.css` app-level saja + `@import` CSS ui dan studio |
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
menjadi kontrak yang disuntik. `AppShell` tiap app menyusun `StudioPage`
dengan `dock` (LibraryDock), `extras` (SoundCloud; desktop + YouTube), dan
`main.tsx`-nya mendaftarkan `registerLibraryApi`, `registerRobloxBackend`,
`registerSoundCloudTransport`, `registerUrlImporter`.

Graf dependensi paket (dari `package.json`, dijaga `no-package-cycles`):

```
platform, ui → engine, engine → platform (tipe ExportSink saja)
shell → ui
proof-stem → platform, ui
studio-core → engine, ui, proof-stem                       (P4)
studio → studio-core, engine, ui, shell, platform, proof-stem
dj → studio-core, proof-stem, engine, ui, shell, platform  (P4: bukan studio)
library → studio, studio-core, dj, ui, shell, platform
roblox → ui, shell, platform, library (local-error)
soundcloud → studio, studio-core, ui, platform
```

Penyimpangan dari sasaran awal yang dicatat: `engine → platform` (tipe) ada
karena `ExportSink` adalah bagian `SaveTarget`; membaliknya berarti platform
bergantung pada engine, dan platform harus tinggal di dasar.

**Done (aktual, branch):**
1. `grep -rE "kind === 'desktop'|isTauri|localInvoke|@tauri-apps" packages/`
   kosong; `no-platform-leak` hijau untuk sepuluh paket; allowlist cabang
   `kind` di `no-desktop-leak` KOSONG (kini memindai `packages/*` juga).
2. Alias `@app-web/*` dihapus dari `tsconfig.base.json`, `workspace-aliases`,
   dan `dawAliases`; `app-web-imports.test.ts` menjaga string itu tidak ada
   di berkas ts/tsx/json/css mana pun di repo.
3. Semua tes lolos di lokasi baru; `export/*.test.ts` terbagi: yang murni
   pipeline ke engine, yang butuh `StudioState` (`run-export.test`, `parity`,
   `wasm-integration`, `worker-host`) tetap di studio. Tes `libraryApi` host
   → `registry.test.ts` (library); tes `modelBytes` host web →
   `model-bytes.test.ts` (proof-stem). `contract_tests.rs` membaca DTO dari
   path paket.
4. Web: perilaku identik (smoke test + tes shell); uji manual docs/09 M5–M8
   belum dijalankan ulang di branch ini.

### P4 — `studio-core`: lapisan yang tidak tahu lane

Rencana awal: ekstrak `model.ts` bagian asset/peaks, `timeline/` non-lane,
`analysis/`, `persist/decode-asset`, dan `stem/`; alihkan `dj/` ke
`studio-core`. Pipeline export SUDAH di `packages/engine/src/export/` sejak P3.

**Bentuk aktual (branch `feat/p4-studio-core`):**

```
packages/studio-core/src/
  assets/model.ts       StudioAsset, AssetTempo, TEMPO_UNCERTAIN, AssetMap, ImportStage,
                        Samples, FxInsert, FadeCurve, DEFAULT_FADE_CURVE, DEFAULT_SAMPLE_RATE
  assets/store.ts       assetStore / useAssets / assetActions (register, remove, tempo,
                        grid, anchor, lock, newAssetId, restoreAssets)
  assets/usage.ts       registerAssetUsage / assetUsage — studio mendaftarkan penghitung lane
  analysis/             beat-grid (+correctedBpm), grid-edit, tap-tempo, tempo-client
  timeline/             envelope, wave-window, waveform (+loopTileCount), content-hash, sniff,
                        url-import, import-sink, audio-import (byte → aset), normalize,
                        fade (generik atas field fade), fade-draw, beat-draw, ScrollingWave
  stem/                 auto-stem, auto-stem.worker, AutoStemToggle
  preview/              fx-node, audio-context (AudioContext + cache PCM, previewSampleRate)
  fx/useFxCatalog.ts
  persist/              asset-roots, decode-asset
```

Keputusan yang menyimpang dari rencana, dan alasannya:

- **Store aset terpisah, riwayat tetap milik project.** `assets` keluar dari
  `StudioAppState`; `studio/store.ts` MEMBACA `assetStore` dan BERLANGGANAN
  padanya: perubahan aset direkam sebagai langkah undo (snapshot gabungan
  `{project, assets}`) dan menaikkan `projectSerial`, persis perilaku sebelum
  pemisahan (`undo.test.ts` menjaganya). `hydrate` dan `__resetForTest` tetap
  satu pintu.
- **Yang tahu clip/lane tetap di studio** walau rencana menyebutnya:
  `stem.ts`, `stem-bake.ts`, `beat-cut`, `beat-pulse`, `clip-loop`,
  `clip-trim`, `clip-snap`, `library-drop` (punya `LaneLocator`),
  `lane-import`, `url-to-lane`, `playhead-tempo` (membaca lane; `correctedBpm`
  yang asset-murni pindah ke `beat-grid`), dan DAFTAR import job (bar progres
  per lane). `audio-import` dibelah: byte → aset di core, aset → clip di studio
  dengan nama berkas yang sama.
- **`ScrollingWave` tidak mengimpor pemutar mana pun**: jam transport dan jam
  audisi disuntikkan lewat prop (`positionSourceSec`, `auditionSourceSec`);
  `ClipPanels` menyuntikkan jam Studio, deck DJ jamnya sendiri.
- **`sampleRate` untuk `/dj`** datang dari `previewSampleRate()` core (milik
  AudioContext, atau `DEFAULT_SAMPLE_RATE`), bukan dari project Studio.
- **`rail/fader.ts` → `packages/ui/src/lib/fader.ts`** (taper + label dB,
  tanpa dependensi). **`fx-node` tinggal di core**, bukan engine, karena ia
  butuh `FxInsert`; memindahkannya ke engine berarti engine mengimpor model.
- `StudioHeader` dan `commands` TIDAK dipakai dj (DjHeader hanya meniru
  bentuknya) — keduanya tetap di studio.

**Done (aktual):**
1. `packages/dj/package.json` tanpa `@kelasmalam/studio`; `grep -rn
   "@kelasmalam/studio/" packages/dj/src` kosong — keduanya diasersi
   `no-package-cycles.test.ts`, bersama "studio-core tidak mengimpor
   studio/dj/library".
2. `packages/studio` (lane) berisi `StudioPage`, `model` (lane/clip), `store`
   (project + langganan aset), `shell/`, `rail/`, `fx/FxCard`, `timeline/`
   (ClipArea, LaneHeaders, ClipPanels, BeatSection, StemSection, clip-*,
   beat-cut/pulse, lane-import, url-to-lane, library-drop, stem, stem-bake,
   audio-import bagian lane), `preview/` (pemutar), `persist/persistence`,
   `commands`, `shortcuts/`, `export/{payload,worker-host}`.
3. Semua tes lolos di lokasi baru; tes baru: `assets/store.test`,
   `assets/usage.test` (core), `asset-usage.test` (studio mendaftarkan
   penghitung lane), lima kasus aset di `undo.test`. Ini gerbang docs/24 F0.

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
