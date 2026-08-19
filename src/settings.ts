import { invoke } from "@tauri-apps/api/core";
import "./settings.css";

interface Settings {
  notifyPrivate: boolean;
  notifyGroup: boolean;
  launchAtStartup: boolean;
  minimizeToTray: boolean;
  notificationPreviews: boolean;
  disableHomeFeed: boolean;
  disableReels: boolean;
  disableExplore: boolean;
  disableSearch: boolean;
  disablePosts: boolean;
  disableStories: boolean;
  disableSuggestions: boolean;
  ghostStories: boolean;
  hidePrivateChats: boolean;
  hideGroupChats: boolean;
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
      <label><span><b>Private message notifications</b><small>Show a Windows notification for new 1:1 direct messages.</small></span><input id="notifyPrivate" type="checkbox"><i></i></label>
      <label><span><b>Group message notifications</b><small>Show a Windows notification for new group chat messages.</small></span><input id="notifyGroup" type="checkbox"><i></i></label>
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
      <label><span><b>Disable Posts</b><small>Hide posts from the Home feed.</small></span><input id="disablePosts" type="checkbox"><i></i></label>
      <label><span><b>Disable Stories</b><small>Hide the stories row from Home.</small></span><input id="disableStories" type="checkbox"><i></i></label>
      <label><span><b>Disable Suggestions</b><small>Hide suggested accounts and center the feed.</small></span><input id="disableSuggestions" type="checkbox"><i></i></label>
    </div>
    <div class="section-heading"><span><b>Story privacy</b><small>Control what viewing a story reports back.</small></span></div>
    <div class="settings-list">
      <label><span><b>Ghost story viewer</b><small>View stories without sending a seen receipt.</small></span><input id="ghostStories" type="checkbox"><i></i></label>
    </div>
    <div class="section-heading"><span><b>Chat visibility</b><small>Hide entire categories of chats from the Instagram inbox.</small></span></div>
    <div class="settings-list">
      <label><span><b>Hide private chats</b><small>Hide 1:1 conversations from the inbox list and block opening them.</small></span><input id="hidePrivateChats" type="checkbox"><i></i></label>
      <label><span><b>Hide group chats</b><small>Hide group conversations from the inbox list and block opening them.</small></span><input id="hideGroupChats" type="checkbox"><i></i></label>
    </div>
    <section class="shortcuts" aria-labelledby="shortcuts-title">
      <div class="shortcuts-copy"><b id="shortcuts-title">Keyboard shortcuts</b><small>Quickly show or hide InstaDesk.</small></div>
      <div class="shortcut-list">
        <div class="shortcut-row"><span>Toggle app</span><span class="keys"><kbd>Ctrl</kbd><em>+</em><kbd>Alt</kbd><em>+</em><kbd>I</kbd></span></div>
      </div>
      <p class="global-note">Toggle app is available globally, including while InstaDesk is hidden.</p>
    </section>
    <footer><span class="status-dot" aria-hidden="true"></span><p id="status" role="status">Settings save automatically</p></footer>
  </section>`;

const status = document.querySelector<HTMLElement>("#status")!;
const keys: (keyof Settings)[] = [
  "notifyPrivate", "notifyGroup", "notificationPreviews", "minimizeToTray", "launchAtStartup",
  "disableHomeFeed", "disableReels", "disableExplore", "disableSearch",
  "disablePosts", "disableStories", "disableSuggestions", "ghostStories",
  "hidePrivateChats", "hideGroupChats"
];
// Initialized to undefined until load() resolves; the change handler guards
// against the (practically impossible but architecturally possible) case where
// a toggle event fires before the first IPC round-trip completes.
let current: Settings | undefined;
void invoke("settings_ui_ready");

async function load(): Promise<void> {
  current = await invoke<Settings>("get_settings");
  for (const key of keys) document.querySelector<HTMLInputElement>(`#${key}`)!.checked = current[key];
}

for (const key of keys) {
  document.querySelector<HTMLInputElement>(`#${key}`)!.addEventListener("change", async (event) => {
    if (!current) return; // load() hasn't resolved yet — ignore the premature event
    current[key] = (event.currentTarget as HTMLInputElement).checked;
    status.textContent = "Saving…";
    try {
      current = await invoke<Settings>("update_settings", { settings: current });
      status.textContent = "Saved";
      // Reset the status message after a short delay so it doesn't stick forever.
      setTimeout(() => {
        if (status.textContent === "Saved") status.textContent = "Settings save automatically";
      }, 2000);
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

window.addEventListener("focus", () => { void load(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void load();
});

void load().catch((error) => { status.textContent = `Could not load settings: ${String(error)}`; });
