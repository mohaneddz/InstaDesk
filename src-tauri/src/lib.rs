use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
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
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;

const INSTAGRAM_HOME: &str = "https://www.instagram.com/";
const INSTAGRAM_INBOX: &str = "https://www.instagram.com/direct/inbox/";
const SETTINGS_FILE: &str = "settings.json";
const MAX_DEDUP: usize = 1000;
const TITLEBAR_HEIGHT: f64 = 38.0;
/// Without this, WebView2 applies Chromium's normal background-tab throttling
/// once the host window has been hidden for a while, which starves the inbox
/// webview's polling timers and silently stops new-message detection. The
/// `--disable-features=...` prefix has to be repeated here because setting
/// additional browser args replaces wry's own default rather than appending.
const KEEP_RUNNING_IN_BACKGROUND_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";


#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    notify_private: bool,
    notify_group: bool,
    notify_messages: bool,
    notify_reactions: bool,
    notify_typing: bool,
    notify_story_replies: bool,
    notify_note_replies: bool,
    notify_muted_chats: bool,
    /// "off", "whitelist" or "blacklist" — how sender_filter_list is read.
    sender_filter_mode: String,
    sender_filter_list: Vec<String>,
    launch_at_startup: bool,
    minimize_to_tray: bool,
    notification_previews: bool,
    show_notifications_when_open: bool,
    disable_home_feed: bool,
    disable_reels: bool,
    disable_explore: bool,
    disable_search: bool,
    disable_posts: bool,
    disable_stories: bool,
    disable_suggestions: bool,
    ghost_stories: bool,
    hide_private_chats: bool,
    hide_group_chats: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            notify_private: true,
            notify_group: true,
            notify_messages: true,
            notify_reactions: true,
            notify_typing: false,
            notify_story_replies: true,
            notify_note_replies: true,
            notify_muted_chats: false,
            sender_filter_mode: "off".into(),
            sender_filter_list: Vec::new(),
            launch_at_startup: false,
            minimize_to_tray: true,
            notification_previews: true,
            show_notifications_when_open: true,
            disable_home_feed: false,
            disable_reels: false,
            disable_explore: false,
            disable_search: false,
            disable_posts: false,
            disable_stories: false,
            disable_suggestions: false,
            ghost_stories: false,
            hide_private_chats: false,
            hide_group_chats: false,
        }
    }
}

/// Subset of settings exposed to the Instagram WebView for content controls.
/// Notification and startup preferences are intentionally excluded so the
/// remote page cannot observe or infer the user's notification configuration.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentControls {
    disable_home_feed: bool,
    disable_reels: bool,
    disable_explore: bool,
    disable_search: bool,
    disable_posts: bool,
    disable_stories: bool,
    disable_suggestions: bool,
    ghost_stories: bool,
    hide_private_chats: bool,
    hide_group_chats: bool,
}

impl From<&Settings> for ContentControls {
    fn from(s: &Settings) -> Self {
        Self {
            disable_home_feed: s.disable_home_feed,
            disable_reels: s.disable_reels,
            disable_explore: s.disable_explore,
            disable_search: s.disable_search,
            disable_posts: s.disable_posts,
            disable_stories: s.disable_stories,
            disable_suggestions: s.disable_suggestions,
            ghost_stories: s.ghost_stories,
            hide_private_chats: s.hide_private_chats,
            hide_group_chats: s.hide_group_chats,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxMessage {
    conversation_id: String,
    conversation_url: String,
    sender: String,
    preview: String,
    message_key: String,
    kind: String,
    #[serde(default = "default_event")]
    event: String,
    #[serde(default)]
    muted: bool,
}

fn default_event() -> String {
    "message".into()
}

struct AppState {
    settings: Mutex<Settings>,
    dedup: Mutex<(HashSet<String>, VecDeque<String>)>,
    /// Uses an AtomicBool rather than a Mutex<bool> for lock-free reads in the
    /// CloseRequested handler.
    quitting: AtomicBool,
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

fn hide_main_window<R: Runtime>(app: &AppHandle<R>, window: &Window<R>) {
    if let Some(settings) = app.get_webview_window("settings") {
        let _ = settings.hide();
    }
    leave_open_thread(app);
    let minimize_to_tray = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|settings| settings.minimize_to_tray)
        .unwrap_or(true);
    if minimize_to_tray {
        let _ = window.hide();
    } else {
        let _ = window.minimize();
    }
}

/// A thread left open behind a hidden window keeps receiving live messages
/// over Instagram's own socket, and Instagram marks those seen on arrival
/// regardless of whether the OS window is visible. Navigating back to the
/// inbox list before hiding means nothing stays "open" to auto-mark seen.
fn leave_open_thread<R: Runtime>(app: &AppHandle<R>) {
    let Some(instagram) = app.get_webview("instagram") else {
        return;
    };
    let Ok(url) = instagram.url() else {
        return;
    };
    if url.path().starts_with("/direct/t/") {
        navigate(&instagram, INSTAGRAM_INBOX);
    }
}

/// Ctrl + Alt + I toggles the window from anywhere.
///
/// The previous binding watched for Left Alt + Right Alt through a low-level
/// keyboard hook. A bare modifier chord is a poor shortcut: Windows and the
/// page both act on Alt on their own, and nothing downstream can tell the
/// chord apart from someone simply holding Alt. A registered shortcut with a
/// non-modifier key is delivered by the OS and does not depend on focus.
pub const TOGGLE_SHORTCUT: &str = "Ctrl+Alt+I";

fn install_toggle_shortcut<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_global_shortcut::ShortcutState;

    let handle = app.clone();
    let registered = app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, _shortcut, event| {
                // Fire once per press; the OS repeats the key while it is held.
                if event.state() == ShortcutState::Pressed {
                    toggle_main_window(&handle);
                }
            })
            .build(),
    );
    if let Err(error) = registered {
        eprintln!("[InstaDesk] global shortcut plugin unavailable: {error}");
        return;
    }
    if let Err(error) = app.global_shortcut().register(TOGGLE_SHORTCUT) {
        eprintln!("[InstaDesk] could not register {TOGGLE_SHORTCUT}: {error}");
    }
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && !minimized && focused {
        hide_main_window(app, &window);
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(windows)]
fn ensure_windows_shortcut_registered() {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    if appdata.is_empty() {
        return;
    }
    let shortcut_path = std::path::PathBuf::from(&appdata)
        .join(r"Microsoft\Windows\Start Menu\Programs\InstaDesk.lnk");
    if shortcut_path.exists() {
        return;
    }
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };
    let current_exe_str = current_exe.to_string_lossy();
    let shortcut_str = shortcut_path.to_string_lossy();

    let script = format!(
        r#"$c = @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] public class ShellLink {{}}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")] public interface IShellLinkW {{ void GetPath(IntPtr a, int b, IntPtr c, uint d); void GetIDList(out IntPtr a); void SetIDList(IntPtr a); void GetDescription(IntPtr a, int b); void SetDescription(string a); void GetWorkingDirectory(IntPtr a, int b); void SetWorkingDirectory(string a); void GetArguments(IntPtr a, int b); void SetArguments(string a); void GetHotkey(out short a); void SetHotkey(short a); void GetShowCmd(out int a); void SetShowCmd(int a); void GetIconLocation(IntPtr a, int b, out int c); void SetIconLocation(string a, int b); void SetRelativePath(string a, uint b); void Resolve(IntPtr a, uint b); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string a); }}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")] public interface IPropertyStore {{ uint GetCount(); void GetAt(uint i, out PropertyKey k); void GetValue(ref PropertyKey k, out PropVariant v); void SetValue(ref PropertyKey k, ref PropVariant v); void Commit(); }}
[StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropertyKey {{ public Guid fmtid; public uint pid; public PropertyKey(Guid g, uint id) {{ fmtid = g; pid = id; }} }}
[StructLayout(LayoutKind.Explicit)] public struct PropVariant {{ [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pwszVal; public static PropVariant FromString(string val) {{ var pv = new PropVariant(); pv.vt = 31; pv.pwszVal = Marshal.StringToCoTaskMemUni(val); return pv; }} }}
public class H {{ public static void S(string lPath, string tPath, string aumid) {{ var l = (IShellLinkW)new ShellLink(); l.SetPath(tPath); var ps = (IPropertyStore)l; var k = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5); var pv = PropVariant.FromString(aumid); ps.SetValue(ref k, ref pv); ps.Commit(); ((System.Runtime.InteropServices.ComTypes.IPersistFile)l).Save(lPath, true); }} }}
'@
Add-Type -TypeDefinition $c
[H]::S('{}', '{}', 'com.instadesk.desktop')
"#,
        shortcut_str.replace('\'', "''"),
        current_exe_str.replace('\'', "''")
    );

    std::thread::spawn(move || {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    });
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
    let initial_settings_struct = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    let start_url = if initial_settings_struct.disable_home_feed {
        INSTAGRAM_INBOX
    } else {
        INSTAGRAM_HOME
    };
    let url = url::Url::parse(start_url).expect("valid Instagram URL");
    let initial_settings = serde_json::to_string(&initial_settings_struct).unwrap_or_else(|_| "{}".into());
    let dm_monitor_js = include_str!("../generated/dm-monitor.js");
    let instagram_init = format!(
        "window.__INSTADESK_ROLE__ = 'main';\nwindow.__INSTADESK_CONTENT_CONTROLS__ = {initial_settings};\n{dm_monitor_js}"
    );
    let inbox_init =
        format!("window.__INSTADESK_ROLE__ = 'inbox';\n{dm_monitor_js}");
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
            .initialization_script(instagram_init)
            .additional_browser_args(KEEP_RUNNING_IN_BACKGROUND_ARGS)
            .on_navigation(|url| instagram_url(url.as_str()).is_some()),
        PhysicalPosition::new(0, chrome_height as i32),
        PhysicalSize::new(size.width, size.height.saturating_sub(chrome_height)),
    )?;
    // Runs off-screen at all times so new messages are caught regardless of
    // which page is visible, or whether the window is minimized or hidden.
    let inbox_url = url::Url::parse(INSTAGRAM_INBOX).expect("valid Instagram URL");
    window.add_child(
        WebviewBuilder::new("inbox", WebviewUrl::External(inbox_url))
            .initialization_script(inbox_init)
            .additional_browser_args(KEEP_RUNNING_IN_BACKGROUND_ARGS)
            .on_navigation(|url| instagram_url(url.as_str()).is_some()),
        PhysicalPosition::new(-20_000, -20_000),
        PhysicalSize::new(1280, 800),
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
            // Lock-free read; quitting is set with SeqCst store on quit.
            let quitting = state.quitting.load(Ordering::SeqCst);
            let minimize = state
                .settings
                .lock()
                .map(|s| s.minimize_to_tray)
                .unwrap_or(true);
            if minimize && !quitting {
                api.prevent_close();
                leave_open_thread(&handle);
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
    _destination: &str,
    kind: &str,
) -> Result<(), String> {
    if let Ok(state) = app.notification().permission_state() {
        if !matches!(state, tauri_plugin_notification::PermissionState::Granted) {
            let _ = app.notification().request_permission();
        }
    }
    let title = if kind == "group" {
        format!("{sender} (Group)")
    } else {
        format!("Instagram — {sender}")
    };
    let body = if preview.trim().is_empty() {
        "Sent you a new message"
    } else {
        preview.trim()
    };
    let mut builder = app.notification().builder();
    builder = builder.title(title).body(body);

    let resolved_icon = if let Ok(abs) = std::fs::canonicalize("icons/128x128.png") {
        Some(abs.to_string_lossy().trim_start_matches(r"\\?\").to_string())
    } else if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("icons/128x128.png");
        if p.exists() {
            Some(p.to_string_lossy().to_string())
        } else {
            None
        }
    } else {
        None
    };

    if let Some(icon) = resolved_icon {
        builder = builder.icon(icon);
    }

    let result = builder.show().map_err(|e| e.to_string());
    result
}

/// Each kind of inbox event carries its own toggle, so a reaction or a typing
/// indicator can be silenced without silencing real messages.
fn event_allowed(settings: &Settings, event: &str) -> bool {
    match event {
        "reaction" => settings.notify_reactions,
        "typing" => settings.notify_typing,
        "storyReply" => settings.notify_story_replies,
        "noteReply" => settings.notify_note_replies,
        _ => settings.notify_messages,
    }
}

/// Compares against the sender's display name case-insensitively, and matches a
/// leading "@" either way so a list written as @name behaves the same as name.
fn sender_allowed(settings: &Settings, sender: &str) -> bool {
    let normalize = |value: &str| value.trim().trim_start_matches('@').to_lowercase();
    let sender = normalize(sender);
    // An empty list means the filter was switched on but never filled in;
    // treating that as "allow nothing" would silently swallow every message.
    if settings.sender_filter_list.iter().all(|entry| entry.trim().is_empty()) {
        return true;
    }
    let listed = settings
        .sender_filter_list
        .iter()
        .any(|entry| !entry.trim().is_empty() && normalize(entry) == sender);
    match settings.sender_filter_mode.as_str() {
        "whitelist" => listed,
        "blacklist" => !listed,
        _ => true,
    }
}

/// The inbox WebView is parked offscreen where devtools cannot reach it, so it
/// reports what its scans found through here and the output lands in the
/// terminal alongside the rest of the app's logging.
#[tauri::command]
fn report_diagnostic(webview: Webview, label: String, detail: String) -> Result<(), String> {
    if webview.label() != "inbox" && webview.label() != "instagram" {
        return Err("Diagnostics are accepted only from Instagram WebViews".into());
    }
    let detail: String = detail.chars().take(2000).collect();
    eprintln!("[InstaDesk][{}] {label}: {detail}", webview.label());
    Ok(())
}

#[tauri::command]
fn incoming_message(app: AppHandle, webview: Webview, message: InboxMessage) -> Result<(), String> {
    if webview.label() != "inbox" && webview.label() != "instagram" {
        return Err("Inbox events are accepted only from Instagram WebViews".into());
    }
    // Defense in depth: the injected adapter can only send HTTPS Instagram thread URLs.
    let Some(destination) = instagram_url(&message.conversation_url) else {
        return Err("Rejected non-Instagram conversation URL".into());
    };
    if !destination.path().starts_with("/direct/")
        || message.sender.trim().is_empty()
        || message.preview.trim().is_empty()
    {
        return Err("Rejected incomplete message candidate".into());
    }
    let kind = match message.kind.as_str() {
        "group" => "group",
        _ => "private",
    };
    let state = app.state::<AppState>();
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .clone();
    // A hidden conversation is meant to be gone, not merely unreachable, so it
    // never announces itself regardless of the notification toggles.
    let hidden = if kind == "group" {
        settings.hide_group_chats
    } else {
        settings.hide_private_chats
    };
    let allowed = if kind == "group" {
        settings.notify_group
    } else {
        settings.notify_private
    };
    if hidden || !allowed || !event_allowed(&settings, &message.event) {
        return Ok(());
    }
    if message.muted && !settings.notify_muted_chats {
        return Ok(());
    }
    if !sender_allowed(&settings, &message.sender) {
        return Ok(());
    }
    let key = format!("{}:{}", message.conversation_id, message.message_key);
    if !is_new_message(&state, key) {
        eprintln!("[InstaDesk] duplicate ignored");
        return Ok(());
    }
    if !settings.show_notifications_when_open {
        if let Some(main_win) = app.get_window("main") {
            let visible = main_win.is_visible().unwrap_or(false);
            let minimized = main_win.is_minimized().unwrap_or(false);
            if visible && !minimized {
                eprintln!("[InstaDesk] notification suppressed because app window is open and visible");
                return Ok(());
            }
        }
    }
    let body = if settings.notification_previews {
        message.preview
    } else if kind == "group" {
        "New group message".into()
    } else {
        "New private message".into()
    };
    dispatch_notification(
        &app,
        message.sender.trim(),
        body.trim(),
        destination.as_str(),
        kind,
    )?;
    eprintln!(
        "[InstaDesk] {kind} notification dispatched for conversation {}",
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
        let settings_json = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
        let _ = instagram.eval(format!(
            "window.dispatchEvent(new CustomEvent('instadesk:settings-changed', {{ detail: {settings_json} }}))"
        ));
    }
    Ok(settings)
}

#[tauri::command]
fn get_content_controls(app: AppHandle, webview: Webview) -> Result<ContentControls, String> {
    if webview.label() != "instagram" {
        return Err("Content controls are available only to the Instagram WebView".into());
    }
    app.state::<AppState>()
        .settings
        .lock()
        .map(|settings| ContentControls::from(&*settings))
        .map_err(|_| "settings lock poisoned".into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaItem {
    #[allow(dead_code)]
    kind: String,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    index: usize,
    count: usize,
    overall_percent: f64,
}

/// Instagram serves post media from its own CDN hosts; only those are fetchable.
fn is_instagram_media_url(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(raw).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "https"
        && (host.ends_with(".cdninstagram.com")
            || host == "cdninstagram.com"
            || host.ends_with(".fbcdn.net")
            || host.ends_with(".instagram.com")
            || host == "instagram.com"))
    .then_some(url)
}

fn media_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 InstaDesk")
        .build()
        .map_err(|error| error.to_string())
}

fn unique_download_path(dir: &std::path::Path, name: &str, ext: &str) -> std::path::PathBuf {
    let mut candidate = dir.join(format!("{name}.{ext}"));
    let mut counter = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{name}-{counter}.{ext}"));
        counter += 1;
    }
    candidate
}

fn extension_for(url: &url::Url, content_type: Option<&str>, kind: &str) -> String {
    if let Some(ext) = std::path::Path::new(url.path())
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.chars().all(|c| c.is_ascii_alphanumeric()) && value.len() <= 5)
    {
        return ext.to_ascii_lowercase();
    }
    match content_type.and_then(|value| value.split('/').nth(1)).map(|value| value.split(';').next().unwrap_or("").trim()) {
        Some("jpeg") => "jpg".into(),
        Some(subtype) if !subtype.is_empty() && subtype.chars().all(|c| c.is_ascii_alphanumeric()) => subtype.to_ascii_lowercase(),
        _ if kind == "video" => "mp4".into(),
        _ => "jpg".into(),
    }
}

#[tauri::command]
async fn download_media(
    app: AppHandle,
    webview: Webview,
    items: Vec<MediaItem>,
    base: String,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<usize, String> {
    use futures_util::StreamExt;
    if webview.label() != "instagram" {
        return Err("Downloads are available only to the Instagram WebView".into());
    }
    let targets: Vec<url::Url> = items
        .iter()
        .filter_map(|item| is_instagram_media_url(&item.url))
        .collect();
    if targets.is_empty() {
        return Err("No downloadable Instagram media was found in this post".into());
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Could not locate the Downloads folder: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let safe_base = {
        let cleaned: String = base
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
            .collect();
        if cleaned.trim_matches('-').is_empty() { "instagram-post".to_string() } else { cleaned }
    };
    let client = media_client()?;
    let count = targets.len();
    let mut saved = 0usize;
    for (index, url) in targets.into_iter().enumerate() {
        let kind = items
            .get(index)
            .map(|item| item.kind.as_str())
            .unwrap_or("image");
        let response = client
            .get(url.clone())
            .header(reqwest::header::REFERER, "https://www.instagram.com/")
            .send()
            .await
            .map_err(|error| format!("Media request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Media request failed ({})", response.status()));
        }
        let total = response.content_length().unwrap_or(0);
        let ext = extension_for(
            &url,
            response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            kind,
        );
        let mut buffer: Vec<u8> = Vec::with_capacity(total as usize);
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("Download interrupted: {error}"))?;
            buffer.extend_from_slice(&chunk);
            let item_fraction = if total > 0 {
                (buffer.len() as f64 / total as f64).min(1.0)
            } else {
                0.0
            };
            let overall = ((index as f64 + item_fraction) / count as f64) * 100.0;
            let _ = on_progress.send(DownloadProgress {
                index,
                count,
                overall_percent: overall,
            });
        }
        let name = if count > 1 {
            format!("{safe_base}-{}", index + 1)
        } else {
            safe_base.clone()
        };
        let path = unique_download_path(&dir, &name, &ext);
        fs::write(&path, &buffer).map_err(|error| format!("Could not save media: {error}"))?;
        saved += 1;
        let _ = on_progress.send(DownloadProgress {
            index,
            count,
            overall_percent: ((index as f64 + 1.0) / count as f64) * 100.0,
        });
    }
    Ok(saved)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256];
    for (i, &b) in TABLE.iter().enumerate() {
        map[b as usize] = i as u8;
    }
    let input = input.trim_end_matches('=');
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for &b in input.as_bytes() {
        if b.is_ascii_whitespace() {
            continue;
        }
        let val = map[b as usize];
        if val == 255 {
            return Err("Invalid base64 character".into());
        }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn copy_image(webview: Webview, url: String) -> Result<(), String> {
    if webview.label() != "instagram" {
        return Err("Clipboard copy is available only to the Instagram WebView".into());
    }
    let bytes = if url.starts_with("data:image/") {
        let comma = url.find(',').ok_or("Invalid data URL format")?;
        decode_base64(&url[comma + 1..])?
    } else {
        let target = is_instagram_media_url(&url).ok_or("Rejected non-Instagram media URL")?;
        let client = media_client()?;
        client
            .get(target)
            .header(reqwest::header::REFERER, "https://www.instagram.com/")
            .send()
            .await
            .map_err(|error| format!("Image request failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Image request failed: {error}"))?
            .bytes()
            .await
            .map_err(|error| error.to_string())?
            .to_vec()
    };
    let image = image::load_from_memory(&bytes)
        .map_err(|error| format!("Could not decode image: {error}"))?
        .to_rgba8();
    let (width, height) = image.dimensions();
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: std::borrow::Cow::from(image.into_raw()),
        })
        .map_err(|error| format!("Could not write image to clipboard: {error}"))
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
                leave_open_thread(&app);
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
        ("main" | "instagram" | "settings", "toggle_window") => toggle_main_window(&app),
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
    // Clone settings out of the lock before rebuilding the tray, so the lock
    // is not held when build_tray registers menu-event closures that may later
    // try to acquire it.
    let settings = {
        let Ok(mut guard) = state.settings.lock() else { return; };
        match field {
            "notifyPrivate" => guard.notify_private = !guard.notify_private,
            "notifyGroup" => guard.notify_group = !guard.notify_group,
            "previews" => guard.notification_previews = !guard.notification_previews,
            "minimize" => guard.minimize_to_tray = !guard.minimize_to_tray,
            "autostart" => {
                guard.launch_at_startup = !guard.launch_at_startup;
                set_autostart(app, guard.launch_at_startup);
            }
            "hidePrivateChats" => guard.hide_private_chats = !guard.hide_private_chats,
            "hideGroupChats" => guard.hide_group_chats = !guard.hide_group_chats,
            _ => return,
        }
        save_settings(app, &guard);
        if let (Some(instagram), Ok(settings_json)) =
            (app.get_webview("instagram"), serde_json::to_string(&*guard))
        {
            let _ = instagram.eval(format!(
                "window.dispatchEvent(new CustomEvent('instadesk:settings-changed', {{ detail: {settings_json} }}))"
            ));
        }
        guard.clone()
    }; // settings lock released here
    // Rebuild the tray so checkmarks reflect the new value immediately.
    let _ = app.remove_tray_by_id("instadesk-tray");
    let _ = build_tray(app, &settings);
}

fn build_tray<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Instagram", true, None::<&str>)?;
    let dms = MenuItem::with_id(app, "dms", "Open DMs", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let notify_private = CheckMenuItem::with_id(
        app,
        "notifyPrivate",
        "Private message notifications",
        true,
        settings.notify_private,
        None::<&str>,
    )?;
    let notify_group = CheckMenuItem::with_id(
        app,
        "notifyGroup",
        "Group message notifications",
        true,
        settings.notify_group,
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
    let hide_private = CheckMenuItem::with_id(
        app,
        "hidePrivateChats",
        "Hide private chats",
        true,
        settings.hide_private_chats,
        None::<&str>,
    )?;
    let hide_group = CheckMenuItem::with_id(
        app,
        "hideGroupChats",
        "Hide group chats",
        true,
        settings.hide_group_chats,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let test = MenuItem::with_id(app, "test", "Test Notification", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &dms,
            &settings_item,
            &sep1,
            &notify_private,
            &notify_group,
            &previews,
            &minimize,
            &autostart,
            &hide_private,
            &hide_group,
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
            "notifyPrivate" | "notifyGroup" | "previews" | "minimize" | "autostart"
            | "hidePrivateChats" | "hideGroupChats" => toggle_setting(app, event.id.as_ref()),
            "test" => {
                let _ = dispatch_notification(
                    app,
                    "Test User",
                    "This is a test notification from InstaDesk.",
                    INSTAGRAM_INBOX,
                    "private",
                );
            }
            "quit" => {
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
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
        .invoke_handler(tauri::generate_handler![incoming_message, report_diagnostic, get_settings, update_settings, get_content_controls, window_action, settings_ui_ready, download_media, copy_image])
        .setup(|app| {
            let settings = load_settings(app.handle());
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
                dedup: Mutex::new((HashSet::new(), VecDeque::new())),
                quitting: AtomicBool::new(false),
            });
            build_tray(app.handle(), &settings)?;
            create_settings_window(app.handle())?;
            let window = create_main_window(app.handle())?;
            #[cfg(windows)]
            {
                unsafe {
                    use windows::core::HSTRING;
                    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
                    let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from("com.instadesk.desktop"));
                }
                ensure_windows_shortcut_registered();
            }
            install_toggle_shortcut(app.handle());
            if std::env::args().any(|arg| arg == "--hidden") { let _ = window.hide(); }
            if std::env::args().any(|arg| arg == "--open-settings") { show_settings(app.handle()); }
            #[cfg(debug_assertions)]
            if std::env::args().any(|arg| arg == "--ipc-self-test") {
                let chrome = app.get_webview("main");
                tauri::async_runtime::spawn(async move {
                    // Use a blocking sleep on a dedicated thread so the async
                    // executor thread is not stalled during the 5-second wait.
                    let (tx, rx) = std::sync::mpsc::channel::<()>();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        let _ = tx.send(());
                    });
                    let _ = rx.recv();
                    if let Some(chrome) = chrome {
                        let _ = chrome.eval(r#"window.__TAURI_INTERNALS__.invoke('window_action', { action: 'settings' })
                            .then(() => console.debug('[InstaDesk] IPC self-test passed'))
                            .catch((error) => console.error('[InstaDesk] IPC self-test failed', error))"#);
                    }
                });
            }
            if std::env::args().any(|arg| arg == "--test-notification") {
                dispatch_notification(app.handle(), "Test User", "This is a test notification from InstaDesk.", INSTAGRAM_INBOX, "private")
                    .map_err(std::io::Error::other)?;
                eprintln!("[InstaDesk] test notification dispatched successfully");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running InstaDesk")
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
            quitting: AtomicBool::new(false),
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
