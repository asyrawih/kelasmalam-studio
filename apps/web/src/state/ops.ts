/**
 * Tabel opcode — SEKARANG HANYA RE-EXPORT.
 *
 * Versi pertama file ini berisi salinan `enum Op` sendiri, ditulis saat
 * `web/src/audio/` belum ada. Sekarang opcode hidup di `audio/sab-layout.ts`
 * dan diverifikasi terhadap Rust lewat `assertLayout()`. Dua tabel opcode di
 * satu repo adalah cara paling pasti untuk mendapatkan bug "command benar,
 * nomor salah", jadi salinan itu dihapus alih-alih dipelihara.
 *
 * UI tidak menulis ring secara langsung sama sekali — ia memanggil metode
 * `EngineClient` lewat `useEngineCommands()`. Re-export ini ada untuk kode yang
 * perlu MEMBACA nomor op (mis. label debug), bukan untuk mengirim.
 */

export { OP, TRANSPORT, type OpCode, type TransportState } from '../audio/sab-layout';
