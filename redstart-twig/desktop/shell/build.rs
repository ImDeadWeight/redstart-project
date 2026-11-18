fn main() {
    // tauri-build compiles build/icon.ico into the exe's icon resource (the
    // taskbar, title bar and Alt+Tab icon) but does not ask cargo to watch it,
    // so a regenerated icon never reached the app: the exe kept whatever icon
    // it was first built with. These make an icon change rebuild the shell.
    for icon in ["../build/icon.ico", "../build/icon.icns", "../build/icon.png"] {
        println!("cargo:rerun-if-changed={icon}");
    }
    tauri_build::build()
}
