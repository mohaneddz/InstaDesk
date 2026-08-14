import { invoke } from "@tauri-apps/api/core";
import "./settings.css";

interface Settings {
  notifications: boolean;
  launchAtStartup: boolean;
  minimizeToTray: boolean;
  notificationPreviews: boolean;
  disableHomeFeed: boolean;
  disableReels: boolean;
  disableExplore: boolean;
  disableSearch: boolean;
}

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
  <header class="titlebar" data-drag>
    <div class="brand" data-drag><span class="app-icon">ID</span><span>Settings</span></div>
    <button class="close" type="button" aria-label="Close settings">×</button>
  </header>
  <section class="content">
    <h1>InstaDesk settings</h1>
    <p class="lead">Choose how Instagram behaves on your desktop.</p>
    <div class="settings-list">
      <label><span><b>Native notifications</b><small>Show Windows notifications for verified private DMs.</small></span><input id="notifications" type="checkbox"><i></i></label>
      <label><span><b>Notification previews</b><small>Include message text in notifications.</small></span><input id="notificationPreviews" type="checkbox"><i></i></label>
      <label><span><b>Minimize to tray</b><small>Keep Instagram running when its window is closed.</small></span><input id="minimizeToTray" type="checkbox"><i></i></label>
      <label><span><b>Launch on startup</b><small>Start InstaDesk quietly with Windows.</small></span><input id="launchAtStartup" type="checkbox"><i></i></label>
    </div>
    <div class="section-heading"><span><b>Content controls</b><small>Hide distractions and keep Instagram focused on messages.</small></span></div>
    <div class="settings-list content-controls">
      <label><span><b>Disable Home feed</b><small>Open DMs instead of the main feed.</small></span><input id="disableHomeFeed" type="checkbox"><i></i></label>
      <label><span><b>Disable Reels</b><small>Hide and block Reels pages.</small></span><input id="disableReels" type="checkbox"><i></i></label>
      <label><span><b>Disable Explore</b><small>Hide and block Explore pages.</small></span><input id="disableExplore" type="checkbox"><i></i></label>
      <label><span><b>Disable Search</b><small>Hide Instagram’s search entry.</small></span><input id="disableSearch" type="checkbox"><i></i></label>
    </div>
    <section class="shortcuts" aria-labelledby="shortcuts-title">
      <div class="shortcuts-copy"><b id="shortcuts-title">Navigation shortcuts</b><small>Move through your Instagram history.</small></div>
      <div class="shortcut-list">
        <div class="shortcut-row"><span>Back</span><span class="keys"><kbd>Alt</kbd><em>+</em><kbd>←</kbd></span></div>
        <div class="shortcut-row"><span>Forward</span><span class="keys"><kbd>Alt</kbd><em>+</em><kbd>→</kbd></span></div>
      </div>
      <p class="global-note">Global shortcuts: <strong>Alt + Left</strong> and <strong>Ctrl + Right</strong></p>
    </section>
    <footer><span class="status-dot" aria-hidden="true"></span><p id="status" role="status">Settings save automatically</p></footer>
  </section>`;

const status = document.querySelector<HTMLElement>("#status")!;
const keys: (keyof Settings)[] = [
  "notifications", "notificationPreviews", "minimizeToTray", "launchAtStartup",
  "disableHomeFeed", "disableReels", "disableExplore", "disableSearch"
];
let current: Settings;
void invoke("settings_ui_ready");

async function load(): Promise<void> {
  current = await invoke<Settings>("get_settings");
  for (const key of keys) document.querySelector<HTMLInputElement>(`#${key}`)!.checked = current[key];
}

for (const key of keys) {
  document.querySelector<HTMLInputElement>(`#${key}`)!.addEventListener("change", async (event) => {
    current[key] = (event.currentTarget as HTMLInputElement).checked;
    status.textContent = "Saving…";
    try {
      current = await invoke<Settings>("update_settings", { settings: current });
      status.textContent = "Saved";
    } catch (error) {
      status.textContent = `Could not save: ${String(error)}`;
      await load();
    }
  });
}

document.querySelector(".close")!.addEventListener("click", () => void invoke("window_action", { action: "close_settings" }));
document.querySelector(".titlebar")!.addEventListener("pointerdown", (event) => {
  if ((event.target as Element).closest("button")) return;
  void invoke("window_action", { action: "drag_settings" });
});

void load().catch((error) => { status.textContent = `Could not load settings: ${String(error)}`; });
