"use strict";
(() => {
  // src/instagram/dm-monitor.ts
  var DEFAULT_CONTROLS = { disableHomeFeed: false, disableReels: false, disableExplore: false, disableSearch: false };
  var THREAD_RE = /^\/direct\/t\/([^/?#]+)\/?/;
  var GROUP_WORDS = /\b(group|members?|participants?|people)\b/i;
  var OWN_WORDS = /\b(you sent|sent by you|your message)\b/i;
  var RECEIVED_WORDS = /\b(received|sent by|message from)\b/i;
  var PROFILE_RE = /^\/(?!direct(?:\/|$)|explore(?:\/|$)|reels?(?:\/|$)|accounts(?:\/|$)|p(?:\/|$))([A-Za-z0-9._]+)\/?$/;
  function normalizedText(node) {
    return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  function stableHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
  function threadIdFromPath(pathname) {
    return pathname.match(THREAD_RE)?.[1] ?? null;
  }
  function blockedDestination(pathname, controls, loggedIn = true) {
    if (!loggedIn) return false;
    if (controls.disableHomeFeed && pathname === "/") return true;
    if (controls.disableReels && /^\/reels?(?:\/|$)/.test(pathname)) return true;
    if (controls.disableSearch && /^\/explore\/search(?:\/|$)/.test(pathname)) return true;
    if (controls.disableExplore && /^\/explore(?:\/|$)/.test(pathname)) return true;
    return false;
  }
  function classifyThread(document) {
    const main = document.querySelector("main") ?? document.body;
    const header = main.querySelector("header") ?? main.querySelector('[role="banner"]');
    if (!header) return { kind: "unknown" };
    const semantic = [header.getAttribute("aria-label"), normalizedText(header)].filter(Boolean).join(" ");
    if (GROUP_WORDS.test(semantic)) return { kind: "group" };
    const peers = /* @__PURE__ */ new Map();
    for (const link of header.querySelectorAll("a[href]")) {
      let path;
      try {
        path = new URL(link.href, "https://www.instagram.com").pathname;
      } catch {
        continue;
      }
      const match = path.match(PROFILE_RE);
      if (!match) continue;
      const handle = match[1].toLowerCase();
      const name = (link.getAttribute("aria-label") || normalizedText(link) || match[1]).trim();
      peers.set(handle, name);
    }
    if (peers.size !== 1) return { kind: peers.size > 1 ? "group" : "unknown" };
    return { kind: "private", peer: [...peers.values()][0] };
  }
  function messageRows(document) {
    const main = document.querySelector("main") ?? document.body;
    const selectors = [
      "[data-message-id]",
      '[role="row"][aria-label]',
      '[role="listitem"][aria-label]',
      'div[aria-label*="message" i]',
      'div[aria-label*="sent" i]',
      'div[aria-label*="received" i]'
    ];
    return [...new Set(selectors.flatMap((selector) => [...main.querySelectorAll(selector)]))];
  }
  function isIncoming(row, peer) {
    const label = `${row.getAttribute("aria-label") ?? ""} ${row.getAttribute("data-testid") ?? ""}`;
    if (OWN_WORDS.test(label)) return false;
    if (RECEIVED_WORDS.test(label) || label.toLowerCase().includes(peer.toLowerCase())) return true;
    const style = row.getAttribute("style") ?? "";
    return /justify-content:\s*flex-start|align-items:\s*flex-start/i.test(style);
  }
  function previewFor(row) {
    const labelled = row.getAttribute("aria-label")?.replace(/^(received|message from|sent by)\s*[^:]*:\s*/i, "").trim();
    const text = labelled || normalizedText(row);
    return text.slice(0, 240);
  }
  function parseCurrentThread(document, location2, now = Date.now()) {
    const conversationId = threadIdFromPath(location2.pathname);
    if (!conversationId) return [];
    const classification = classifyThread(document);
    if (classification.kind !== "private") return [];
    return messageRows(document).flatMap((row) => {
      if (!isIncoming(row, classification.peer)) return [];
      const preview = previewFor(row);
      if (!preview) return [];
      const explicitId = row.getAttribute("data-message-id") || row.getAttribute("data-testid");
      const time = row.querySelector("time")?.getAttribute("datetime") || "";
      return [{
        conversationId,
        conversationUrl: new URL(location2.href).href,
        sender: classification.peer,
        preview,
        messageKey: explicitId || stableHash(`${conversationId}|${classification.peer}|${preview}|${time}`),
        receivedAt: now
      }];
    });
  }
  function installRemoteIpcFallback(win) {
    const nativeFetch = win.fetch.bind(win);
    win.fetch = ((input, init) => {
      try {
        const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        if (new URL(raw, win.location.href).hostname === "ipc.localhost") {
          return Promise.reject(new TypeError("Remote page uses Tauri postMessage IPC"));
        }
      } catch {
      }
      return nativeFetch(input, init);
    });
    const pageConsole = globalThis.console;
    const nativeWarn = pageConsole.warn.bind(pageConsole);
    pageConsole.warn = (...args) => {
      if (args[0] === "IPC custom protocol failed, Tauri will now use the postMessage interface instead") return;
      nativeWarn(...args);
    };
  }
  function nativeAction(win, action) {
    void win.__TAURI_INTERNALS__?.invoke("window_action", { action }).catch((error) => console.warn("[InstaDesk] window action failed", error));
  }
  function installNavigationShortcuts(win) {
    if (win.__INSTADESK_SHORTCUTS__) return;
    win.__INSTADESK_SHORTCUTS__ = true;
    win.addEventListener("keydown", (event) => {
      let action;
      if (event.key === "F11") action = "fullscreen";
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === "ArrowLeft") action = "back";
        if (event.key === "ArrowRight") action = "forward";
      }
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      nativeAction(win, action);
    }, true);
  }
  function installContentControls(win) {
    const style = win.document.createElement("style");
    style.id = "instadesk-content-controls";
    (win.document.head ?? win.document.documentElement).append(style);
    let controls = { ...DEFAULT_CONTROLS };
    let redirecting = false;
    const loggedIn = () => Boolean(win.document.querySelector('a[href^="/direct/"]')) && !win.document.querySelector('input[name="password"]');
    const apply = () => {
      const rules = [];
      if (controls.disableHomeFeed) rules.push('a[href="/"]');
      if (controls.disableReels) rules.push('a[href^="/reels"]');
      if (controls.disableExplore) rules.push('a[href^="/explore"]');
      if (controls.disableSearch) rules.push('[role="button"]:has([aria-label="Search"]),a:has([aria-label="Search"])');
      style.textContent = rules.length ? `${rules.join(",")} { display:none !important; }` : "";
      if (!redirecting && blockedDestination(win.location.pathname, controls, loggedIn())) {
        redirecting = true;
        console.debug("[InstaDesk] blocked page redirected to DMs", { pathname: win.location.pathname });
        win.location.replace("/direct/inbox/");
      }
    };
    const refresh = async () => {
      try {
        controls = { ...DEFAULT_CONTROLS, ...await win.__TAURI_INTERNALS__?.invoke("get_content_controls") };
        redirecting = false;
        apply();
      } catch (error) {
        console.warn("[InstaDesk] could not load content controls", error);
      }
    };
    win.document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (controls.disableSearch && target.closest('[aria-label="Search"]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const link = target.closest("a[href]");
      if (!link) return;
      try {
        if (blockedDestination(new URL(link.href, win.location.href).pathname, controls, loggedIn())) {
          event.preventDefault();
          event.stopImmediatePropagation();
          win.location.assign("/direct/inbox/");
        }
      } catch {
      }
    }, true);
    new MutationObserver(apply).observe(win.document.documentElement, { childList: true, subtree: true });
    win.addEventListener("popstate", apply);
    win.addEventListener("instadesk:settings-changed", () => void refresh());
    void refresh();
  }
  function installMonitor(win) {
    if (win.__INSTADESK_MONITOR__) return;
    win.__INSTADESK_MONITOR__ = true;
    const seen = /* @__PURE__ */ new Set();
    let primed = false;
    let activeConversation = null;
    let timer;
    const scan = () => {
      timer = void 0;
      try {
        const conversation = threadIdFromPath(win.location.pathname);
        if (conversation !== activeConversation) {
          activeConversation = conversation;
          primed = false;
          seen.clear();
          console.debug("[InstaDesk] conversation changed; resetting baseline", { conversation });
        }
        const candidates = parseCurrentThread(win.document, win.location);
        if (!primed) {
          candidates.forEach((item) => seen.add(`${item.conversationId}:${item.messageKey}`));
          primed = true;
          console.debug(`[InstaDesk] monitor primed with ${seen.size} existing incoming messages`);
          return;
        }
        for (const item of candidates) {
          const key = `${item.conversationId}:${item.messageKey}`;
          if (seen.has(key)) continue;
          seen.add(key);
          console.debug("[InstaDesk] incoming private DM detected", { conversationId: item.conversationId, sender: item.sender });
          void win.__TAURI_INTERNALS__?.invoke("incoming_private_dm", { message: item }).catch((error) => console.warn("[InstaDesk] native dispatch failed", error));
        }
        if (seen.size > 1e3) [...seen].slice(0, 250).forEach((key) => seen.delete(key));
      } catch (error) {
        console.warn("[InstaDesk] parsing failure", error);
      }
    };
    const schedule = () => {
      if (timer === void 0) timer = win.setTimeout(scan, 350);
    };
    new MutationObserver(schedule).observe(win.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "data-message-id"] });
    win.addEventListener("popstate", schedule);
    win.addEventListener("hashchange", schedule);
    schedule();
    console.debug("[InstaDesk] DM observer installed");
  }
  if (typeof window !== "undefined" && location.hostname.endsWith("instagram.com")) {
    installRemoteIpcFallback(window);
    installNavigationShortcuts(window);
    installContentControls(window);
    installMonitor(window);
  }
})();
