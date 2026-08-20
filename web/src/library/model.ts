/**
 * Model kepustakaan sisi web — tipe + yang bisa dijawab tanpa React dan tanpa
 * jaringan.
 *
 * Bentuknya mengikuti balasan Worker kepustakaan (`backend/src/library`), bukan
 * bentuk internal store Studio. Yang menyeberangi jaringan dan yang hidup di
 * memori sengaja dibedakan: `hash` adalah identitas yang bertahan selamanya,
 * `assetId` numerik hanya berlaku satu sesi (docs/16 §2). Peta di antara
 * keduanya dibangun ulang tiap sesi — dan `LibraryState.loaded` adalah peta itu.
 */

/** Satu lagu di kepustakaan, apa adanya dari `GET /tracks`. */
export interface LibraryTrack {
  readonly hash: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  /** 0 kalau server tidak tahu — lagu yang di-commit sebelum durasinya diukur. */
  readonly frames: number;
  readonly sampleRate: number;
  /** Cue DJ + grid. Bentuknya milik pemakainya; kepustakaan tidak menafsirkan. */
  readonly marks: unknown;
}

export interface LibraryUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/**
 * Keadaan sambungan, dan kenapa ada EMPAT.
 *
 * Menggabungkan "belum tahu" dengan "belum login" adalah cara tercepat membuat
 * dock berkedip: sepersekian detik pertama tiap muat halaman akan menampilkan
 * ajakan login kepada user yang sebetulnya sudah login. Dan menggabungkan
 * "tidak dikonfigurasi" dengan "gagal" menyembunyikan bedanya antara build yang
 * memang tanpa backend dan Worker yang sedang mati.
 */
export type LibraryStatus =
  | 'tidak-dikonfigurasi'
  | 'memeriksa'
  | 'anonim'
  | 'masuk'
  | 'gagal';

/** Satu unggahan yang sedang berjalan atau baru saja gagal. */
export interface UploadState {
  readonly name: string;
  /**
   * `memeriksa` — menanyakan apakah byte-nya sudah ada (dedup)
   * `mengunggah` — byte-nya sedang naik; `percent` berarti
   * `mencatat` — byte sudah ada, tinggal klaimnya ditulis
   * `gagal` — berhenti; `error` menyebutkan sebabnya
   */
  readonly phase: 'memeriksa' | 'mengunggah' | 'mencatat' | 'gagal';
  readonly percent: number;
  readonly error: string | null;
}

/** Project yang sedang dibuka/tersimpan di sesi ini. */
export interface OpenProject {
  readonly id: string;
  readonly name: string;
  /**
   * Versi yang dipegang tab INI.
   *
   * Dikirim sebagai `If-Match` tiap simpan. Kalau server menolak, berarti ada
   * yang menyimpan project ini di tempat lain — dan user DIBERI TAHU, bukan
   * tulisannya dibuang diam-diam (docs/16 §8c).
   */
  readonly version: number;
}

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly version: number;
}

export interface LibraryState {
  readonly status: LibraryStatus;
  readonly user: LibraryUser | null;
  readonly tracks: readonly LibraryTrack[];
  /** Pesan galat terakhir, apa adanya. `null` kalau tidak ada. */
  readonly error: string | null;
  /** Dock terlipat jadi satu strip. */
  readonly collapsed: boolean;
  /** Sedang mengambil daftar. */
  readonly listing: boolean;
  /**
   * `hash → assetId` untuk lagu yang SUDAH mendarat di sesi ini.
   *
   * Inilah peta yang docs/16 §2 sebut "dibangun ulang tiap sesi". Ia juga yang
   * membuat klik kedua pada lagu yang sama tidak mengunduh 25 MB lagi.
   */
  readonly loaded: Readonly<Record<string, number>>;
  /** `hash → 0..100` untuk yang sedang diunduh. */
  readonly loading: Readonly<Record<string, number>>;
  /**
   * `hash → keadaan unggah`.
   *
   * Terpisah dari `loading` walau keduanya "sedang sibuk": arah dan artinya
   * berbeda, dan satu lagu bisa saja diunduh di satu tab sementara diunggah di
   * tab lain. Menggabungkannya berarti bar yang sama menampilkan dua hal.
   */
  readonly uploads: Readonly<Record<string, UploadState>>;
  /** Tab dok yang sedang tampil. */
  readonly tab: 'lagu' | 'project';
  readonly projects: readonly ProjectRow[];
  /** `null` = belum pernah disimpan di sesi ini. */
  readonly openProject: OpenProject | null;
  /** Kabar hasil perbuatan terakhir (simpan/buka/hapus), untuk dipajang. */
  readonly notice: string | null;
  /** Folder project yang sedang terbuka di pohon. */
  readonly expanded: Readonly<Record<string, boolean>>;
  /**
   * Hash lagu yang dipakai tiap project — diambil SAAT foldernya dibuka.
   *
   * `GET /projects` hanya mengembalikan nama dan versi; isinya tidak ikut,
   * dan itu benar: satu project bisa berukuran megabyte, dan menariknya
   * semua hanya untuk menggambar daftar berarti membayar seluruh kepustakaan
   * untuk melihat judulnya.
   *
   * `'memuat'` dibedakan dari daftar kosong: folder yang isinya sedang diambil
   * bukan folder yang kosong.
   */
  readonly projectTracks: Readonly<Record<string, readonly string[] | 'memuat'>>;
}

export function createInitialLibrary(): LibraryState {
  return {
    status: 'tidak-dikonfigurasi',
    user: null,
    tracks: [],
    error: null,
    // Terlipat saat pertama muncul: ini permukaan kerja DAW, dan panel yang
    // memakan sepertiga layar sebelum diminta adalah panel yang salah.
    collapsed: true,
    listing: false,
    loaded: {},
    loading: {},
    uploads: {},
    tab: 'lagu',
    projects: [],
    openProject: null,
    notice: null,
    /*
     * "Tanpa project" terbuka sejak awal.
     *
     * Ke situlah lagu yang baru diunggah mendarat, dan folder yang terlipat
     * membuat unggahan yang BERHASIL tampak seperti tidak terjadi apa-apa —
     * dok terbuka, daftarnya kosong, dan tidak ada yang menunjukkan bahwa
     * isinya ada satu klik di bawah.
     */
    expanded: { __loose: true },
    projectTracks: {},
  };
}

/** `4.7 MB`. Basis 1024, sama dengan angka batas yang dipakai server. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * `3:07` dari frames + sampleRate. `—` kalau server tidak tahu.
 *
 * Nol diperlakukan sebagai tidak tahu, BUKAN sebagai nol detik: lagu berdurasi
 * nol tidak ada, dan menampilkan `0:00` untuk metadata yang hilang membuat
 * daftar terlihat seperti berisi berkas rusak.
 */
export function formatDuration(frames: number, sampleRate: number): string {
  if (frames <= 0 || sampleRate <= 0) return '—';
  const total = Math.round(frames / sampleRate);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Ringkasan untuk strip terlipat: "12 LAGU · 340.2 MB". */
export function summarize(tracks: readonly LibraryTrack[]): string {
  if (tracks.length === 0) return 'KOSONG';
  const bytes = tracks.reduce((sum, t) => sum + t.bytes, 0);
  return `${tracks.length} LAGU · ${formatBytes(bytes)}`;
}
