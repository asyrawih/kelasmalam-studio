/**
 * Satu pintu "pilih berkas audio" untuk semua komponen import.
 *
 * Web: `<input type="file">` tersembunyi yang di-`click()` — satu-satunya cara
 * membuka picker yang jalan di semua browser, dan ia HARUS ada di DOM (tes juga
 * mengisinya lewat `change`). Desktop: dialog native lewat host, tidak ada
 * input sama sekali. Komponen cukup merender `{input}` dan memanggil `open()`;
 * ia tidak tahu, dan tidak perlu tahu, jalur mana yang aktif.
 */

import { useCallback, useRef, type JSX } from 'react';
import { getPlatformHost } from './index';

export interface AudioFilePickerOptions {
  readonly multiple?: boolean;
  /** Atribut `accept` untuk `<input>` web. */
  readonly accept?: string;
  /** Ekstensi tanpa titik untuk penyaring dialog native. */
  readonly extensions?: readonly string[];
  readonly ariaLabel?: string;
  /** Atribut `data-*` penanda untuk tes (mis. `data-lane-file-input`). */
  readonly dataAttr?: string;
}

export interface AudioFilePicker {
  readonly open: () => void;
  /** `null` kalau host punya dialog native — tidak ada yang perlu dirender. */
  readonly input: JSX.Element | null;
}

export function useAudioFilePicker(
  onFiles: (files: readonly File[]) => void,
  opts: AudioFilePickerOptions = {},
): AudioFilePicker {
  const host = getPlatformHost();
  const inputRef = useRef<HTMLInputElement>(null);
  // Selalu panggil handler TERBARU: komponen mengganti closure-nya tiap render,
  // sementara `open` di bawah sengaja stabil.
  const latest = useRef(onFiles);
  latest.current = onFiles;
  const { multiple = true, accept = 'audio/*', extensions, ariaLabel, dataAttr } = opts;
  const native = host.openAudioFiles?.bind(host) ?? null;

  const open = useCallback((): void => {
    if (native === null) {
      inputRef.current?.click();
      return;
    }
    void native({ multiple, extensions })
      .then((files) => {
        if (files.length > 0) latest.current(files);
      })
      .catch((e: unknown) => console.warn('[platform] dialog berkas gagal:', e));
  }, [native, multiple, extensions]);

  const input =
    native !== null ? null : (
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        aria-label={ariaLabel}
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Dikosongkan SEBELUM handler jalan: tanpa ini, memilih file yang
          // sama persis untuk kedua kalinya tidak memicu `change` sama sekali
          // — nilainya tidak berubah — dan bagi user itu terlihat seperti klik
          // yang tidak melakukan apa-apa.
          e.target.value = '';
          if (files.length > 0) latest.current(files);
        }}
        {...(dataAttr === undefined ? {} : { [dataAttr]: '' })}
      />
    );

  return { open, input };
}
