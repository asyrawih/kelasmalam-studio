/**
 * Varian TEKS halaman Roblox. Dulu prop `platform: PlatformKind`, tapi yang
 * dibedakannya hanya kalimat: di mana kunci API tersimpan, kenapa unggah
 * belum siap, ada tidaknya kuota. Itu sifat BACKEND yang disuntik (lokal vs
 * Worker), bukan sifat platform — dan paket tidak boleh bertanya di mana ia
 * berjalan (docs/25 §1c).
 */
export type RobloxUiVariant = 'web' | 'local';
