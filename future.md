# Future work

## Custom in-app notification window (replace Windows toasts)

Replace the Windows toast path (notify-rust + AUMID shortcut) with our own
always-on-top overlay window, so notifications are fully branded, reliably
clickable, and free of the OS-toast quirks we keep fighting.

### Why

- We already run resident in the tray, so the usual downside of custom
  notifications — nothing shows when the app is fully closed — does not apply.
- The toast path has cost us real bugs: rewriting the AUMID `.lnk` on every
  launch, notify-rust's PowerShell app-id fallback in dev builds, and the
  background-thread `wait_for_response` activation that crashed the app on click.
  An in-process window removes that whole class of failure.
- Windows Focus Assist / Do Not Disturb silently swallows toasts, which made
  "not receiving" reports impossible to reason about. We control that ourselves.
- We get rich content for free: avatar, sender, message, and inline actions
  (open conversation, mark seen, quick reply) that toast XML makes painful.

### Shape

- One reusable borderless, transparent, always-on-top WebView window — created
  once and repositioned/reshown per notification, not spawned per toast.
- Non-activating so it never steals focus or the user's typing:
  `WebviewWindowBuilder` with `.focused(false)`, `.skip_taskbar(true)`,
  `.decorations(false)`, `.transparent(true)`, `.always_on_top(true)`, and on
  Windows the `WS_EX_NOACTIVATE` extended style so a click doesn't foreground it.
- A small stack manager: anchor bottom-right above the taskbar work area, stack
  multiple notifications upward with a gap, animate in/out, auto-dismiss on a
  timer (pause on hover), and cap the visible count with a "+N more".
- Content rendered from a dedicated `notification.html` + a typed payload
  (sender, avatar URL, body, event kind, conversation URL) pushed over an event.
- Click routes through the existing `show_instagram(destination)` path already
  used for toast activation — but now on the main thread by construction.

### Gotchas to respect

- Multi-monitor + per-monitor DPI: compute position from the monitor under the
  cursor / the primary work area, not hard-coded pixels.
- Never activate: verify `WS_EX_NOACTIVATE` actually holds after WebView2
  attaches (wry can reset window styles); re-apply on show if needed.
- Avatar images come from Instagram's CDN — reuse the native fetch path
  (`copy_image`/`download_media` style) rather than loading cross-origin in the
  window, to stay within CSP.
- We lose Action Center history; accept that, or keep a lightweight in-app log.
- Still honor Do Not Disturb ourselves (query `QUERY_USER_NOTIFICATION_STATE`)
  so we are not the app that ignores it.

### Hybrid fallback (optional)

Keep Windows toasts only for the case where the main window is fully hidden and
the custom window would be undesirable, and use the custom window as the primary
path. For a single-purpose messaging app, committing fully to the custom window
is the cleaner choice.

### Rough effort

~1 day. Most of the work is positioning/stacking and the non-activating window
plumbing, not the rendering.
