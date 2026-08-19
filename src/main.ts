import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";

// SVG inner content for maximize vs restore state
const MAXIMIZE_ICON = `<rect x="1.5" y="1.5" width="9" height="9"/>`;
const RESTORE_ICON  = `<rect x="3.5" y="1.5" width="7" height="7"/><rect x="1.5" y="3.5" width="7" height="7"/>`;
// SVG inner content for fullscreen enter vs exit state
const FULLSCREEN_ENTER_ICON = `<path d="M1.5 4.5V1.5H4.5M7.5 1.5H10.5V4.5M10.5 7.5V10.5H7.5M4.5 10.5H1.5V7.5"/>`;
const FULLSCREEN_EXIT_ICON  = `<path d="M4.5 1.5V4.5H1.5M10.5 4.5V1.5H7.5M7.5 10.5V7.5H10.5M1.5 7.5V10.5H4.5"/>`;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="titlebar">
    <button class="button settings" data-action="settings" type="button" aria-label="Open settings" title="Settings">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>
    </button>
    <div class="drag-region" data-action="drag" aria-label="Drag window"></div>
    <div class="window-controls">
      <button class="button" data-action="minimize" type="button" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 9.5h10"/></svg></button>
      <button class="button" data-action="maximize" type="button" aria-label="Maximize" title="Maximize"><svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9"/></svg></button>
      <button class="button" data-action="fullscreen" type="button" aria-label="Enter fullscreen" title="Enter fullscreen"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 4.5V1.5H4.5M7.5 1.5H10.5V4.5M10.5 7.5V10.5H7.5M4.5 10.5H1.5V7.5"/></svg></button>
      <button class="button close" data-action="close" type="button" aria-label="Close" title="Close to tray"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9"/></svg></button>
    </div>
  </header>`;

document.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => {
  const action = element.dataset.action!;
  const eventName = action === "drag" ? "pointerdown" : "click";
  element.addEventListener(eventName, () => void invoke("window_action", { action }));
});

// Left Alt + Right Alt is owned by the native keyboard hook, which sees the
// chord whether or not the app has focus. Toggling from here as well fired it
// twice while focused, hiding and immediately reshowing the window.
window.addEventListener("keydown", (event) => {
  if (event.key === "F11") {
    event.preventDefault();
    void invoke("window_action", { action: "fullscreen" });
  }
}, true);

// Keep maximize/restore and fullscreen buttons in sync with the actual window
// state. The chrome WebView is resized by layout_main_window whenever the
// parent window changes, so the JS `resize` event is a reliable signal.
const win = getCurrentWindow();
const maximizeBtn   = document.querySelector<HTMLButtonElement>('[data-action="maximize"]')!;
const maximizeSvg   = maximizeBtn.querySelector("svg")!;
const fullscreenBtn = document.querySelector<HTMLButtonElement>('[data-action="fullscreen"]')!;
const fullscreenSvg = fullscreenBtn.querySelector("svg")!;

async function syncWindowButtons(): Promise<void> {
  try {
    const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
    maximizeBtn.ariaLabel = maximized ? "Restore" : "Maximize";
    maximizeBtn.title     = maximized ? "Restore" : "Maximize";
    maximizeSvg.innerHTML = maximized ? RESTORE_ICON : MAXIMIZE_ICON;
    fullscreenBtn.ariaLabel = fullscreen ? "Exit fullscreen" : "Enter fullscreen";
    fullscreenBtn.title     = fullscreen ? "Exit fullscreen" : "Enter fullscreen";
    fullscreenSvg.innerHTML = fullscreen ? FULLSCREEN_EXIT_ICON : FULLSCREEN_ENTER_ICON;
  } catch { /* best effort — window may not be ready yet */ }
}

window.addEventListener("resize", () => void syncWindowButtons());
void syncWindowButtons();
