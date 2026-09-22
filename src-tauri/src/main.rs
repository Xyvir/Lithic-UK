// Prevents an extra console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

// The desktop entry point is deliberately this thin: the application lives in the
// library (`app_lib::run`) so Android and iOS can enter the same code through
// Tauri's mobile entry point instead of through `main`.
fn main() {
    app_lib::run();
}
