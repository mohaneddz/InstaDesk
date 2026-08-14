import { invoke } from "@tauri-apps/api/core";
import "./style.css";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="titlebar">
    <button class="button settings" data-action="settings" type="button" aria-label="Open settings" title="Settings">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>
    </button>
    <div class="drag-region" data-action="drag" aria-label="Drag window"></div>
    <div class="window-controls">
      <button class="button" data-action="minimize" type="button" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 9.5h10"/></svg></button>
      <button class="button" data-action="maximize" type="button" aria-label="Maximize" title="Maximize"><svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9"/></svg></button>
      <button class="button close" data-action="close" type="button" aria-label="Close" title="Close to tray"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9"/></svg></button>
    </div>
  </header>`;

document.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => {
  const action = element.dataset.action!;
  const eventName = action === "drag" ? "pointerdown" : "click";
  element.addEventListener(eventName, () => void invoke("window_action", { action }));
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "F11") return;
  event.preventDefault();
  void invoke("window_action", { action: "fullscreen" });
}, true);
