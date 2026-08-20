/**
 * Membaca dan MEMVALIDASI ULANG satu permintaan unggah.
 *
 * Validasi di UI adalah bantuan untuk user; yang di sini adalah penjaga. Semua
 * yang sampai ke `createAudioAsset` sudah lolos berkas ini, apa pun yang
 * dipercaya pengirimnya tentang dirinya sendiri.
 *
 * Satu batas sengaja TIDAK ditegakkan: durasi 7 menit. Mengukurnya berarti
 * mendekode audio di dalam Worker — puluhan MB PCM dan waktu CPU — untuk
 * menjawab pertanyaan yang toh akan dijawab Roblox beberapa detik kemudian.
 * Yang dijaga UI (dengan `<audio>`, gratis) adalah kenyamanan; yang menolak
 * sungguhan adalah Roblox.
 */

import { AUDIO_EXTS, MAX_BYTES, MAX_DESC_LEN, MAX_NAME_LEN, MIME_OF, extOf } from './limits';
import type { CreateAudioInput } from './open-cloud';

export type ParseResult =
  | { readonly ok: true; readonly value: CreateAudioInput }
  | { readonly ok: false; readonly code: string; readonly message: string };

const bad = (code: string, message: string): ParseResult => ({ ok: false, code, message });

/** Ambil string dari FormData, atau `''` kalau bukan string/absen. */
function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export async function parseUpload(request: Request): Promise<ParseResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return bad('BUKAN_MULTIPART', 'kirim sebagai multipart/form-data dengan bagian `file`');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err: unknown) {
    return bad('MULTIPART_RUSAK', `badan permintaan tidak bisa dibaca: ${String(err)}`);
  }

  const file = form.get('file');
  // `instanceof File` sengaja TIDAK dipakai: di sebagian runtime bagian
  // multipart datang sebagai Blob tanpa nama, dan pemeriksaan yang lebih ketat
  // dari kebutuhan menolak permintaan yang sebenarnya sah.
  if (file === null || typeof file === 'string') {
    return bad('FILE_HILANG', 'bagian `file` tidak ada di badan permintaan');
  }

  const fileName = 'name' in file && typeof file.name === 'string' && file.name !== ''
    ? file.name
    : field(form, 'fileName');
  if (fileName === '') return bad('NAMA_BERKAS_HILANG', 'nama berkas tidak ikut terkirim');

  const ext = extOf(fileName);
  if (!AUDIO_EXTS.includes(ext)) {
    return bad('FORMAT', `format ${ext === '' ? '?' : ext} tidak didukung — pakai MP3 atau OGG`);
  }

  if (file.size > MAX_BYTES) {
    return bad('UKURAN', `berkas ${file.size} byte melewati batas ${MAX_BYTES} byte`);
  }
  if (file.size === 0) return bad('KOSONG', 'berkasnya kosong');

  const name = field(form, 'name').trim();
  if (name === '') return bad('NAMA_KOSONG', 'nama asset wajib diisi');
  if (name.length > MAX_NAME_LEN) {
    return bad('NAMA_PANJANG', `nama ${name.length} karakter, maksimum ${MAX_NAME_LEN}`);
  }

  const description = field(form, 'description');
  if (description.length > MAX_DESC_LEN) {
    return bad('DESKRIPSI_PANJANG', `deskripsi ${description.length} karakter, maksimum ${MAX_DESC_LEN}`);
  }

  const creatorKind = field(form, 'creatorKind') === 'group' ? 'group' : 'user';
  const creatorId = field(form, 'creatorId').trim();
  if (!/^\d+$/.test(creatorId)) {
    return bad('PEMILIK', creatorId === '' ? 'ID pemilik belum diisi' : 'ID pemilik harus angka');
  }

  const bytes = await file.arrayBuffer();
  // Ukuran diperiksa DUA KALI — sebelum dan sesudah dibaca. `size` yang
  // dilaporkan bagian multipart tidak wajib jujur, dan yang menentukan biaya
  // memori Worker adalah byte yang benar-benar mendarat.
  if (bytes.byteLength > MAX_BYTES) {
    return bad('UKURAN', `berkas ${bytes.byteLength} byte melewati batas ${MAX_BYTES} byte`);
  }

  return {
    ok: true,
    value: {
      bytes,
      fileName,
      mime: MIME_OF[ext] ?? 'application/octet-stream',
      name,
      description,
      creatorKind,
      creatorId,
    },
  };
}
