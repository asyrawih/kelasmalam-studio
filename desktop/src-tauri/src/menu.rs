//! Menu native — pintu ketiga ke registry command (docs/15, docs/20 §2d).
//!
//! Menu ini TIDAK punya daftar aksi sendiri. Tiap item yang memicu sesuatu di
//! aplikasi hanya mengirim event `daw://menu-command` berisi id command
//! registry, dan shell di sisi web men-dispatch-nya persis seperti ketukan
//! keyboard atau palette ⌘K. Konsekuensinya:
//!
//!   - id di sini HARUS ada di registry (`web/src/app-shell` + halaman).
//!     Id yang tidak ada bukan error di Rust — ia cuma item menu yang diam
//!     saat diklik, dan itu lebih buruk daripada error. Daftar di `MENUS`
//!     sengaja disalin dari registrasi yang sungguhan ada, bukan dari apa
//!     yang "seharusnya" ada. Tes D5 di sisi web menjaga ⊆ registry.
//!   - command yang terdaftar oleh HALAMAN (`dj.*`, `library.toggle`) tidak
//!     berarti apa-apa di halaman lain; `runCommand()` mengembalikan false dan
//!     tidak terjadi apa-apa. Menu Transport karena itu hanya berisi `dj.*`:
//!     Studio belum mendaftarkan command transport/undo/save ke registry, dan
//!     mengarang `studio.undo` di sini tidak akan membuatnya ada.
//!
//! Item yang murni urusan OS (Quit, Hide, Cut/Copy/Paste, Fullscreen) memakai
//! `PredefinedMenuItem`: perilakunya sudah benar per-platform dan tidak butuh
//! satu baris pun di web.
//!
//! Akselerator hanya dipasang pada kombinasi ber-modifier (⌘,  ⌘K). Menu
//! native menangkap tombol SEBELUM WebView melihatnya, jadi memasang `Space`
//! di sini akan merampasnya dari setiap input teks di aplikasi. Keymap yang
//! bisa diubah user tetap hidup di web; akselerator di sini hanyalah cermin
//! binding bawaan untuk dua command yang secara konvensi memang milik menu.

use serde::Serialize;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_opener::OpenerExt;

/// Label jendela utama di `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";

/// Nama event yang didengarkan shell web. Ini SATU-SATUNYA kontrak dengan
/// sisi web: nama event + payload `{ "id": string }`.
pub const MENU_COMMAND_EVENT: &str = "daw://menu-command";

/// Situs web — dibuka di browser OS, bukan di WebView aplikasi (docs/20 §2c).
const SITE_URL: &str = "https://studio.kelasmalam.app";

/// Payload `daw://menu-command`.
#[derive(Debug, Clone, Serialize)]
pub struct MenuCommand {
    pub id: String,
}

/// Satu baris menu yang memicu command registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandItem {
    /// Id command registry — lihat catatan modul.
    pub id: &'static str,
    /// Label yang ditampilkan OS.
    pub label: &'static str,
    /// Akselerator native, atau `None` (keymap web yang mengurus).
    pub accelerator: Option<&'static str>,
}

const fn item(id: &'static str, label: &'static str) -> CommandItem {
    CommandItem {
        id,
        label,
        accelerator: None,
    }
}

const fn item_with_key(
    id: &'static str,
    label: &'static str,
    accelerator: &'static str,
) -> CommandItem {
    CommandItem {
        id,
        label,
        accelerator: Some(accelerator),
    }
}

// Sengaja `const` per-menu, bukan dibangun inline di `install()`: tes unit
// harus bisa memeriksa daftar id-nya tanpa membuat `App` (yang butuh event
// loop OS dan tidak bisa dibuat di `cargo test`).
const APP_ITEMS: &[CommandItem] = &[item_with_key(
    "shell.preferences",
    "Preferensi…",
    "CmdOrCtrl+,",
)];

const VIEW_ITEMS: &[CommandItem] = &[
    item("library.toggle", "Kepustakaan"),
    item("shell.goto.home", "Beranda"),
    item("shell.goto.studio", "Studio"),
    item("shell.goto.dj", "Mixer DJ"),
    item("shell.goto.roblox", "Unggah Roblox"),
    item("shell.goto.proof-stem", "Proof Stem"),
];

const TRANSPORT_ITEMS: &[CommandItem] = &[
    item("dj.focused.playPause", "Putar / Jeda deck yang fokus"),
    item("dj.focus.toggle", "Pindah fokus deck"),
    item("dj.deckA.playPause", "Putar / Jeda deck A"),
    item("dj.deckB.playPause", "Putar / Jeda deck B"),
    item("dj.crossfader.center", "Crossfader ke tengah"),
    item("dj.fx.toggle", "Beat FX nyala / mati"),
    item("dj.grid.toggle", "GRID EDIT — buka / tutup"),
    item("dj.grid.undo", "Batalkan suntingan grid"),
    item("dj.grid.redo", "Ulangi suntingan grid"),
];

const HELP_ITEMS: &[CommandItem] = &[
    item_with_key("shell.palette", "Daftar Perintah…", "CmdOrCtrl+K"),
    item("shell.keymap", "Pintasan Keyboard"),
];

/// Seluruh item command dari semua menu — sumber tunggal untuk tes dan untuk
/// siapa pun yang perlu tahu "id apa saja yang dikirim menu".
pub const MENU_COMMANDS: &[&[CommandItem]] = &[APP_ITEMS, VIEW_ITEMS, TRANSPORT_ITEMS, HELP_ITEMS];

/// Id item native yang bukan command registry. Diberi awalan `native:` supaya
/// tidak mungkin tertukar dengan id registry (yang dipisah titik, bukan
/// titik dua) — handler event cukup mencocokkan awalan.
const NATIVE_OPEN_SITE: &str = "native:open-site";

/// Pasang menu ke aplikasi dan daftarkan handler event-nya.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    app.set_menu(menu)?;
    app.on_menu_event(on_menu_event);
    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    // Menu pertama di macOS adalah menu aplikasi (nama app sebagai judul).
    // Di Windows ia tampil sebagai menu biasa berjudul nama app — Quit di
    // sana jadi satu-satunya jalan keluar lewat menu, dan itu yang diharapkan
    // pengguna Windows dari menu bernama aplikasi.
    let about = AboutMetadata {
        name: Some("KELAS MALAM STUDIO".into()),
        website: Some(SITE_URL.into()),
        ..Default::default()
    };
    let mut app_menu = SubmenuBuilder::new(app, "KELAS MALAM STUDIO")
        .about(Some(about))
        .separator();
    app_menu = add_items(app, app_menu, APP_ITEMS)?;
    let app_menu = app_menu
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // File: belum ada command project (buka/simpan) di registry — mengarang
    // `studio.save` di sini tidak membuatnya ada. Yang tersisa hanya urusan
    // jendela; menunya tetap ada supaya posisinya tidak berpindah saat D-fase
    // berikutnya mengisinya.
    let file_menu = SubmenuBuilder::new(app, "File").close_window().build()?;

    // Edit: seluruhnya bawaan OS. Undo/Redo di sini adalah undo TEKS (input
    // yang sedang fokus), bukan undo timeline — yang itu milik registry dan
    // belum terdaftar oleh Studio.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let mut view_menu = SubmenuBuilder::new(app, "Tampilan");
    view_menu = add_items(app, view_menu, &VIEW_ITEMS[..1])?;
    view_menu = view_menu.separator();
    view_menu = add_items(app, view_menu, &VIEW_ITEMS[1..])?;
    let view_menu = view_menu.separator().fullscreen().build()?;

    let mut transport_menu = SubmenuBuilder::new(app, "Transport");
    transport_menu = add_items(app, transport_menu, &TRANSPORT_ITEMS[..2])?;
    transport_menu = transport_menu.separator();
    transport_menu = add_items(app, transport_menu, &TRANSPORT_ITEMS[2..4])?;
    transport_menu = transport_menu.separator();
    transport_menu = add_items(app, transport_menu, &TRANSPORT_ITEMS[4..6])?;
    transport_menu = transport_menu.separator();
    transport_menu = add_items(app, transport_menu, &TRANSPORT_ITEMS[6..])?;
    let transport_menu = transport_menu.build()?;

    let window_menu = SubmenuBuilder::new(app, "Jendela")
        .minimize()
        .maximize()
        .build()?;

    let mut help_menu = SubmenuBuilder::new(app, "Bantuan");
    help_menu = add_items(app, help_menu, HELP_ITEMS)?;
    let help_menu = help_menu
        .separator()
        .item(&MenuItemBuilder::with_id(NATIVE_OPEN_SITE, "Situs KELAS MALAM STUDIO").build(app)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &transport_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}

fn add_items<'a, R: Runtime>(
    app: &AppHandle<R>,
    mut menu: SubmenuBuilder<'a, R, AppHandle<R>>,
    items: &[CommandItem],
) -> tauri::Result<SubmenuBuilder<'a, R, AppHandle<R>>> {
    for it in items {
        let mut b = MenuItemBuilder::with_id(it.id, it.label);
        if let Some(acc) = it.accelerator {
            b = b.accelerator(acc);
        }
        menu = menu.item(&b.build(app)?);
    }
    Ok(menu)
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == NATIVE_OPEN_SITE {
        // Link keluar ke browser OS. Gagal membuka (tidak ada browser
        // default?) bukan alasan aplikasi mati; cukup dicatat.
        if let Err(e) = app.opener().open_url(SITE_URL, None::<&str>) {
            eprintln!("menu: gagal membuka {SITE_URL}: {e}");
        }
        return;
    }
    // Item bawaan (Quit, Cut, …) ditangani OS dan tidak pernah sampai ke sini
    // dengan id kita; yang tersisa adalah command registry.
    if let Some(cmd) = lookup(id) {
        if let Err(e) = app.emit(
            MENU_COMMAND_EVENT,
            MenuCommand {
                id: cmd.id.to_owned(),
            },
        ) {
            eprintln!("menu: gagal mengirim {MENU_COMMAND_EVENT} untuk {id}: {e}");
        }
    }
}

/// Cari item command berdasarkan id. `None` untuk id yang bukan milik kita.
fn lookup(id: &str) -> Option<&'static CommandItem> {
    MENU_COMMANDS
        .iter()
        .flat_map(|m| m.iter())
        .find(|c| c.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn all_ids() -> Vec<&'static str> {
        MENU_COMMANDS
            .iter()
            .flat_map(|m| m.iter())
            .map(|c| c.id)
            .collect()
    }

    /// Dua item dengan id yang sama akan mengirim command yang sama dari dua
    /// tempat — dan lebih buruk, muda menolak id ganda saat build menu di
    /// beberapa platform. Ditangkap di sini, bukan saat aplikasi dibuka.
    #[test]
    fn menu_ids_unique() {
        let ids = all_ids();
        let set: HashSet<&str> = ids.iter().copied().collect();
        assert_eq!(ids.len(), set.len(), "id menu ganda: {ids:?}");
    }

    /// Bentuk id registry (docs/15): `segmen.segmen[.segmen]`, tanpa spasi,
    /// tiap segmen alfanumerik atau `-`. Salah ketik seperti `shell palette`
    /// tidak akan pernah cocok dengan apa pun di registry, dan diam-diam jadi
    /// item yang tidak berbuat apa-apa.
    #[test]
    fn menu_ids_are_dotted_segments() {
        for id in all_ids() {
            let segs: Vec<&str> = id.split('.').collect();
            assert!(segs.len() >= 2, "{id}: butuh minimal dua segmen");
            for s in &segs {
                assert!(!s.is_empty(), "{id}: segmen kosong");
                assert!(
                    s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
                    "{id}: segmen `{s}` mengandung karakter di luar [A-Za-z0-9-]"
                );
            }
        }
    }

    /// `lookup` adalah jalur yang dipakai handler event; kalau ia gagal untuk
    /// id yang ada, item menu jadi bisu tanpa error apa pun.
    #[test]
    fn lookup_finds_every_item_and_rejects_native_ids() {
        for id in all_ids() {
            assert!(lookup(id).is_some(), "{id} tidak ditemukan");
        }
        assert!(lookup(NATIVE_OPEN_SITE).is_none());
        assert!(lookup("").is_none());
    }

    /// Akselerator hanya untuk kombinasi ber-modifier — lihat catatan modul.
    #[test]
    fn accelerators_always_have_modifier() {
        for c in MENU_COMMANDS.iter().flat_map(|m| m.iter()) {
            if let Some(acc) = c.accelerator {
                assert!(
                    acc.contains('+'),
                    "{}: akselerator `{acc}` tanpa modifier akan merampas tombol dari WebView",
                    c.id
                );
            }
        }
    }
}
