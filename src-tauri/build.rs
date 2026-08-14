fn main() {
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "incoming_private_dm",
        "get_settings",
        "update_settings",
        "get_content_controls",
        "window_action",
        "settings_ui_ready",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to build InstaDesk and its command permissions");
}
