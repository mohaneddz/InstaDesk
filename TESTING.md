# InstaDesk test record

Tested on Windows on 2026-08-13. A checkbox is marked only where the behavior was directly exercised or independently verified by an automated test on this machine.

## Automated and build verification

- [x] TypeScript production build succeeds (`npm run build`).
- [x] Rust/Tauri backend compiles (`cargo check`).
- [x] All 9 DOM/parser and content-control tests pass (`pnpm test`).
- [x] Private 1:1 fixture is classified and parsed.
- [x] Own-message fixture is ignored.
- [x] Group fixture is ignored.
- [x] Ambiguous thread fixture fails closed.
- [x] Unrelated Instagram activity fixture is ignored.
- [x] Stable fallback message key prevents DOM-rerender duplicates.
- [x] Native URL validation accepts only HTTPS Instagram destinations.
- [x] Native deduplication rejects repeats and remains capped at 1,000 keys.
- [x] NSIS installer generated.
- [x] MSI installer generated.

## Runtime verification performed

- [x] Uninstalled release executable starts successfully.
- [x] Packaged Instagram WebView opens with window title `Instagram`.
- [x] Normal window close leaves the process running in tray mode.
- [x] NSIS installer completed successfully (exit code 0).
- [x] Installed binary at `%LOCALAPPDATA%\InstaDesk\instadesk.exe` starts successfully.
- [x] Persistent WebView2 profile directory is created under `%LOCALAPPDATA%\com.instadesk.desktop\EBWebView`.
- [x] No CPU runaway observed: packaged process used 0.20 CPU-seconds after 15 seconds; installed process used 0.12 CPU-seconds after 12 seconds.
- [x] Both Instagram and Settings windows are created with Tauri decorations disabled and custom titlebars.
- [x] Installed settings dialog loads from the packaged bundle with no localhost dependency.
- [x] Closing the updated installed Instagram window leaves the process running in tray mode.
- [x] Local `Alt+Left` / `Alt+Right` and global `Alt+Left` / `Ctrl+Right` handlers compile and register during startup.
- [x] Required maximize, minimize, restore, hide, close, drag, and state-check window capabilities are explicitly declared.
- [x] Home, Reels, Explore, and Search blocking rules are independently covered by route tests.
- [x] Login and direct-message routes remain allowed by content-control tests.
- [x] `pnpm dev` launches the Tauri debug app and its Instagram window.
- [x] Build-time application ACL generates permissions for all five custom Rust commands.
- [x] Remote Instagram IPC self-test invoked `window_action` and opened the Settings window through Tauri's postMessage transport.
- [x] Settings UI reports native readiness after its module renders; its URL is derived from Tauri's configured Vite address in development and uses the embedded bundle in production.
- [x] Minimize changes the native window to an iconic/minimized state.
- [x] Close hides the Instagram window while leaving the process alive in the tray.
- [x] Frameless maximize/restore now uses the actual Windows HWND state instead of Tauri's unreliable frameless `is_maximized` result.
- [ ] Navigation destinations after shortcut presses — requires interactive history navigation verification.
- [ ] Login/session persistence with a real Instagram account — not tested because no credentials were requested or supplied.
- [x] Development test notification reached the same native dispatch function and returned success.
- [ ] Native test notification visually observed/clicked — the non-interactive test harness cannot confirm the visible toast or user click.
- [ ] Real incoming private DM notification — requires a logged-in account and a second sender.
- [ ] Several real incoming private DMs — requires external account interaction.
- [ ] Real sent-by-self message ignored — fixture passed; live account test not performed.
- [ ] Real group message ignored — fixture passed; live account test not performed.
- [ ] Real likes/comments/follows ignored — route fixture passed; live account test not performed.
- [ ] Notification while minimized/hidden — native dispatch path is process-independent, but a live DM was not available.
- [ ] Notification click opens matching conversation — implementation compiled; visual click not yet exercised.
- [ ] Tray Quit actually terminates process — command path compiled; tray UI click not automated.

## Resource observation

The native process working set was about 38 MB. Instagram’s six WebView2 processes together used approximately 479 MB after initial load. CPU was quiet. Memory is dominated by Instagram/Chromium and is higher than a native chat client, but no continuously growing or busy-loop behavior was observed during the short run.

## Real-DM acceptance procedure

1. Log into Instagram only through the official page shown by InstaDesk.
2. Open an existing one-to-one thread and wait for the baseline log.
3. From another account, send a new unique message.
4. Confirm one `incoming private DM detected` browser log and one native `notification dispatched` log/toast.
5. Click the toast and confirm the same `/direct/t/<id>` opens.
6. Send another message and verify exactly one additional toast.
7. Send from the logged-in account and verify no toast.
8. Repeat in a group and verify no toast.
9. Hide the window to the tray while leaving the private thread loaded, send again, and verify the toast.
10. Quit from the tray and confirm the process exits.
