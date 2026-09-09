/**
 * Setup vitest app desktop = setup app web (canvas mock, `ResizeObserver`,
 * stub Pointer Capture, host web sebagai resolver BAWAAN). Diimpor, bukan
 * disalin: kedua app merender komponen yang sama dari `@kelasmalam/*`, jadi
 * lubang jsdom yang ditambal di sana harus tertambal di sini juga — otomatis.
 * Host bawaan web-nya tidak mengganggu: `./platform` app ini mendaftarkan
 * resolver APP, yang selalu menang.
 */
import '../../../web/src/__tests__/setup';
