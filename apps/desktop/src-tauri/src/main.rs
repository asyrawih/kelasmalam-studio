// `windows_subsystem = "windows"` di rilis supaya Windows tidak membuka jendela
// konsol hitam di belakang aplikasi. Di debug konsol dibiarkan: stdout adalah
// satu-satunya tempat log Rust bisa dibaca tanpa debugger.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    daw_desktop_lib::run()
}
