# InstaDesk

InstaDesk is a lightweight, unofficial Windows desktop wrapper for the official Instagram website. It is built with Tauri 2 and focuses on conservative native notifications for one-to-one direct messages.

> InstaDesk is not affiliated with, endorsed by, or distributed by Instagram or Meta. Instagram remains responsible for its website, authentication, and account behavior.

## What it does

- Loads `https://www.instagram.com/` directly in a persistent WebView2 profile.
- Keeps login cookies in the app-specific WebView2 data directory between launches.
- Hides to the Windows system tray when the window is closed (enabled by default).
- Uses a frameless Windows-style titlebar with Settings, native minimize, maximize/restore, fullscreen, and close-to-tray controls. `F11` also toggles fullscreen.
- Provides a native-looking settings dialog and tray actions for Instagram, DMs, notifications, previews, minimize-to-tray, startup, and Quit.
- Supports `Alt+Left` / `Alt+Right` navigation while focused, plus global `Alt+Left` Back and `Ctrl+Right` Forward shortcuts.
- Emits native Windows toasts only for conservatively classified incoming messages in proven one-to-one threads.
- Restores the window and opens the matching thread when a toast is clicked; invalid destinations fall back to the inbox.
- Stores only local settings and transient deduplication keys. It does not store credentials or message history.

## Important notification scope

The observer is intentionally fail-closed. It only accepts a candidate while an Instagram `/direct/t/<id>` conversation is rendered and the conversation header proves that exactly one peer profile is present. It rejects group/ambiguous headers, messages labelled as sent by the user, non-DM routes, and unrelated activity. Existing incoming messages are recorded as a baseline when a thread first opens, so they do not produce startup notifications.

This conservative approach avoids leaking broad Instagram activity into native notifications, but has a practical limitation: Instagram does not expose a supported DM API to wrappers, so a new message can only be detected when Instagram renders that thread in the WebView. If Instagram changes its semantic DOM, detection fails silently with a diagnostic log instead of guessing. Keep Instagram’s inbox or the relevant conversation open for monitoring. A future official API would be preferable if Meta exposes one for this use case.

## Architecture

- `src/instagram/dm-monitor.ts` contains all Instagram-specific selectors, classification, baseline, MutationObserver, and browser-side deduplication.
- `src-tauri/src/lib.rs` owns the remote WebView, strict Instagram-only navigation, settings persistence, tray lifecycle, native deduplication, Windows toast dispatch, and click restoration.
- `src/instagram/dm-monitor.test.ts` exercises sanitized private, group, own-message, duplicate-key, ambiguous, and unrelated-notification DOM cases.
- `src-tauri/generated/dm-monitor.js` is generated from the TypeScript monitor and embedded as a Tauri initialization script.

The remote Instagram page receives only the constrained `incoming_private_dm` command. The native side independently validates the HTTPS Instagram thread URL and required message fields before dispatching a toast.

## Requirements

- Windows 10/11 with Microsoft Edge WebView2 Runtime
- Node.js 20 or later
- Rust stable with the MSVC Windows target
- Tauri’s Windows build prerequisites (Visual Studio C++ Build Tools and WebView2)
- WiX/NSIS are downloaded or located by the Tauri CLI during bundling

## Development

```powershell
npm install
npm test
pnpm dev
```

The debug tray includes **Test Notification (development)**. The equivalent debug launch flag is:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml -- --test-notification
```

Use `--open-settings` in a debug launch to open the settings dialog immediately for UI testing.

Both use the same `dispatch_notification` function as a real parsed DM. The test entry is disabled in release builds.

## Production build

```powershell
npm run desktop:build
```

Outputs:

- `src-tauri/target/release/instadesk.exe`
- `src-tauri/target/release/bundle/nsis/InstaDesk_0.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/InstaDesk_0.1.0_x64_en-US.msi`

## Settings and privacy

Defaults are notifications on, startup off, minimize to tray on, and previews on. Settings are saved under the Tauri app-data directory as `settings.json`. WebView2 owns cookies in its app-specific profile; InstaDesk never receives or saves the Instagram password, cookies, tokens, or credentials. Deduplication metadata is memory-only and capped at 1,000 keys.

Content controls for Home, Reels, Explore, and Search default to off. When enabled, their navigation entries are hidden and attempts to open blocked routes are redirected to the DM inbox. Authentication, account settings, profiles, posts, and direct-message routes remain available.

## Troubleshooting Instagram frontend changes

1. Open the affected private thread and inspect the WebView console in a debug build.
2. Look for `[InstaDesk] DM observer installed`, baseline, classification, or parsing-failure messages.
3. Save only sanitized DOM around the conversation header and a message row—never cookies, tokens, or message history.
4. Update the centralized semantic selectors and fixtures in `src/instagram/dm-monitor.ts` and `dm-monitor.test.ts`.
5. Run `npm test`, then validate a real incoming private DM and a group message before releasing.

Common causes are Instagram removing accessible labels, changing header/profile-link structure, or rendering message rows without semantic incoming/outgoing evidence. Ambiguous structures are ignored by design.
