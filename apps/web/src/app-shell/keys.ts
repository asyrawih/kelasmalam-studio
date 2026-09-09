/**
 * Chord keyboard: normalisasi, parse, format. MURNI — tidak menyentuh DOM.
 *
 * ## Kenapa `event.code`, bukan `event.key`
 *
 * `key` adalah KARAKTER yang dihasilkan, jadi ia bergeser mengikuti layout dan
 * modifier: `Shift+1` menghasilkan `!` di QWERTY-US tapi `+` di beberapa layout
 * Eropa, dan huruf jadi kapital saat Shift ditahan. Binding yang disimpan
 * sebagai karakter karena itu berhenti bekerja begitu user mengganti layout
 * keyboard — dan gejalanya "shortcut-nya hilang", tanpa petunjuk kenapa.
 *
 * `code` adalah POSISI FISIK tombol (`KeyQ`, `Digit1`, `Space`). Ia stabil
 * lintas layout, dan untuk alat pertunjukan itu yang benar: yang dihafal tangan
 * adalah letak tombol, bukan huruf yang tercetak di atasnya.
 *
 * Harganya: pada layout non-QWERTY, label yang kita tampilkan (`Q`) bisa
 * berbeda dari huruf yang tercetak di tombolnya. Itu sebabnya keymap-nya bisa
 * diubah user.
 *
 * ## Bentuk chord
 *
 * String yang bisa disimpan dan dibandingkan langsung, urutan modifier TETAP
 * supaya `ctrl+shift+KeyK` dan `shift+ctrl+KeyK` tidak pernah jadi dua entri
 * berbeda untuk tombol yang sama:
 *
 *   `mod+alt+shift+KeyK`
 *
 * `mod` adalah Cmd di macOS dan Ctrl di tempat lain — satu binding untuk
 * keduanya, karena "tombol perintah" memang satu konsep yang sama.
 */

export type Chord = string;

/** Urutan modifier di dalam chord. Tetap, dan disengaja. */
const ORDER = ['mod', 'alt', 'shift'] as const;

export interface ChordParts {
  readonly mod: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** `KeyboardEvent.code`, mis. `KeyQ`, `Digit1`, `Space`, `ArrowLeft`. */
  readonly code: string;
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function chordOf(e: KeyboardEvent): Chord {
  return formatChord({
    // Cmd di macOS, Ctrl di tempat lain. Satu konsep, satu binding.
    mod: isMac() ? e.metaKey : e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    code: e.code,
  });
}

export function formatChord(p: ChordParts): Chord {
  const parts: string[] = [];
  for (const m of ORDER) if (p[m]) parts.push(m);
  parts.push(p.code);
  return parts.join('+');
}

export function parseChord(chord: Chord): ChordParts {
  const bits = chord.split('+');
  const code = bits.pop() ?? '';
  const has = (m: string): boolean => bits.includes(m);
  return { mod: has('mod'), alt: has('alt'), shift: has('shift'), code };
}

/**
 * Chord yang tidak boleh diikat ke command.
 *
 * `mod+R` (muat ulang), `mod+W` (tutup tab), `mod+T`, `F5`, `F12` — merampasnya
 * berarti user terkurung di dalam aplikasi. Beberapa bahkan tidak bisa dicegah
 * oleh halaman sama sekali, jadi mengizinkannya di keymap hanya menghasilkan
 * binding yang tidak pernah menyala dan tidak bisa dijelaskan.
 */
const RESERVED = new Set<Chord>([
  'mod+KeyR',
  'mod+shift+KeyR',
  'mod+KeyW',
  'mod+KeyT',
  'mod+KeyN',
  'mod+KeyQ',
  'F5',
  'F11',
  'F12',
]);

export function isReservedChord(chord: Chord): boolean {
  return RESERVED.has(chord);
}

/** Label yang enak dibaca: `⌘K`, `Ctrl+K`, `Shift+1`, `Space`. */
export function chordLabel(chord: Chord, mac = isMac()): string {
  const p = parseChord(chord);
  const out: string[] = [];
  if (p.mod) out.push(mac ? '⌘' : 'Ctrl');
  if (p.alt) out.push(mac ? '⌥' : 'Alt');
  if (p.shift) out.push(mac ? '⇧' : 'Shift');
  out.push(codeLabel(p.code));
  return mac ? out.join('') : out.join('+');
}

/** `KeyQ` → `Q`, `Digit1` → `1`, `Semicolon` → `;`, `ArrowLeft` → `←`. */
export function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const named: Readonly<Record<string, string>> = {
    Space: 'Space',
    Enter: '↵',
    Escape: 'Esc',
    Tab: '⇥',
    Backspace: '⌫',
    Delete: 'Del',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '−',
    Equal: '=',
    Backquote: '`',
  };
  return named[code] ?? code;
}

/**
 * True kalau tombol ini sedang MENGAKTIFKAN kontrol yang lagi fokus.
 *
 * Space dan Enter bukan milik kita saat fokus ada di tombol atau tautan: itu
 * cara keyboard menekan sesuatu. Merampasnya berarti seluruh halaman berhenti
 * bisa dipakai tanpa tetikus — dan gejalanya tidak terlihat sama sekali oleh
 * siapa pun yang memakai tetikus, jadi ia bisa hidup lama sekali.
 *
 * Hanya berlaku untuk chord POLOS: `mod+Enter` tidak mengaktifkan apa pun, jadi
 * ia tetap boleh jadi shortcut.
 */
export function activatesFocusedControl(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return false;

  const el = e.target instanceof HTMLElement ? e.target : document.activeElement;
  if (!(el instanceof HTMLElement)) return false;

  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true;
  const role = el.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'option';
}

/**
 * True kalau event berasal dari tempat MENGETIK.
 *
 * Tanpa ini, mengetik "q" di kotak pencarian Collection akan memutar deck A —
 * dan huruf yang diketik tidak pernah sampai ke kotaknya. Itu bukan pengecualian
 * yang mengurangi shortcut; itu yang membuat shortcut tidak merusak fitur lain.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
