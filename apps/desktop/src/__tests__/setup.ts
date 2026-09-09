/**
 * Setup vitest app desktop = setup app web (canvas mock, `ResizeObserver`,
 * stub Pointer Capture). Diimpor, bukan disalin: kedua app merender komponen
 * yang sama dari `@kelasmalam/ui` dan (sementara) `@app-web/*`, jadi lubang
 * jsdom yang ditambal di sana harus tertambal di sini juga — otomatis.
 */
import '../../../web/src/__tests__/setup';
