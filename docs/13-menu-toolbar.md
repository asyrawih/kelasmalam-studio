# 13 — Toolbar menu (ikon + popup)

Semuanya sisi TypeScript. Tidak ada crate, dependency, atau build WASM baru.

---

## Kenapa

Studio ini tumbuh sampai punya kontrol untuk grid, loop, potong, stem, fade,
mixer, EQ, master, dan export. Sebelumnya semuanya terlihat sekaligus — kartu
Clip Detail di kolom kiri, rail di kolom kanan — dan akibatnya permukaan kerja
yang sebenarnya, TIMELINE, tinggal sepertiga layar. Setiap kontrol yang
ditambahkan berikutnya memakan bagiannya lagi.

Toolbar ikon memutus hubungan itu: **tingginya tetap berapa pun banyaknya menu.**

Sekarang kolom kerja hanya berisi timeline, selebar layar penuh.

---

## Bentuk

`shell/MenuBar.tsx` — bar `position: sticky; top: 0` berisi:

- **transport ringkas** di kiri (`shell/TransportButtons.tsx`), SELALU terlihat;
- deret ikon menu, masing-masing membuka satu popup.

`StudioLayout` sengaja tidak memberi body-nya scroller sendiri: dokumen yang
menggulir, dan `sticky` bekerja terhadapnya. Memberi body `overflow: auto` akan
mematikan sticky tanpa gejala lain selain "toolbar-nya tidak menempel".

### Aturan popup

- **Hanya SATU terbuka** (`StudioAppState.openMenu`, satu slot bukan himpunan).
  Beberapa popup sekaligus akan menutupi permukaan kerja yang justru sedang
  dilihat.
- Klik di luar, **Esc**, atau menekan ikonnya lagi menutupnya.
- Penutupan mendengarkan `pointerdown`, bukan `click`: menekan tombol di dalam
  timeline sudah memulai gerakannya (drag clip, kotak seleksi) pada pointerdown,
  jadi menunggu `click` berarti popup masih menutupi tempat yang sedang ditarik.
- Popup berjangkar di bawah ikonnya dan **dijepit ke tepi kanan** setelah layout,
  supaya menu paling kanan tidak terpotong.
- `openMenu` **tidak disimpan**, alasan yang sama dengan `maximizedPanel`:
  membuka aplikasi dan langsung mendapati popup menutupi timeline, tanpa ingat
  pernah membukanya, membingungkan.

### Transport tidak ikut bersembunyi

PLAY ditekan setiap beberapa detik sepanjang sesi. Perintah sesering itu tidak
boleh butuh dua klik, jadi PLAY / ⏮ / loop / waktu duduk langsung di toolbar.
Sisanya (skip ±5 s, preset kecepatan) tetap di menu TRANSPORT.

---

## Isi menu

`shell/StudioMenus.tsx` SENGAJA hanya merakit — semua isinya komponen yang sudah
ada, dipakai apa adanya. Memindahkan panel ke dalam menu tidak boleh berarti
menulis ulang kontrolnya; kalau ditulis ulang, dua salinan akan berbeda perilaku
dan tidak ada yang menyadarinya.

Pengelompokannya berdasarkan **apa yang disentuh**:

| Ikon | Menu | Isi | Cakupan |
|---|---|---|---|
| ♩ | BEAT | BPM, ×2/÷2, downbeat, AUTO | satu clip |
| ⟳ | LOOP | waveform + zoom + panjang loop + LOOP PLAY + LOOP CUT | satu clip |
| ▤ | CLIP | TRIM, NORMALIZE, SPLIT, fade, curve | satu clip |
| ⧉ | STEM | buang vokal/bass/instrumen, BAKE | satu clip |
| ⇅ | MIX | fader lane | project |
| ∿ | EQ | equalizer lane terpilih | project |
| ⬆ | MASTER | amplify + kecepatan render | project |
| ⤓ | EXPORT | compile | project |
| ▶ | TRANSPORT | skip, loop, preset kecepatan | alat |
| ? | HELP | daftar shortcut | alat |

Tiap menu yang mengubah SATU clip dibuka dengan `ClipHeader` — popup yang
mengedit sesuatu tanpa menyebut apa yang diedit adalah cara paling mudah membuat
orang mengubah clip yang salah.

`BeatControls` mendapat prop `groups` supaya GRID bisa tampil di menu BEAT dan
VIEW/LOOP/CUT di menu LOOP, **tetap dari satu komponen**.

---

## Clip Detail dipecah

`timeline/ClipDetailPanel.tsx` → `timeline/ClipPanels.tsx`, dan kartunya hilang.
Yang tersisa tiga bagian yang berdiri sendiri (semuanya mengambil clip yang
dipajang dari `BeatProvider`, jadi tanpa satu pun prop):

| Komponen | Isi | Dipakai di |
|---|---|---|
| `ClipHeader` | nama clip, lane, durasi, penanda seleksi | menu BEAT/LOOP/CLIP/STEM |
| `ClipWavePanel` | waveform, grid, jendela geser, tarik-untuk-menaruh-loop, handle fade | menu LOOP |
| `ClipEditPanel` | TRIM/NORMALIZE/SPLIT + fade + curve | menu CLIP |

Waveform ikut ke dalam popup, bukan menempel permanen: menarik loop adalah
pekerjaan sesaat, dan 150 px yang menetap sepanjang sesi adalah harga mahal
untuk sesuatu yang dipakai sebentar.

Ikut terhapus karena tidak punya pemakai lagi: `DetailSection.tsx`,
`StudioAppState.clipDetailSections`, dan `BeatBar.tsx` (bar BEAT & LOOP yang
sempat berdiri sendiri sebelum toolbar ini ada).

---

## Peta berkas

| Berkas | Isi |
|---|---|
| `web/src/studio/shell/MenuBar.tsx` | toolbar sticky + popup berjangkar |
| `web/src/studio/shell/StudioMenus.tsx` | definisi tiap menu (perakit saja) |
| `web/src/studio/shell/TransportButtons.tsx` | transport ringkas yang selalu terlihat |
| `web/src/studio/timeline/ClipPanels.tsx` | ClipHeader / ClipWavePanel / ClipEditPanel |
| `web/src/studio/shell/menu-bar.test.tsx` | satu-popup, tutup, isi tiap menu |
