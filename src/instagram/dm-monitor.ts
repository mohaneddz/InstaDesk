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
  disablePosts: boolean;
  disableStories: boolean;
  disableSuggestions: boolean;
}

const DEFAULT_CONTROLS: ContentControls = {
  disableHomeFeed: false,
  disableReels: false,
  disableExplore: false,
  disableSearch: false,
  disablePosts: false,
  disableStories: false,
  disableSuggestions: false
};

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
    __INSTADESK_MEDIA_ACTIONS__?: boolean;
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

/** Keeps F11 owned by the shell before Instagram handles the key event. */
export function installNavigationShortcuts(win: Window): void {
  if (win.__INSTADESK_SHORTCUTS__) return;
  win.__INSTADESK_SHORTCUTS__ = true;
  win.addEventListener("keydown", (event) => {
    if (event.key !== "F11") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    nativeAction(win, "fullscreen");
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
  const restoreLayout = () => {
    win.document.querySelectorAll<HTMLElement>("[data-instadesk-hidden]").forEach((element) => {
      element.style.removeProperty("display");
      element.removeAttribute("data-instadesk-hidden");
    });
    win.document.querySelectorAll<HTMLElement>("[data-instadesk-feed-column]").forEach((element) => {
      element.style.removeProperty("margin-left");
      element.style.removeProperty("margin-right");
      element.removeAttribute("data-instadesk-feed-column");
    });
  };
  const hide = (element: HTMLElement | null) => {
    if (!element) return;
    element.dataset.instadeskHidden = "";
    element.style.setProperty("display", "none", "important");
  };
  const applySemanticLayout = () => {
    restoreLayout();
    const main = win.document.querySelector<HTMLElement>("main");
    if (!main) return;

    if (controls.disableStories) {
      const storyLinks = [...main.querySelectorAll<HTMLAnchorElement>('a[href*="/stories/"]')];
      if (storyLinks.length) {
        let storySection: HTMLElement = storyLinks[0];
        while (storySection.parentElement && storySection.parentElement !== main && !storySection.parentElement.querySelector("article")) {
          storySection = storySection.parentElement;
        }
        hide(storySection);
      }
    }

    if (controls.disableSuggestions) {
      const heading = [...main.querySelectorAll<HTMLElement>("div,span")]
        .find((element) => /^Suggested for you$/i.test(normalizedText(element)));
      let suggestionSection = heading ?? null;
      while (suggestionSection?.parentElement && suggestionSection.parentElement !== main && !suggestionSection.parentElement.querySelector("article")) {
        suggestionSection = suggestionSection.parentElement;
        if (suggestionSection.querySelectorAll('a[href]').length >= 3 && /See all/i.test(normalizedText(suggestionSection))) break;
      }
      hide(suggestionSection);

      const article = main.querySelector<HTMLElement>("article");
      if (article) {
        let feedColumn = article.parentElement;
        while (feedColumn?.parentElement && feedColumn.parentElement !== main && !/Suggested for you/i.test(normalizedText(feedColumn.parentElement))) {
          feedColumn = feedColumn.parentElement;
        }
        if (feedColumn) {
          feedColumn.dataset.instadeskFeedColumn = "";
          feedColumn.style.setProperty("margin-left", "auto", "important");
          feedColumn.style.setProperty("margin-right", "auto", "important");
        }
      }
    }
  };
  const apply = () => {
    if (!win.document?.documentElement) return;
    const rules: string[] = [];
    if (controls.disableHomeFeed) rules.push('a[href="/"]:has([aria-label="Home"]),a[href="https://www.instagram.com/"]:has([aria-label="Home"])');
    if (controls.disableReels) rules.push('a[href*="/reels"]:has([aria-label="Reels"]),a:has([aria-label="Reels"])');
    if (controls.disableExplore) rules.push('a[href*="/explore"]:has([aria-label="Explore"]),a:has([aria-label="Explore"])');
    if (controls.disableSearch) rules.push('[role="button"]:has([aria-label="Search"]),[role="link"]:has([aria-label="Search"]),a:has([aria-label="Search"])');
    if (controls.disablePosts) rules.push("main article");
    if (controls.disableStories) rules.push('main a[href*="/stories/"]');
    style.textContent = rules.length ? `${rules.join(",")} { display:none !important; }` : "";
    applySemanticLayout();
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

interface PostMedia {
  kind: "image" | "video";
  url: string;
}

export function postMediaSources(article: HTMLElement): PostMedia[] {
  const media: PostMedia[] = [];
  for (const video of article.querySelectorAll<HTMLVideoElement>("video")) {
    const url = video.currentSrc || video.src;
    if (url) media.push({ kind: "video", url });
  }
  for (const image of article.querySelectorAll<HTMLImageElement>("img")) {
    const rect = image.getBoundingClientRect();
    if (image.closest("header") || Math.max(image.naturalWidth, image.width, rect.width) < 200) continue;
    const url = image.currentSrc || image.src;
    if (url) media.push({ kind: "image", url });
  }
  return [...new Map(media.map((item) => [item.url, item])).values()];
}

function safePostName(article: HTMLElement): string {
  const profile = article.querySelector<HTMLAnchorElement>('header a[href^="/"]')?.getAttribute("href")?.split("/").filter(Boolean)[0];
  return (profile || "instagram-post").replace(/[^A-Za-z0-9._-]/g, "-");
}

function extensionFor(blob: Blob, kind: PostMedia["kind"]): string {
  const subtype = blob.type.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg");
  return subtype && /^[a-z0-9]+$/i.test(subtype) ? subtype : kind === "video" ? "mp4" : "jpg";
}

async function fetchPostBlob(media: PostMedia): Promise<Blob> {
  const response = await fetch(media.url, { credentials: "include" });
  if (!response.ok) throw new Error(`Media request failed (${response.status})`);
  return response.blob();
}

async function downloadPostMedia(article: HTMLElement): Promise<number> {
  const media = postMediaSources(article);
  if (!media.length) throw new Error("No downloadable media found in this post");
  const name = safePostName(article);
  for (let index = 0; index < media.length; index++) {
    const blob = await fetchPostBlob(media[index]);
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${name}-${index + 1}.${extensionFor(blob, media[index].kind)}`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
  return media.length;
}

async function copyPostImage(article: HTMLElement): Promise<void> {
  const image = postMediaSources(article).find((item) => item.kind === "image");
  if (!image) throw new Error("This post has no copyable image");
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Image clipboard access is unavailable");
  const source = await fetchPostBlob(image);
  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode image")), "image/png"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Adds unobtrusive media actions to each post without altering Instagram controls. */
export function installPostMediaActions(win: Window): void {
  if (win.__INSTADESK_MEDIA_ACTIONS__) return;
  win.__INSTADESK_MEDIA_ACTIONS__ = true;
  const enhance = () => {
    for (const article of win.document.querySelectorAll<HTMLElement>("article:not([data-instadesk-media-actions])")) {
      article.dataset.instadeskMediaActions = "";
      if (win.getComputedStyle(article).position === "static") article.style.setProperty("position", "relative");
      const host = win.document.createElement("div");
      host.style.cssText = "position:absolute;right:12px;bottom:12px;z-index:100;display:block";
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
        .actions{display:flex;gap:6px;padding:5px;border:1px solid #ffffff24;border-radius:10px;background:#111115e8;box-shadow:0 4px 18px #0008;backdrop-filter:blur(10px)}
        button{width:30px;height:30px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:#eee;cursor:pointer}button:hover{background:#ffffff18}button:active{background:#ffffff26}button:disabled{opacity:.55;cursor:wait}
        svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.ok{color:#6fd58a}.error{color:#ff7676}
      </style><div class="actions">
        <button data-action="download" title="Download all post media" aria-label="Download all post media"><svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/></svg></button>
        <button data-action="copy" title="Copy post image" aria-label="Copy post image"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button>
      </div>`;
      root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        button.className = "";
        try {
          if (button.dataset.action === "download") await downloadPostMedia(article);
          else await copyPostImage(article);
          button.classList.add("ok");
        } catch (error) {
          button.classList.add("error");
          console.warn("[InstaDesk] post media action failed", error);
        } finally {
          win.setTimeout(() => { button.disabled = false; button.className = ""; }, 1200);
        }
      }, true));
      article.append(host);
    }
  };
  new MutationObserver(enhance).observe(win.document.body, { childList: true, subtree: true });
  enhance();
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
    installPostMediaActions(window);
    installMonitor(window);
  };
  if (document.body) installPageFeatures();
  else document.addEventListener("DOMContentLoaded", installPageFeatures, { once: true });
}
