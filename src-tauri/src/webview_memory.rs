//! Keeps the WebView2 instances from holding on to memory the user cannot see.
//!
//! InstaDesk runs three WebViews at once: the custom titlebar, the Instagram
//! page the user looks at, and a second Instagram page behind it whose only
//! job is watching the DM inbox. Two live copies of an SPA as heavy as
//! Instagram is most of the app's resident memory, and while the window is
//! hidden or minimized the visible one is paying rent for nothing.
//!
//! So when the window goes away the foreground Instagram WebView is suspended
//! outright — WebView2 tears down its renderer and restores it on `Resume`,
//! preserving page state — while the inbox WebView stays running so
//! notifications keep arriving, only asked to hold less. Afterwards the
//! working sets of the browser processes are handed back to the OS.

use tauri::{AppHandle, Manager, Runtime};

/// The titlebar is a few hundred KB of local HTML; suspending it would risk
/// the one surface the user needs to get the window back for no real gain.
/// The inbox WebView is what detects new messages and must stay awake.
const SUSPENDABLE: &str = "instagram";
const ALL: [&str; 3] = ["main", "inbox", "instagram"];

pub fn release<R: Runtime>(app: &AppHandle<R>) {
    for label in ALL {
        let Some(webview) = app.get_webview(label) else {
            continue;
        };
        let suspend = label == SUSPENDABLE;
        let _ = webview.with_webview(move |platform| platform_release(&platform, suspend));
    }
    trim_working_sets(app);
    eprintln!("[InstaDesk] webviews trimmed for the background");
}

pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    for label in ALL {
        let Some(webview) = app.get_webview(label) else {
            continue;
        };
        let resume = label == SUSPENDABLE;
        let _ = webview.with_webview(move |platform| platform_restore(&platform, resume));
    }
    eprintln!("[InstaDesk] webviews restored to the foreground");
}

#[cfg(windows)]
fn platform_release(platform: &tauri::webview::PlatformWebview, suspend: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    use webview2_com::TrySuspendCompletedHandler;
    use windows::core::Interface;

    let controller = platform.controller();
    unsafe {
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        if let Ok(core) = core.cast::<ICoreWebView2_19>() {
            let _ = core.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
        }
        if !suspend {
            return;
        }
        // TrySuspend refuses a visible WebView, and the controller stays
        // "visible" as far as WebView2 is concerned even once the host window
        // is hidden, so its own visibility has to be dropped first.
        let _ = controller.SetIsVisible(false);
        if let Ok(core) = core.cast::<ICoreWebView2_3>() {
            let _ = core.TrySuspend(&TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(()))));
        }
    }
}

#[cfg(windows)]
fn platform_restore(platform: &tauri::webview::PlatformWebview, resume: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;

    let controller = platform.controller();
    unsafe {
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        if resume {
            if let Ok(core) = core.cast::<ICoreWebView2_3>() {
                let _ = core.Resume();
            }
            let _ = controller.SetIsVisible(true);
        }
        if let Ok(core) = core.cast::<ICoreWebView2_19>() {
            let _ = core.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
        }
    }
}

/// Suspending frees the renderer's own allocations, but the pages those
/// allocations lived in stay mapped into the browser processes' working sets
/// until something asks for them back. Nothing else will ask while the app is
/// hidden, so the numbers in Task Manager would keep looking the same as
/// before. Trimming hands them to the OS now; anything still needed is paged
/// back in on the next access.
#[cfg(windows)]
fn trim_working_sets<R: Runtime>(app: &AppHandle<R>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment8;
    use windows::core::Interface;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, SetProcessWorkingSetSize, PROCESS_SET_QUOTA,
    };

    unsafe {
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
    let Some(webview) = app.get_webview("main") else {
        return;
    };
    let _ = webview.with_webview(|platform| {
        let environment = platform.environment();
        unsafe {
            let Ok(environment) = environment.cast::<ICoreWebView2Environment8>() else {
                return;
            };
            let Ok(processes) = environment.GetProcessInfos() else {
                return;
            };
            let mut count = 0u32;
            if processes.Count(&mut count).is_err() {
                return;
            }
            for index in 0..count {
                let Ok(info) = processes.GetValueAtIndex(index) else {
                    continue;
                };
                let mut pid = 0i32;
                if info.ProcessId(&mut pid).is_err() || pid <= 0 {
                    continue;
                }
                let Ok(handle) = OpenProcess(PROCESS_SET_QUOTA, false, pid as u32) else {
                    continue;
                };
                let _ = SetProcessWorkingSetSize(handle, usize::MAX, usize::MAX);
                let _ = CloseHandle(handle);
            }
        }
    });
}

#[cfg(not(windows))]
fn platform_release(_platform: &tauri::webview::PlatformWebview, _suspend: bool) {}

#[cfg(not(windows))]
fn platform_restore(_platform: &tauri::webview::PlatformWebview, _resume: bool) {}

#[cfg(not(windows))]
fn trim_working_sets<R: Runtime>(_app: &AppHandle<R>) {}
