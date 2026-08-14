use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    sync::Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    utils::config::Color,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Webview, WebviewBuilder,
    WebviewUrl, WebviewWindowBuilder, Window, WindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

const INSTAGRAM_HOME: &str = "https://www.instagram.com/";
const INSTAGRAM_INBOX: &str = "https://www.instagram.com/direct/inbox/";
const SETTINGS_FILE: &str = "settings.json";
const MAX_DEDUP: usize = 1000;
const TITLEBAR_HEIGHT: f64 = 38.0;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    notifications: bool,
    launch_at_startup: bool,
    minimize_to_tray: bool,
    notification_previews: bool,
    disable_home_feed: bool,
    disable_reels: bool,
    disable_explore: bool,
    disable_search: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            notifications: true,
            launch_at_startup: false,
            minimize_to_tray: true,
            notification_previews: true,
            disable_home_feed: false,
            disable_reels: false,
            disable_explore: false,
            disable_search: false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DmMessage {
    conversation_id: String,
    conversation_url: String,
    sender: String,
    preview: String,
    message_key: String,
    #[allow(dead_code)]
    received_at: u64,
}

struct AppState {
    settings: Mutex<Settings>,
    dedup: Mutex<(HashSet<String>, VecDeque<String>)>,
    quitting: Mutex<bool>,
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join(SETTINGS_FILE))
}

fn load_settings<R: Runtime>(app: &AppHandle<R>) -> Settings {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    let Some(path) = settings_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_vec_pretty(settings) {
        let _ = fs::write(path, data);
    }
}

fn instagram_url(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(raw).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "https" && (host == "instagram.com" || host.ends_with(".instagram.com")))
        .then_some(url)
}

fn navigate<R: Runtime>(webview: &Webview<R>, raw: &str) {
    if let Some(url) = instagram_url(raw) {
        let _ = webview.navigate(url);
    }
}

fn show_instagram<R: Runtime>(app: &AppHandle<R>, destination: Option<&str>) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    if let (Some(url), Some(webview)) = (destination, app.get_webview("instagram")) {
        navigate(&webview, url);
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn layout_main_window<R: Runtime>(window: &Window<R>) {
    let Ok(size) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let chrome_height = (TITLEBAR_HEIGHT * scale).round() as u32;
    if let Some(chrome) = window.app_handle().get_webview("main") {
        let _ = chrome.set_position(PhysicalPosition::new(0, 0));
        let _ = chrome.set_size(PhysicalSize::new(
            size.width,
            chrome_height.min(size.height),
        ));
    }
    if let Some(instagram) = window.app_handle().get_webview("instagram") {
        let _ = instagram.set_position(PhysicalPosition::new(0, chrome_height as i32));
        let _ = instagram.set_size(PhysicalSize::new(
            size.width,
            size.height.saturating_sub(chrome_height),
        ));
    }
}

fn create_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Window<R>> {
    let url = url::Url::parse(INSTAGRAM_HOME).expect("valid Instagram URL");
    let window = WindowBuilder::new(app, "main")
        .title("")
        .inner_size(1160.0, 800.0)
        .min_inner_size(720.0, 560.0)
        .center()
        .decorations(false)
        .build()?;
    let size = window.inner_size()?;
    let chrome_height = (TITLEBAR_HEIGHT * window.scale_factor().unwrap_or(1.0)).round() as u32;
    window.add_child(
        WebviewBuilder::new("main", WebviewUrl::App("index.html".into())),
        PhysicalPosition::new(0, 0),
        PhysicalSize::new(size.width, chrome_height),
    )?;
    window.add_child(
        WebviewBuilder::new("instagram", WebviewUrl::External(url))
            .initialization_script(include_str!("../generated/dm-monitor.js"))
            .on_navigation(|url| instagram_url(url.as_str()).is_some()),
        PhysicalPosition::new(0, chrome_height as i32),
        PhysicalSize::new(size.width, size.height.saturating_sub(chrome_height)),
    )?;
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(window) = handle.get_window("main") {
                layout_main_window(&window);
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            let state = handle.state::<AppState>();
            let quitting = state.quitting.lock().map(|v| *v).unwrap_or(false);
            let minimize = state
                .settings
                .lock()
                .map(|s| s.minimize_to_tray)
                .unwrap_or(true);
            if minimize && !quitting {
                api.prevent_close();
                if let Some(window) = handle.get_window("main") {
                    let _ = window.hide();
                }
            }
        }
        _ => {}
    });
    Ok(window)
}

fn create_settings_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window =
        WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
            .title("InstaDesk Settings")
            .inner_size(510.0, 520.0)
            .min_inner_size(510.0, 520.0)
            .resizable(false)
            .maximizable(false)
            .decorations(false)
            .visible(false)
            .background_color(Color(17, 17, 22, 255))
            .center()
            .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window("settings") {
                let _ = window.hide();
            }
        }
    });
    Ok(())
}

fn show_settings<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("settings") else {
        eprintln!("[InstaDesk] settings window is unavailable");
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn is_new_message(state: &AppState, key: String) -> bool {
    let Ok(mut guard) = state.dedup.lock() else {
        return false;
    };
    let (set, order) = &mut *guard;
    if !set.insert(key.clone()) {
        return false;
    }
    order.push_back(key);
    while order.len() > MAX_DEDUP {
        if let Some(old) = order.pop_front() {
            set.remove(&old);
        }
    }
    true
}

fn dispatch_notification<R: Runtime>(
    app: &AppHandle<R>,
    sender: &str,
    preview: &str,
    destination: &str,
) -> Result<(), String> {
    let destination = instagram_url(destination)
        .map(|u| u.to_string())
        .unwrap_or_else(|| INSTAGRAM_INBOX.to_string());
    #[cfg(windows)]
    {
        let mut toast = notify_rust::Notification::new();
        toast
            .summary(&format!("Instagram — {sender}"))
            .body(preview)
            .app_id("com.instadesk.desktop");
        let handle = toast.show().map_err(|e| e.to_string())?;
        let app = app.clone();
        std::thread::spawn(move || {
            handle.wait_for_action(move |action| {
                if action != "__closed" {
                    show_instagram(&app, Some(&destination));
                }
            })
        });
        return Ok(());
    }
    #[cfg(not(windows))]
    app.notification()
        .builder()
        .title(format!("Instagram — {sender}"))
        .body(preview)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn incoming_private_dm(app: AppHandle, webview: Webview, message: DmMessage) -> Result<(), String> {
    if webview.label() != "instagram" {
        return Err("DM events are accepted only from the Instagram WebView".into());
    }
    // Defense in depth: the injected adapter can only send HTTPS Instagram thread URLs.
    let Some(destination) = instagram_url(&message.conversation_url) else {
        return Err("Rejected non-Instagram conversation URL".into());
    };
    if !destination.path().starts_with("/direct/t/")
        || message.sender.trim().is_empty()
        || message.preview.trim().is_empty()
    {
        return Err("Rejected incomplete DM candidate".into());
    }
    let state = app.state::<AppState>();
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .clone();
    if !settings.notifications {
        return Ok(());
    }
    let key = format!("{}:{}", message.conversation_id, message.message_key);
    if !is_new_message(&state, key) {
        eprintln!("[InstaDesk] duplicate ignored");
        return Ok(());
    }
    let body = if settings.notification_previews {
        message.preview
    } else {
        "New private message".into()
    };
    dispatch_notification(
        &app,
        message.sender.trim(),
        body.trim(),
        destination.as_str(),
    )?;
    eprintln!(
        "[InstaDesk] notification dispatched for private conversation {}",
        message.conversation_id
    );
    Ok(())
}

#[tauri::command]
fn get_settings(app: AppHandle, webview: Webview) -> Result<Settings, String> {
    if webview.label() != "settings" {
        return Err("Settings are available only to the settings dialog".into());
    }
    app.state::<AppState>()
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "settings lock poisoned".into())
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    webview: Webview,
    settings: Settings,
) -> Result<Settings, String> {
    if webview.label() != "settings" {
        return Err("Settings can be changed only from the settings dialog".into());
    }
    let state = app.state::<AppState>();
    let previous_startup = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .launch_at_startup;
    if previous_startup != settings.launch_at_startup {
        set_autostart(&app, settings.launch_at_startup);
    }
    {
        let mut current = state
            .settings
            .lock()
            .map_err(|_| "settings lock poisoned")?;
        *current = settings.clone();
    }
    save_settings(&app, &settings);
    let _ = app.remove_tray_by_id("instadesk-tray");
    build_tray(&app, &settings).map_err(|error| error.to_string())?;
    if let Some(instagram) = app.get_webview("instagram") {
        let _ =
            instagram.eval("window.dispatchEvent(new CustomEvent('instadesk:settings-changed'))");
    }
    Ok(settings)
}

#[tauri::command]
fn get_content_controls(app: AppHandle, webview: Webview) -> Result<Settings, String> {
    if webview.label() != "instagram" {
        return Err("Content controls are available only to the Instagram WebView".into());
    }
    app.state::<AppState>()
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "settings lock poisoned".into())
}

#[tauri::command]
fn window_action(app: AppHandle, webview: Webview, action: &str) -> Result<(), String> {
    let window = webview.window();
    match (webview.label(), action) {
        ("main", "drag") => window.start_dragging().map_err(|e| e.to_string())?,
        ("main", "minimize") => window.minimize().map_err(|e| e.to_string())?,
        ("main", "maximize") => {
            #[cfg(windows)]
            {
                use windows::Win32::UI::WindowsAndMessaging::{
                    IsZoomed, ShowWindow, SW_MAXIMIZE, SW_RESTORE,
                };
                let hwnd = window.hwnd().map_err(|error| error.to_string())?;
                unsafe {
                    let _ = ShowWindow(
                        hwnd,
                        if IsZoomed(hwnd).as_bool() {
                            SW_RESTORE
                        } else {
                            SW_MAXIMIZE
                        },
                    );
                }
            }
            #[cfg(not(windows))]
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(|e| e.to_string())?;
        }
        ("main" | "instagram", "fullscreen") => {
            let fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
            window
                .set_fullscreen(!fullscreen)
                .map_err(|e| e.to_string())?;
        }
        ("main", "close") => {
            let minimize = app
                .state::<AppState>()
                .settings
                .lock()
                .map(|s| s.minimize_to_tray)
                .unwrap_or(true);
            if minimize {
                window.hide()
            } else {
                window.close()
            }
            .map_err(|e| e.to_string())?;
        }
        ("main", "settings") => show_settings(&app),
        ("instagram", "back") => webview.eval("history.back()").map_err(|e| e.to_string())?,
        ("instagram", "forward") => webview
            .eval("history.forward()")
            .map_err(|e| e.to_string())?,
        ("settings", "drag_settings") => window.start_dragging().map_err(|e| e.to_string())?,
        ("settings", "close_settings") => window.hide().map_err(|e| e.to_string())?,
        _ => return Err("Window action is not allowed for this WebView".into()),
    }
    Ok(())
}

#[tauri::command]
fn settings_ui_ready(webview: Webview) -> Result<(), String> {
    if webview.label() != "settings" {
        return Err("UI readiness is accepted only from Settings".into());
    }
    eprintln!("[InstaDesk] settings UI rendered");
    Ok(())
}

fn set_autostart<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(error) = result {
        eprintln!("[InstaDesk] autostart update failed: {error}");
    }
}

fn toggle_setting<R: Runtime>(app: &AppHandle<R>, field: &str) {
    let state = app.state::<AppState>();
    if let Ok(mut settings) = state.settings.lock() {
        match field {
            "notifications" => settings.notifications = !settings.notifications,
            "previews" => settings.notification_previews = !settings.notification_previews,
            "minimize" => settings.minimize_to_tray = !settings.minimize_to_tray,
            "autostart" => {
                settings.launch_at_startup = !settings.launch_at_startup;
                set_autostart(app, settings.launch_at_startup);
            }
            _ => return,
        }
        save_settings(app, &settings);
    };
}

fn build_tray<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Instagram", true, None::<&str>)?;
    let dms = MenuItem::with_id(app, "dms", "Open DMs", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let notifications = CheckMenuItem::with_id(
        app,
        "notifications",
        "Notifications",
        true,
        settings.notifications,
        None::<&str>,
    )?;
    let previews = CheckMenuItem::with_id(
        app,
        "previews",
        "Notification previews",
        true,
        settings.notification_previews,
        None::<&str>,
    )?;
    let minimize = CheckMenuItem::with_id(
        app,
        "minimize",
        "Minimize to tray",
        true,
        settings.minimize_to_tray,
        None::<&str>,
    )?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Launch on startup",
        true,
        settings.launch_at_startup,
        None::<&str>,
    )?;
    let test = MenuItem::with_id(
        app,
        "test",
        "Test Notification (development)",
        cfg!(debug_assertions),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &dms,
            &settings_item,
            &sep1,
            &notifications,
            &previews,
            &minimize,
            &autostart,
            &test,
            &sep2,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id("instadesk-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("configured app icon"),
        )
        .tooltip("InstaDesk — Unofficial Instagram wrapper")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_instagram(app, None),
            "dms" => show_instagram(app, Some(INSTAGRAM_INBOX)),
            "settings" => show_settings(app),
            "notifications" | "previews" | "minimize" | "autostart" => {
                toggle_setting(app, event.id.as_ref())
            }
            "test" if cfg!(debug_assertions) => {
                let _ = dispatch_notification(
                    app,
                    "Test User",
                    "This is a test private message.",
                    INSTAGRAM_INBOX,
                );
            }
            "quit" => {
                if let Ok(mut q) = app.state::<AppState>().quitting.lock() {
                    *q = true;
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } | TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_instagram(tray.app_handle(), None);
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![incoming_private_dm, get_settings, update_settings, get_content_controls, window_action, settings_ui_ready])
        .setup(|app| {
            let settings = load_settings(app.handle());
            app.manage(AppState { settings: Mutex::new(settings.clone()), dedup: Mutex::new((HashSet::new(), VecDeque::new())), quitting: Mutex::new(false) });
            build_tray(app.handle(), &settings)?;
            create_settings_window(app.handle())?;
            let window = create_main_window(app.handle())?;
            if std::env::args().any(|arg| arg == "--hidden") { let _ = window.hide(); }
            if std::env::args().any(|arg| arg == "--open-settings") { show_settings(app.handle()); }
            #[cfg(debug_assertions)]
            if std::env::args().any(|arg| arg == "--ipc-self-test") {
                let chrome = app.get_webview("main");
                tauri::async_runtime::spawn(async move {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if let Some(chrome) = chrome {
                        let _ = chrome.eval(r#"window.__TAURI_INTERNALS__.invoke('window_action', { action: 'settings' })
                            .then(() => console.debug('[InstaDesk] IPC self-test passed'))
                            .catch((error) => console.error('[InstaDesk] IPC self-test failed', error))"#);
                    }
                });
            }
            #[cfg(debug_assertions)]
            if std::env::args().any(|arg| arg == "--test-notification") {
                dispatch_notification(app.handle(), "Test User", "This is a test private message.", INSTAGRAM_INBOX)
                    .map_err(std::io::Error::other)?;
                eprintln!("[InstaDesk] development notification dispatched successfully");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running InstaDesk");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_https_instagram_destinations() {
        assert!(instagram_url("https://www.instagram.com/direct/t/123/").is_some());
        assert!(instagram_url("http://www.instagram.com/direct/t/123/").is_none());
        assert!(instagram_url("https://instagram.example/direct/t/123/").is_none());
        assert!(instagram_url("javascript:alert(1)").is_none());
    }

    #[test]
    fn native_dedup_is_bounded_and_rejects_repeat_keys() {
        let state = AppState {
            settings: Mutex::new(Settings::default()),
            dedup: Mutex::new((HashSet::new(), VecDeque::new())),
            quitting: Mutex::new(false),
        };
        assert!(is_new_message(&state, "thread:message".into()));
        assert!(!is_new_message(&state, "thread:message".into()));
        for i in 0..=MAX_DEDUP {
            assert!(is_new_message(&state, format!("key:{i}")));
        }
        let guard = state.dedup.lock().unwrap();
        assert_eq!(guard.0.len(), MAX_DEDUP);
        assert_eq!(guard.1.len(), MAX_DEDUP);
    }
}
