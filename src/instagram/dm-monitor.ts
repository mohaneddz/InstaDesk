/**
 * Instagram DOM adapter. This module deliberately fails closed: a notification
 * is emitted only when a direct thread, its peer, and an incoming message can
 * all be identified from semantic DOM and URL evidence.
 */

export interface DmCandidate {
  conversationId: string;
  conversationUrl: string;
  sender: string;
  preview: string;
  messageKey: string;
  receivedAt: number;
}

export interface ContentControls {
  disableHomeFeed: boolean;
  disableReels: boolean;
  disableExplore: boolean;
  disableSearch: boolean;
}

const DEFAULT_CONTROLS: ContentControls = { disableHomeFeed: false, disableReels: false, disableExplore: false, disableSearch: false };

const THREAD_RE = /^\/direct\/t\/([^/?#]+)\/?/;
const GROUP_WORDS = /\b(group|members?|participants?|people)\b/i;
const OWN_WORDS = /\b(you sent|sent by you|your message)\b/i;
const RECEIVED_WORDS = /\b(received|sent by|message from)\b/i;
const PROFILE_RE = /^\/(?!direct(?:\/|$)|explore(?:\/|$)|reels?(?:\/|$)|accounts(?:\/|$)|p(?:\/|$))([A-Za-z0-9._]+)\/?$/;

function normalizedText(node: Element | null): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function threadIdFromPath(pathname: string): string | null {
  return pathname.match(THREAD_RE)?.[1] ?? null;
}

export function blockedDestination(pathname: string, controls: ContentControls, loggedIn = true): boolean {
  if (!loggedIn) return false;
  if (controls.disableHomeFeed && pathname === "/") return true;
  if (controls.disableReels && /^\/reels?(?:\/|$)/.test(pathname)) return true;
  if (controls.disableSearch && /^\/explore\/search(?:\/|$)/.test(pathname)) return true;
  if (controls.disableExplore && /^\/explore(?:\/|$)/.test(pathname)) return true;
  return false;
}

/** Returns exactly one peer only when the header proves this is a 1:1 thread. */
export function classifyThread(document: Document): { kind: "private"; peer: string } | { kind: "group" | "unknown" } {
  const main = document.querySelector("main") ?? document.body;
  const header = main.querySelector("header") ?? main.querySelector('[role="banner"]');
  if (!header) return { kind: "unknown" };

  const semantic = [header.getAttribute("aria-label"), normalizedText(header)].filter(Boolean).join(" ");
  if (GROUP_WORDS.test(semantic)) return { kind: "group" };

  const peers = new Map<string, string>();
  for (const link of header.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let path: string;
    try { path = new URL(link.href, "https://www.instagram.com").pathname; } catch { continue; }
    const match = path.match(PROFILE_RE);
    if (!match) continue;
    const handle = match[1].toLowerCase();
    const name = (link.getAttribute("aria-label") || normalizedText(link) || match[1]).trim();
    peers.set(handle, name);
  }

  if (peers.size !== 1) return { kind: peers.size > 1 ? "group" : "unknown" };
  return { kind: "private", peer: [...peers.values()][0] };
}

function messageRows(document: Document): Element[] {
  const main = document.querySelector("main") ?? document.body;
  const selectors = [
    '[data-message-id]',
    '[role="row"][aria-label]',
    '[role="listitem"][aria-label]',
    'div[aria-label*="message" i]',
    'div[aria-label*="sent" i]',
    'div[aria-label*="received" i]'
  ];
  return [...new Set(selectors.flatMap((selector) => [...main.querySelectorAll(selector)]))];
}

function isIncoming(row: Element, peer: string): boolean {
  const label = `${row.getAttribute("aria-label") ?? ""} ${row.getAttribute("data-testid") ?? ""}`;
  if (OWN_WORDS.test(label)) return false;
  if (RECEIVED_WORDS.test(label) || label.toLowerCase().includes(peer.toLowerCase())) return true;
  // Current Instagram rows generally align outgoing bubbles at the end/right.
  // Alignment is supporting evidence only; absence stays unknown (false).
  const style = row.getAttribute("style") ?? "";
  return /justify-content:\s*flex-start|align-items:\s*flex-start/i.test(style);
}

function previewFor(row: Element): string {
  const labelled = row.getAttribute("aria-label")?.replace(/^(received|message from|sent by)\s*[^:]*:\s*/i, "").trim();
  const text = labelled || normalizedText(row);
  return text.slice(0, 240);
}

export function parseCurrentThread(document: Document, location: Pick<Location, "pathname" | "href">, now = Date.now()): DmCandidate[] {
  const conversationId = threadIdFromPath(location.pathname);
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
      conversationUrl: new URL(location.href).href,
      sender: classification.peer,
      preview,
      messageKey: explicitId || stableHash(`${conversationId}|${classification.peer}|${preview}|${time}`),
      receivedAt: now
    }];
  });
}

declare global {
  interface Window {
    __INSTADESK_MONITOR__?: boolean;
    __INSTADESK_SHORTCUTS__?: boolean;
    __INSTADESK_CONTROLS__?: boolean;
    __INSTADESK_CONTENT_CONTROLS__?: Partial<ContentControls>;
    __TAURI_INTERNALS__?: { invoke: (command: string, args?: unknown) => Promise<unknown> };
  }
}

/**
 * Remote sites commonly block Tauri's ipc.localhost fetch with their CSP.
 * Reject that one internal transport before the browser attempts it so Tauri
 * cleanly selects its built-in postMessage fallback without noisy CSP errors.
 */
function installRemoteIpcFallback(win: Window): void {
  const nativeFetch = win.fetch.bind(win);
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      if (new URL(raw, win.location.href).hostname === "ipc.localhost") {
        return Promise.reject(new TypeError("Remote page uses Tauri postMessage IPC"));
      }
    } catch { /* Pass malformed requests through to the native fetch implementation. */ }
    return nativeFetch(input, init);
  }) as typeof fetch;
  const pageConsole = globalThis.console;
  const nativeWarn = pageConsole.warn.bind(pageConsole);
  pageConsole.warn = (...args: unknown[]) => {
    if (args[0] === "IPC custom protocol failed, Tauri will now use the postMessage interface instead") return;
    nativeWarn(...args);
  };
}

function nativeAction(win: Window, action: string): void {
  void win.__TAURI_INTERNALS__?.invoke("window_action", { action }).catch((error) => console.warn("[InstaDesk] window action failed", error));
}

/** Captures app navigation shortcuts before Instagram handles the key event. */
export function installNavigationShortcuts(win: Window): void {
  if (win.__INSTADESK_SHORTCUTS__) return;
  win.__INSTADESK_SHORTCUTS__ = true;
  win.addEventListener("keydown", (event) => {
    let action: string | undefined;
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

/** Applies optional distraction controls while leaving login/account pages alone. */
export function installContentControls(win: Window): void {
  if (win.__INSTADESK_CONTROLS__) return;
  win.__INSTADESK_CONTROLS__ = true;
  const style = win.document.createElement("style");
  style.id = "instadesk-content-controls";
  (win.document.head ?? win.document.documentElement).append(style);
  let controls = { ...DEFAULT_CONTROLS, ...win.__INSTADESK_CONTENT_CONTROLS__ };
  let redirecting = false;

  const loggedIn = () => Boolean(win.document.querySelector('a[href^="/direct/"]')) && !win.document.querySelector('input[name="password"]');
  const apply = () => {
    const rules: string[] = [];
    if (controls.disableHomeFeed) rules.push('a[href="/"]:has([aria-label="Home"]),a[href="https://www.instagram.com/"]:has([aria-label="Home"])');
    if (controls.disableReels) rules.push('a[href*="/reels"]:has([aria-label="Reels"]),a:has([aria-label="Reels"])');
    if (controls.disableExplore) rules.push('a[href*="/explore"]:has([aria-label="Explore"]),a:has([aria-label="Explore"])');
    if (controls.disableSearch) rules.push('[role="button"]:has([aria-label="Search"]),[role="link"]:has([aria-label="Search"]),a:has([aria-label="Search"])');
    style.textContent = rules.length ? `${rules.join(",")} { display:none !important; }` : "";
    const pathname = win.location?.pathname;
    if (!pathname) return;
    if (!redirecting && blockedDestination(pathname, controls, loggedIn())) {
      redirecting = true;
      console.debug("[InstaDesk] blocked page redirected to DMs", { pathname });
      win.location.replace("/direct/inbox/");
    }
  };
  const refresh = async () => {
    try {
      controls = { ...DEFAULT_CONTROLS, ...await win.__TAURI_INTERNALS__?.invoke("get_content_controls") as Partial<ContentControls> };
      win.__INSTADESK_CONTENT_CONTROLS__ = controls;
      redirecting = false;
      apply();
    } catch (error) {
      // The native shell also injects the last saved state at document start,
      // so controls remain functional if remote-page IPC is unavailable.
      apply();
      console.warn("[InstaDesk] could not refresh content controls", error);
    }
  };
  win.document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    if (controls.disableSearch && target.closest('[aria-label="Search"]')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    try {
      if (blockedDestination(new URL(link.href, win.location.href).pathname, controls, loggedIn())) {
        event.preventDefault(); event.stopImmediatePropagation();
        win.location.assign("/direct/inbox/");
      }
    } catch { /* Ignore malformed third-party links. */ }
  }, true);
  // Watch Instagram's app tree, not <head>; apply() rewrites our stylesheet and
  // observing that write would continuously trigger the observer itself.
  new MutationObserver(apply).observe(win.document.body, { childList: true, subtree: true });
  win.addEventListener("popstate", apply);
  win.addEventListener("instadesk:settings-changed", (event) => {
    const changed = (event as CustomEvent<Partial<ContentControls>>).detail;
    if (!changed) { void refresh(); return; }
    controls = { ...DEFAULT_CONTROLS, ...changed };
    win.__INSTADESK_CONTENT_CONTROLS__ = controls;
    redirecting = false;
    apply();
  });
  apply();
  void refresh();
}

export function installMonitor(win: Window): void {
  if (win.__INSTADESK_MONITOR__) return;
  win.__INSTADESK_MONITOR__ = true;
  const seen = new Set<string>();
  let primed = false;
  let activeConversation: string | null = null;
  let timer: number | undefined;

  const scan = () => {
    timer = undefined;
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
      if (seen.size > 1000) [...seen].slice(0, 250).forEach((key) => seen.delete(key));
    } catch (error) { console.warn("[InstaDesk] parsing failure", error); }
  };
  const schedule = () => { if (timer === undefined) timer = win.setTimeout(scan, 350); };
  new MutationObserver(schedule).observe(win.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "data-message-id"] });
  win.addEventListener("popstate", schedule);
  win.addEventListener("hashchange", schedule);
  schedule();
  console.debug("[InstaDesk] DM observer installed");
}

if (typeof window !== "undefined" && location.hostname.endsWith("instagram.com")) {
  installRemoteIpcFallback(window);
  installNavigationShortcuts(window);
  const installPageFeatures = () => {
    installContentControls(window);
    installMonitor(window);
  };
  if (document.body) installPageFeatures();
  else document.addEventListener("DOMContentLoaded", installPageFeatures, { once: true });
}
