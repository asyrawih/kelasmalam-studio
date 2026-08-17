/**
 * Deklarasi tipe untuk paket encoder pihak ketiga yang tidak membawa `.d.ts`.
 * Sengaja minimal: bentuk lengkapnya di-cast di modul yang memakainya
 * (`mp3-lamejs.ts`, `ogg-vorbis.ts`) supaya permukaan yang kita andalkan
 * terlihat jelas di satu tempat.
 */

declare module 'vorbis-encoder-js' {
  const mod: unknown;
  export = mod;
}

declare module '@breezystack/lamejs' {
  const mod: unknown;
  export = mod;
}
