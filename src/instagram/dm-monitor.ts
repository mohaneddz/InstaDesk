/**
 * Instagram DOM adapter. This module deliberately fails closed: a notification
 * is emitted only when a direct thread, its peer, and an incoming message can
 * all be identified from semantic DOM and URL evidence.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

export interface ContentControls {
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

const DEFAULT_CONTROLS: ContentControls = {
  disableHomeFeed: false,
  disableReels: false,
  disableExplore: false,
  disableSearch: false,
  disablePosts: false,
  disableStories: false,
  disableSuggestions: false,
  ghostStories: false,
  hidePrivateChats: false,
  hideGroupChats: false
};

const THREAD_RE = /(?:^|\/)direct\/t\/([^/?#]+)\/?/;
const GROUP_WORDS = /\b(group|members?|participants?|people)\b/i;
const OWN_WORDS = /^\s*you\s*(?::|\b(?:sent|reacted|shared|replied|called|unsent)\b)/i;
const TIMESTAMP_SUFFIX = /\s*·\s*(?:now|just now|\d+\s*[smhdw]|yesterday|\d+\s*(?:sec|min|hour|hr|day|week)s?(?:\s+ago)?)\s*$/i;
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

const TIME_ONLY = /^(?:·|•|\.|\d+\s*[smhdw]|yesterday|now|just now|\d+\s*(?:sec|min|hour|hr|day|week)s?(?:\s+ago)?)$/i;

/** Returns exactly one peer only when the header proves this is a 1:1 thread. */
export function classifyThread(document: Document): { kind: "private"; peer: string } | { kind: "group" | "unknown" } {
  const root = document.querySelector('div[role="main"]') ?? document.querySelector("main") ?? document.body;
  const header = root.querySelector("header")
    ?? root.querySelector('[role="banner"]')
    ?? root.querySelector('[aria-label*="conversation" i]')
    ?? root.querySelector('[aria-label*="thread" i]')
    ?? root.querySelector('div[role="main"] > div > div:first-child')
    ?? root.querySelector('main > div > div > div:first-child')
    ?? root;

  const semantic = [
    header.getAttribute("aria-label"),
    normalizedText(header),
    ...[...header.querySelectorAll('[aria-label]')].map((el) => el.getAttribute("aria-label"))
  ].filter(Boolean).join(" ");

  if (GROUP_WORDS.test(semantic)) return { kind: "group" };

  // Group details / members link or button
  const hasGroupDetails = Boolean(
    root.querySelector('a[href*="/details"], button[aria-label*="details" i], button[aria-label*="members" i], button[aria-label*="people" i], [aria-label*="group details" i]')
  );
  if (hasGroupDetails) return { kind: "group" };

  // Check image alt in header
  for (const img of header.querySelectorAll<HTMLImageElement>("img[alt]")) {
    const alt = img.alt || "";
    if (alt.includes(",") || /\band\b/i.test(alt) || GROUP_WORDS.test(alt)) return { kind: "group" };
  }

  // Multiple avatars in header
  if (header.querySelectorAll("img").length >= 2) return { kind: "group" };

  // Comma-separated names in header title
  const headerTitles = [...header.querySelectorAll("h1, h2, h3, h4, span, div")]
    .filter((el) => el.children.length === 0)
    .map((el) => normalizedText(el))
    .filter((t) => t.length > 0 && t.length < 100 && !TIME_ONLY.test(t));

  for (const title of headerTitles) {
    if (title.includes(",") && title.split(",").length >= 2) {
      return { kind: "group" };
    }
  }

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

  if (peers.size > 1) return { kind: "group" };
  if (peers.size === 1) return { kind: "private", peer: [...peers.values()][0] };

  // Fallback: If header has 1 avatar image and a single title without commas, classify as private
  if (header.querySelectorAll("img").length === 1 && headerTitles.length > 0) {
    const candidateName = headerTitles[0];
    if (!candidateName.includes(",") && !GROUP_WORDS.test(candidateName)) {
      return { kind: "private", peer: candidateName };
    }
  }

  return { kind: "unknown" };
}

export type InboxEvent = "message" | "reaction" | "typing" | "storyReply" | "noteReply";

export interface InboxCandidate {
  conversationId: string;
  conversationUrl: string;
  sender: string;
  preview: string;
  messageKey: string;
  kind: "private" | "group";
  event: InboxEvent;
  muted: boolean;
}

const REACTION_RE = /(?:liked your message|reacted (?:\S+ )?to your message|reacted to (?:your|a) message)/i;
const TYPING_RE = /(?:is typing|typing…|typing\.\.\.)/i;
const STORY_REPLY_RE = /(?:replied to your story|sent a story reply|reacted to your story|mentioned you in (?:their|a) story)/i;
const NOTE_REPLY_RE = /(?:replied to your note|reacted to your note)/i;

/** Names what actually happened in the conversation, from Instagram's own preview wording. */
export function inboxEventKind(preview: string): InboxEvent {
  if (TYPING_RE.test(preview)) return "typing";
  if (NOTE_REPLY_RE.test(preview)) return "noteReply";
  if (STORY_REPLY_RE.test(preview)) return "storyReply";
  if (REACTION_RE.test(preview)) return "reaction";
  return "message";
}

/** Instagram marks a muted conversation on the row itself rather than in the preview text. */
export function inboxRowMuted(row: Element): boolean {
  if (row.querySelector('[aria-label*="muted" i], [aria-label*="notifications are off" i], svg[aria-label*="mute" i]')) return true;
  return /muted/i.test(row.getAttribute("aria-label") ?? "");
}

/** Extracts the clean conversation/sender name from an inbox row element. */
export function inboxRowTitle(row: Element): string {
  const directSpans = [...row.querySelectorAll<HTMLElement>("span, div, h2, h3, h4")]
    .filter((el) => el.children.length === 0)
    .map((el) => normalizedText(el))
    .filter((txt) => txt.length > 0 && !TIME_ONLY.test(txt) && txt !== "·");

  if (directSpans.length > 0) {
    return directSpans[0];
  }

  const avatarImg = row.querySelector<HTMLImageElement>("img[alt]");
  if (avatarImg?.alt) {
    const fromAlt = avatarImg.alt.replace(/'s profile picture.*/i, "").replace(/^profile picture of\s+/i, "").trim();
    if (fromAlt) return fromAlt;
  }

  const ariaLabel = row.getAttribute("aria-label") || row.querySelector("[aria-label]")?.getAttribute("aria-label");
  if (ariaLabel) {
    return ariaLabel.replace(/^chat with\s+/i, "").replace(/^group chat with\s+/i, "").trim();
  }

  return "Instagram";
}

/** Extracts the clean incoming message preview text without timestamps. */
export function inboxRowPreview(row: Element): string {
  const title = inboxRowTitle(row);
  const fullText = normalizedText(row);

  let preview = "";

  const leafSpans = [...row.querySelectorAll<HTMLElement>("span, div")]
    .filter((s) => s.children.length === 0)
    .map((s) => normalizedText(s))
    .filter((t) => Boolean(t) && !TIME_ONLY.test(t) && t !== "·");

  const nonTitle = leafSpans.filter((t) => t !== title);
  if (nonTitle.length > 0) {
    preview = nonTitle.join(" ");
  } else if (title && fullText.startsWith(title)) {
    preview = fullText.slice(title.length).trim();
  } else {
    preview = fullText;
  }

  preview = preview.replace(/^[\s·:,-]+/, "").trim();
  preview = preview.replace(TIMESTAMP_SUFFIX, "").trim();
  return preview.slice(0, 240);
}

/** Determines if the row represents a 1:1 chat or group chat. */
export function inboxRowKind(row: Element): "private" | "group" {
  const ariaLabel = row.getAttribute("aria-label") ?? row.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "";
  const text = `${ariaLabel} ${normalizedText(row)}`;

  if (GROUP_WORDS.test(text)) return "group";
  if (/group/i.test(row.className || "")) return "group";

  // Check if title or aria-label contains comma-separated names
  const title = inboxRowTitle(row);
  if (title.includes(",") && title.split(",").length >= 2) return "group";
  if (ariaLabel.includes(",") && ariaLabel.split(",").length >= 2) return "group";

  // Check if image alt text indicates multiple people
  for (const img of row.querySelectorAll<HTMLImageElement>("img[alt]")) {
    const alt = img.alt || "";
    if (alt.includes(",") || /\band\b/i.test(alt) || GROUP_WORDS.test(alt)) return "group";
  }

  // Multiple avatars or stacked avatar elements
  const avatars = row.querySelectorAll("img").length;
  if (avatars >= 2) return "group";

  const stackedOrGroupIndicators = row.querySelectorAll('canvas, svg, [class*="group" i], [aria-label*="group" i]');
  if (stackedOrGroupIndicators.length >= 2) return "group";

  // In Instagram group chats, incoming message previews are prefixed with "<SenderName>: <message>"
  const preview = inboxRowPreview(row);
  if (/^[A-Za-z0-9._\s]+:\s+\S+/.test(preview) && !OWN_WORDS.test(preview)) {
    return "group";
  }

  return "private";
}

/** A row's own last-sent message is prefixed "You: ..." or "You sent ...". */
export function isOwnLastMessage(row: Element, preview: string): boolean {
  const ariaLabel = row.getAttribute("aria-label") ?? "";
  const fullText = normalizedText(row);
  return OWN_WORDS.test(preview) || OWN_WORDS.test(ariaLabel) || /^\s*you\s*:/i.test(fullText) || /^\s*you\s+sent\b/i.test(fullText);
}

function rowThreadId(row: Element): string | null {
  const href = row.getAttribute("href")
    ?? row.querySelector('a[href*="/direct/t/"]')?.getAttribute("href")
    ?? row.closest('a[href*="/direct/t/"]')?.getAttribute("href");
  return href ? threadIdFromPath(href) : null;
}

/**
 * Identifies a row even when Instagram renders it without a thread link, which
 * it does on some builds of the inbox; the title is then the only stable handle,
 * and it is all the diff against the previous scan actually needs.
 */
function rowConversationId(row: Element): string | null {
  const threadId = rowThreadId(row);
  if (threadId) return threadId;
  const title = inboxRowTitle(row);
  return title && title !== "Instagram" ? `title-${stableHash(title)}` : null;
}

/**
 * Instagram has shipped the inbox both as a list of thread anchors and as
 * anchor-less list items whose click handler navigates. Anchors are preferred
 * because they carry the thread id; the role-based rows are the fallback that
 * keeps hiding and detection working on the builds that lack them.
 */
export function inboxRowElements(document: Document): HTMLElement[] {
  const anchors = [...document.querySelectorAll<HTMLElement>('a[href*="/direct/t/"]')];
  if (anchors.length) return anchors;
  // The fallback matches on role alone, which the feed also uses — posts and
  // comment rows look just like conversation rows to it. It is only trustworthy
  // on the inbox itself, where every such row is a conversation.
  if (!/^\/direct(?:\/|$)/.test(document.location?.pathname ?? "")) return [];
  const candidates = [...document.querySelectorAll<HTMLElement>('[role="listitem"], [role="row"], [role="button"][tabindex="0"]')]
    .filter((element) => Boolean(element.querySelector("img")) && normalizedText(element).length > 1)
    .filter((element) => !element.closest('article, [role="article"], [role="dialog"]'));
  // Rows nest inside one another in the fallback markup; keep the innermost.
  return candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
}

/**
 * Scans Instagram's own inbox conversation list, not the open thread, so new
 * messages are found regardless of which page (or which thread) is on screen.
 * Own last-sent messages are excluded; everything else is a notification candidate.
 */
export function parseInboxList(document: Document, origin = "https://www.instagram.com"): InboxCandidate[] {
  return inboxRowElements(document).flatMap((row) => {
    const conversationId = rowConversationId(row);
    if (!conversationId) return [];
    const preview = inboxRowPreview(row);
    if (!preview || isOwnLastMessage(row, preview)) return [];
    const threadId = rowThreadId(row);
    return [{
      conversationId,
      conversationUrl: new URL(threadId ? `/direct/t/${threadId}/` : "/direct/inbox/", origin).href,
      sender: inboxRowTitle(row),
      preview,
      messageKey: stableHash(`${conversationId}|${preview}`),
      kind: inboxRowKind(row),
      event: inboxEventKind(preview),
      muted: inboxRowMuted(row)
    }];
  });
}

declare global {
  interface Window {
    __INSTADESK_ROLE__?: "main" | "inbox";
    __INSTADESK_INBOX_MONITOR__?: boolean;
    __INSTADESK_SHORTCUTS__?: boolean;
    __INSTADESK_CONTROLS__?: boolean;
    __INSTADESK_MEDIA_ACTIONS__?: boolean;
    __INSTADESK_STORY_ACTIONS__?: boolean;
    __INSTADESK_GHOST__?: boolean;
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

/**
 * Keeps F11 owned by the shell before Instagram handles the key event. The
 * window toggle is a registered global shortcut owned by the native side, so
 * the page deliberately stays out of it.
 */
export function installNavigationShortcuts(win: Window): void {
  if (win.__INSTADESK_SHORTCUTS__) return;
  win.__INSTADESK_SHORTCUTS__ = true;

  win.addEventListener("keydown", (event) => {
    if (event.key === "F11") {
      event.preventDefault();
      event.stopImmediatePropagation();
      nativeAction(win, "fullscreen");
    }
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
  const restore = (element: HTMLElement) => {
    element.style.removeProperty("display");
    element.removeAttribute("data-instadesk-hidden");
  };
  const restoreLayout = () => {
    win.document.querySelectorAll<HTMLElement>("[data-instadesk-hidden]").forEach(restore);
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
  // Climbs from a landmark node up to the smallest self-contained block that
  // still excludes the main feed, so a whole tray/rail is hidden rather than a
  // single row. Stops before swallowing the post feed, primary navigation, or sibling conversation rows.
  const enclosingBlock = (start: HTMLElement, root: HTMLElement): HTMLElement => {
    let block = start;
    for (let depth = 0; depth < 8; depth++) {
      const parent = block.parentElement;
      if (!parent || parent === root || parent === win.document.body) break;
      if (parent.querySelector("article") || parent.querySelector('nav,[role="navigation"]')) break;
      if (parent.querySelectorAll('a[href*="/direct/t/"]').length > 1) break;
      block = parent;
    }
    return block;
  };
  // Climbs to the wrapper that owns this one conversation and stops before any
  // ancestor that owns a second one, so a whole list is never taken out with a
  // single row — including on the markup where rows carry no thread anchor.
  const rowCount = (element: Element): number =>
    element.querySelectorAll('a[href*="/direct/t/"], [role="listitem"], [role="row"]').length;
  const enclosingRowBlock = (row: HTMLElement): HTMLElement => {
    let current: HTMLElement = row;
    while (current.parentElement && current.parentElement !== win.document.body) {
      const parent = current.parentElement;
      if (rowCount(parent) > Math.max(1, rowCount(current))) break;
      if (parent.getAttribute("role") === "list") break;
      if (parent.tagName === "MAIN" || parent.tagName === "NAV" || parent.getAttribute("role") === "navigation" || parent.getAttribute("role") === "main") break;
      current = parent;
    }
    return current;
  };
  let lastHiddenCount = -1;
  // Instagram keeps painting its own unread count on the DM entry points even
  // when the conversations behind it are hidden, which defeats the point of
  // hiding them; drop the count and the dot alongside the rows.
  const unreadBadges = (): HTMLElement[] => {
    const found: HTMLElement[] = [];
    for (const labelled of win.document.querySelectorAll<HTMLElement>("[aria-label]")) {
      if (/unread/i.test(labelled.getAttribute("aria-label") ?? "")) hide(labelled);
    }
    for (const link of win.document.querySelectorAll<HTMLElement>('a[href*="/direct/"], [role="link"]')) {
      for (const leaf of link.querySelectorAll<HTMLElement>("span, div")) {
        if (leaf.childElementCount === 0 && /^\d+\+?$/.test(normalizedText(leaf))) found.push(leaf.parentElement ?? leaf);
      }
    }
    return found;
  };
  // Reconciles the hidden set in one pass. The previous version unhid
  // everything and then hid it again on every DOM mutation, and Instagram
  // mutates its inbox constantly — so each pass painted a frame with the
  // hidden chats back on screen, which is the flicker.
  const reconcileHidden = (targets: Set<HTMLElement>) => {
    for (const element of win.document.querySelectorAll<HTMLElement>("[data-instadesk-hidden]")) {
      if (!targets.has(element)) restore(element);
    }
    for (const element of targets) hide(element);
  };
  const applySemanticLayout = () => {
    const targets = new Set<HTMLElement>();
    const main = win.document.querySelector<HTMLElement>("main");
    if (main) {
      if (controls.disableStories) {
        const storyLink = main.querySelector<HTMLElement>('a[href*="/stories/"]')
          ?? main.querySelector<HTMLElement>(`[aria-label*="story" i][role="button"], [aria-label$="’s story" i]`);
        if (storyLink) targets.add(enclosingBlock(storyLink, main));
      }

      if (controls.disableSuggestions) {
        // Instagram labels both the inline feed carousel and the right-rail
        // accounts panel "Suggested for you"; hide the block behind each one.
        const headings = [...win.document.querySelectorAll<HTMLElement>("span,div,h1,h2,h3,h4")]
          .filter((element) => element.childElementCount === 0 && /^Suggested for you$/i.test(normalizedText(element)));
        for (const heading of headings) targets.add(enclosingBlock(heading, main));

        // With the right rail gone, recenter the remaining feed column.
        const article = main.querySelector<HTMLElement>("article");
        if (article) {
          let feedColumn = article.parentElement;
          while (feedColumn?.parentElement && feedColumn.parentElement !== main && feedColumn.parentElement.childElementCount < 2) {
            feedColumn = feedColumn.parentElement;
          }
          if (feedColumn) {
            feedColumn.dataset.instadeskFeedColumn = "";
            feedColumn.style.setProperty("margin-left", "auto", "important");
            feedColumn.style.setProperty("margin-right", "auto", "important");
          }
        }
      }
    }

    if (controls.hidePrivateChats || controls.hideGroupChats) {
      let hidden = 0;
      const rows = inboxRowElements(win.document);
      for (const row of rows) {
        const kind = inboxRowKind(row);
        if ((kind === "private" && controls.hidePrivateChats) || (kind === "group" && controls.hideGroupChats) || (controls.hidePrivateChats && controls.hideGroupChats)) {
          targets.add(enclosingRowBlock(row));
          hidden++;
        }
      }
      for (const badge of unreadBadges()) targets.add(badge);
      if (hidden !== lastHiddenCount) {
        lastHiddenCount = hidden;
        console.debug("[InstaDesk] chat hiding pass", { rows: rows.length, hidden, controls: { hidePrivateChats: controls.hidePrivateChats, hideGroupChats: controls.hideGroupChats } });
      }
    }
    reconcileHidden(targets);
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
    // With every kind hidden there is nothing to classify, so a plain rule can
    // keep rows down from the moment Instagram inserts them — the JS pass that
    // follows only has to take out the surrounding wrapper.
    if (controls.hidePrivateChats && controls.hideGroupChats) {
      rules.push('a[href*="/direct/t/"]', '[role="listitem"]:has(a[href*="/direct/t/"])');
    }
    style.textContent = rules.length ? `${rules.join(",")} { display:none !important; }` : "";
    applySemanticLayout();
    const pathname = win.location?.pathname;
    if (!pathname) return;
    if (!redirecting && blockedDestination(pathname, controls, loggedIn())) {
      redirecting = true;
      console.debug("[InstaDesk] blocked page redirected to DMs", { pathname });
      try { win.location.replace("/direct/inbox/"); } catch { /* Ignore environment navigation constraints */ }
      return;
    }
    if (!redirecting && threadIdFromPath(pathname) && (controls.hidePrivateChats || controls.hideGroupChats)) {
      const classification = classifyThread(win.document);
      const hidden = (controls.hidePrivateChats && controls.hideGroupChats)
        || (classification.kind === "private" && controls.hidePrivateChats)
        || (classification.kind === "group" && controls.hideGroupChats);
      if (hidden) {
        redirecting = true;
        console.debug("[InstaDesk] hidden conversation redirected to DMs", { pathname });
        try { win.location.replace("/direct/inbox/"); } catch { /* Ignore environment navigation constraints */ }
      }
    }
  };
  const refresh = async () => {
    try {
      const fetched = await win.__TAURI_INTERNALS__?.invoke("get_content_controls") as Partial<ContentControls> | undefined;
      // A missing IPC bridge resolves to undefined; spreading that would reset
      // every control to its default and silently undo the injected state.
      if (!fetched) throw new Error("content controls unavailable over IPC");
      controls = { ...DEFAULT_CONTROLS, ...fetched };
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

    const threadLink = target.closest<HTMLAnchorElement>('a[href*="/direct/t/"]');
    if (threadLink && (controls.hidePrivateChats || controls.hideGroupChats)) {
      const kind = inboxRowKind(threadLink);
      if ((kind === "private" && controls.hidePrivateChats) || (kind === "group" && controls.hideGroupChats) || (controls.hidePrivateChats && controls.hideGroupChats)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        console.debug("[InstaDesk] prevented opening hidden conversation", { kind });
        return;
      }
    }

    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    try {
      if (blockedDestination(new URL(link.href, win.location.href).pathname, controls, loggedIn())) {
        event.preventDefault(); event.stopImmediatePropagation();
        try { win.location.assign("/direct/inbox/"); } catch { /* Ignore environment navigation constraints */ }
      }
    } catch { /* Ignore malformed third-party links. */ }
  }, true);
  // Watch Instagram's app tree, not <head>; apply() rewrites our stylesheet and
  // observing that write would continuously trigger the observer itself.
  new MutationObserver(apply).observe(win.document.body, { childList: true, subtree: true });
  // Reset redirecting on every popstate so that navigating back to a blocked
  // page re-triggers the redirect. Without the reset, one redirect permanently
  // latches redirecting=true and subsequent blocked navigations are ignored.
  win.addEventListener("popstate", () => { redirecting = false; apply(); });
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

/**
 * Instagram media is served from its CDN over signed HTTPS URLs (videos play via
 * MediaSource `blob:` URLs that cannot be refetched). Network access, disk writes
 * and clipboard image handling are delegated to the native shell, which sidesteps
 * the remote page's CSP, cross-origin fetch limits and WebView download blocking.
 */
function downloadableMedia(article: HTMLElement): PostMedia[] {
  return postMediaSources(article).filter((item) => /^https?:/i.test(item.url));
}

async function invokeDownload(items: PostMedia[], base: string, onProgress: (percent: number) => void): Promise<number> {
  const onProgressChannel = new Channel<{ overallPercent: number }>();
  onProgressChannel.onmessage = (message) => onProgress(message.overallPercent);
  return await invoke<number>("download_media", { items, base, onProgress: onProgressChannel });
}

async function downloadPostMedia(article: HTMLElement, onProgress: (percent: number) => void): Promise<number> {
  const media = downloadableMedia(article);
  if (!media.length) throw new Error("No downloadable media found in this post");
  return invokeDownload(media, safePostName(article), onProgress);
}

async function copyPostImage(article: HTMLElement): Promise<void> {
  const image = downloadableMedia(article).find((item) => item.kind === "image");
  if (!image) throw new Error("This post has no copyable image");
  await invoke("copy_image", { url: image.url });
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
        button{position:relative;width:30px;height:30px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:#eee;cursor:pointer}button:hover{background:#ffffff18}button:active{background:#ffffff26}button:disabled{cursor:progress}
        svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.ok{color:#6fd58a}.error{color:#ff7676}
        .ring{position:absolute;inset:1px;border-radius:6px;display:none;place-items:center;background:conic-gradient(#b64bd0 calc(var(--pct,0)*1%),#ffffff22 0)}
        .ring::after{content:"";position:absolute;inset:2px;border-radius:5px;background:#141418}
        .pct{position:relative;font:600 9px "Segoe UI",sans-serif;color:#f0f0f3}
        button.busy .ring{display:grid}button.busy svg{visibility:hidden}
      </style><div class="actions">
        <button data-action="download" title="Download all post media" aria-label="Download all post media"><svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/></svg><span class="ring"><span class="pct">0</span></span></button>
        <button data-action="copy" title="Copy post image" aria-label="Copy post image"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span class="ring"><span class="pct">0</span></span></button>
      </div>`;
      root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
        const ring = button.querySelector<HTMLElement>(".ring")!;
        const pct = button.querySelector<HTMLElement>(".pct")!;
        const setProgress = (value: number) => {
          const rounded = Math.max(0, Math.min(100, Math.round(value)));
          ring.style.setProperty("--pct", String(rounded));
          pct.textContent = String(rounded);
        };
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          button.disabled = true;
          button.className = "";
          try {
            if (button.dataset.action === "download") {
              setProgress(0);
              button.classList.add("busy");
              await downloadPostMedia(article, setProgress);
            } else {
              await copyPostImage(article);
            }
            button.classList.remove("busy");
            button.classList.add("ok");
          } catch (error) {
            button.classList.remove("busy");
            button.classList.add("error");
            console.warn("[InstaDesk] post media action failed", error);
          } finally {
            win.setTimeout(() => { button.disabled = false; button.className = ""; }, 1400);
          }
        }, true);
      });
      article.append(host);
    }
  };
  new MutationObserver(enhance).observe(win.document.body, { childList: true, subtree: true });
  enhance();
}

/**
 * Instagram has no documented "mark as seen" endpoint; the request shape has
 * shifted between a legacy REST path and a GraphQL mutation carried in the
 * POST body over the years. Matching both keeps ghost mode working across
 * that drift, but it stays a heuristic — a future rename can silently defeat
 * it, the same tradeoff the content-control heuristics above already accept.
 */
const STORY_SEEN_URL_PATTERN = /stor(y|ies)[_-]?(seen|viewed)|reel[_-]?(media[_-]?)?seen|seen[_-]?stor(y|ies)|media\/seen/i;
const STORY_SEEN_BODY_PATTERN = /reel[_-]?seen|stor(y|ies)[_-]?seen|seenState|PolarisStoriesV3ReelSeenMutation/i;

function looksLikeStorySeenRequest(url: string, body?: string): boolean {
  if (STORY_SEEN_URL_PATTERN.test(url)) return true;
  return Boolean(body && url.includes("/graphql/") && STORY_SEEN_BODY_PATTERN.test(body));
}

/** Suppresses the network calls that report a story view while leaving media loads untouched. */
export function installGhostStories(win: Window): void {
  if (win.__INSTADESK_GHOST__) return;
  win.__INSTADESK_GHOST__ = true;
  const enabled = () => Boolean(win.__INSTADESK_CONTENT_CONTROLS__?.ghostStories);

  const nativeFetch = win.fetch.bind(win);
  win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? init.body : undefined;
      if (enabled() && looksLikeStorySeenRequest(raw, body)) {
        console.debug("[InstaDesk] ghost mode suppressed a story view receipt");
        return new Response(null, { status: 204 });
      }
    } catch { /* Fall through to the real request on any inspection failure. */ }
    return nativeFetch(input, init);
  }) as typeof fetch;

  const XHR = (win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest.prototype as XMLHttpRequest & { __instadeskUrl?: string };
  const nativeOpen = XHR.open;
  const nativeSend = XHR.send;
  XHR.open = function (this: XMLHttpRequest & { __instadeskUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__instadeskUrl = String(url);
    return (nativeOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest & { __instadeskUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = this.__instadeskUrl;
    const bodyText = typeof body === "string" ? body : undefined;
    if (enabled() && url && looksLikeStorySeenRequest(url, bodyText)) {
      console.debug("[InstaDesk] ghost mode suppressed a story view receipt (xhr)");
      win.setTimeout(() => {
        Object.defineProperty(this, "readyState", { value: 4, configurable: true });
        Object.defineProperty(this, "status", { value: 204, configurable: true });
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("load"));
        this.dispatchEvent(new Event("loadend"));
      }, 0);
      return;
    }
    return (nativeSend as (this: XMLHttpRequest, body?: unknown) => void).call(this, body);
  } as typeof XHR.send;

  // Also patch sendBeacon, which Instagram may use for lightweight seen receipts.
  // The native sendBeacon is captured before any other patch so the chain stays
  // stable regardless of install order.
  const nativeSendBeacon = (win.navigator.sendBeacon as typeof navigator.sendBeacon | undefined)?.bind(win.navigator);
  if (nativeSendBeacon) {
    (win.navigator as Navigator).sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
      const urlStr = String(url);
      const bodyText = typeof data === "string" ? data : undefined;
      if (enabled() && looksLikeStorySeenRequest(urlStr, bodyText)) {
        console.debug("[InstaDesk] ghost mode suppressed a story view receipt (sendBeacon)");
        return true; // pretend delivery succeeded
      }
      return nativeSendBeacon(url, data);
    };
  }
}

function sleep(win: Window, ms: number): Promise<void> {
  return new Promise((resolve) => win.setTimeout(resolve, ms));
}

function storyDialog(win: Window): HTMLElement | null {
  return win.document.querySelector<HTMLElement>('div[role="dialog"]');
}

function storySegmentCount(dialog: HTMLElement): number {
  return dialog.querySelectorAll('[role="progressbar"]').length;
}

function storyControlButton(dialog: HTMLElement, label: RegExp): HTMLElement | null {
  for (const button of dialog.querySelectorAll<HTMLElement>('button,[role="button"]')) {
    if (label.test(button.getAttribute("aria-label") ?? "")) return button;
  }
  return null;
}

function isVisible(win: Window, element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 50 || rect.height < 50) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  const style = win.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
}

/** Finds the media element for the segment currently playing, ignoring preloaded neighbors. */
function activeStoryMedia(win: Window, dialog: HTMLElement): PostMedia | null {
  const video = [...dialog.querySelectorAll<HTMLVideoElement>("video")].find((el) => isVisible(win, el));
  if (video) {
    const url = video.currentSrc || video.src;
    return url ? { kind: "video", url } : null;
  }
  const image = [...dialog.querySelectorAll<HTMLImageElement>("img")]
    .filter((el) => Math.max(el.naturalWidth, el.width) > 200)
    .find((el) => isVisible(win, el));
  if (!image) return null;
  const url = image.currentSrc || image.src;
  return url ? { kind: "image", url } : null;
}

async function waitForActiveStoryMedia(win: Window, dialog: HTMLElement, timeoutMs = 1500): Promise<PostMedia | null> {
  const start = Date.now();
  let media = activeStoryMedia(win, dialog);
  while (!media && Date.now() - start < timeoutMs) {
    await sleep(win, 90);
    media = activeStoryMedia(win, dialog);
  }
  return media;
}

async function downloadActiveStory(win: Window, dialog: HTMLElement, onProgress: (percent: number) => void): Promise<number> {
  const media = activeStoryMedia(win, dialog);
  if (!media || !/^https?:/i.test(media.url)) throw new Error("No downloadable story media found");
  return invokeDownload([media], "instagram-story", onProgress);
}

async function copyActiveStory(win: Window, dialog: HTMLElement): Promise<void> {
  const media = activeStoryMedia(win, dialog);
  if (!media || media.kind !== "image") throw new Error("This story has no copyable image");
  await invoke("copy_image", { url: media.url });
}

/**
 * Walks forward through every segment in the current story ring, collecting
 * whatever media is loaded along the way, then returns to the segment the
 * user started on. Only segments Instagram has already rendered are seen —
 * there is no API to fetch the full ring without stepping through it.
 */
async function downloadAllStories(win: Window, dialog: HTMLElement, onProgress: (percent: number) => void): Promise<number> {
  const total = storySegmentCount(dialog);
  if (!total) throw new Error("Could not detect story segments");
  const collected: PostMedia[] = [];
  let steppedForward = 0;
  try {
    for (let index = 0; index < total; index++) {
      const media = await waitForActiveStoryMedia(win, dialog);
      if (media && /^https?:/i.test(media.url) && !collected.some((item) => item.url === media.url)) collected.push(media);
      onProgress(((index + 1) / total) * 50);
      if (index < total - 1) {
        const next = storyControlButton(dialog, /^next$/i);
        if (!next) break;
        next.click();
        steppedForward++;
        await sleep(win, 260);
      }
    }
  } finally {
    const previous = storyControlButton(dialog, /^(previous|go back)$/i);
    for (let index = 0; index < steppedForward; index++) {
      previous?.click();
      await sleep(win, 120);
    }
  }
  if (!collected.length) throw new Error("No downloadable story media found");
  return invokeDownload(collected, "instagram-story", (percent) => onProgress(50 + percent / 2));
}

/** Adds copy/download/download-all actions to the open story viewer, mirroring the post action bar. */
export function installStoryMediaActions(win: Window): void {
  if (win.__INSTADESK_STORY_ACTIONS__) return;
  win.__INSTADESK_STORY_ACTIONS__ = true;
  const enhance = () => {
    const dialog = storyDialog(win);
    if (!dialog || dialog.dataset.instadeskStoryActions !== undefined || !storySegmentCount(dialog)) return;
    dialog.dataset.instadeskStoryActions = "";
    if (win.getComputedStyle(dialog).position === "static") dialog.style.setProperty("position", "relative");
    const host = win.document.createElement("div");
    host.style.cssText = "position:absolute;left:12px;bottom:16px;z-index:1000;display:block";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .actions{display:flex;gap:6px;padding:5px;border:1px solid #ffffff24;border-radius:10px;background:#111115e8;box-shadow:0 4px 18px #0008;backdrop-filter:blur(10px)}
      button{position:relative;width:30px;height:30px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:#eee;cursor:pointer}button:hover{background:#ffffff18}button:active{background:#ffffff26}button:disabled{cursor:progress}
      svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.ok{color:#6fd58a}.error{color:#ff7676}
      .ring{position:absolute;inset:1px;border-radius:6px;display:none;place-items:center;background:conic-gradient(#b64bd0 calc(var(--pct,0)*1%),#ffffff22 0)}
      .ring::after{content:"";position:absolute;inset:2px;border-radius:5px;background:#141418}
      .pct{position:relative;font:600 9px "Segoe UI",sans-serif;color:#f0f0f3}
      button.busy .ring{display:grid}button.busy svg{visibility:hidden}
    </style><div class="actions">
      <button data-action="copy" title="Copy story image" aria-label="Copy story image"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span class="ring"><span class="pct">0</span></span></button>
      <button data-action="download" title="Download this story" aria-label="Download this story"><svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/></svg><span class="ring"><span class="pct">0</span></span></button>
      <button data-action="downloadAll" title="Download all stories" aria-label="Download all stories"><svg viewBox="0 0 24 24"><path d="M7 3v10m-4-4 4 4 4-4M17 3v10m-4-4 4 4 4-4M5 20h14"/></svg><span class="ring"><span class="pct">0</span></span></button>
    </div>`;
    root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      const ring = button.querySelector<HTMLElement>(".ring")!;
      const pct = button.querySelector<HTMLElement>(".pct")!;
      const setProgress = (value: number) => {
        const rounded = Math.max(0, Math.min(100, Math.round(value)));
        ring.style.setProperty("--pct", String(rounded));
        pct.textContent = String(rounded);
      };
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        button.className = "";
        try {
          if (button.dataset.action === "copy") {
            await copyActiveStory(win, dialog);
          } else {
            setProgress(0);
            button.classList.add("busy");
            if (button.dataset.action === "download") await downloadActiveStory(win, dialog, setProgress);
            else await downloadAllStories(win, dialog, setProgress);
          }
          button.classList.remove("busy");
          button.classList.add("ok");
        } catch (error) {
          button.classList.remove("busy");
          button.classList.add("error");
          console.warn("[InstaDesk] story media action failed", error);
        } finally {
          win.setTimeout(() => { button.disabled = false; button.className = ""; }, 1400);
        }
      }, true);
    });
    dialog.append(host);
  };
  new MutationObserver(enhance).observe(win.document.body, { childList: true, subtree: true });
  enhance();
}

/**
 * Runs in a dedicated background WebView pinned to the inbox list, independent
 * of whatever page or thread the visible WebView shows and independent of the
 * window being minimized/hidden, so a new message is caught no matter what the
 * user is looking at. Detection is a diff against each conversation's last seen
 * message key rather than an "unread" flag, since Instagram's unread styling is
 * not a stable selector to depend on.
 */
export function installInboxMonitor(win: Window): void {
  if (win.__INSTADESK_INBOX_MONITOR__) return;
  win.__INSTADESK_INBOX_MONITOR__ = true;
  const seen = new Map<string, string>();
  let primed = false;
  let timer: number | undefined;
  let emptyScans = 0;
  let reportedShape = false;

  const report = (label: string, detail: string) => {
    console.debug(`[InstaDesk] ${label}`, detail);
    void win.__TAURI_INTERNALS__?.invoke("report_diagnostic", { label, detail }).catch(() => { /* diagnostics are best effort */ });
  };
  // Instagram's inbox markup drifts; when a scan comes up empty the structure it
  // found instead is worth more than the silence. Only the shape is reported —
  // element names and counts, never message text.
  const reportShape = () => {
    if (reportedShape) return;
    reportedShape = true;
    const count = (selector: string) => win.document.querySelectorAll(selector).length;
    report("inbox scan found no conversations", JSON.stringify({
      url: win.location.pathname,
      threadAnchors: count('a[href*="/direct/t/"]'),
      directAnchors: count('a[href*="/direct/"]'),
      listItems: count('[role="listitem"]'),
      rows: count('[role="row"]'),
      lists: count('[role="list"]'),
      buttons: count('[role="button"][tabindex="0"]'),
      images: count("main img"),
      candidateRows: inboxRowElements(win.document).length,
      loginForm: count('input[name="password"]') > 0
    }));
  };

  const scan = () => {
    timer = undefined;
    try {
      const candidates = parseInboxList(win.document);
      if (!candidates.length && ++emptyScans === 4) reportShape();
      if (candidates.length) emptyScans = 0;
      if (!primed) {
        if (candidates.length > 0) {
          for (const item of candidates) seen.set(item.conversationId, item.messageKey);
          primed = true;
          report("inbox monitor primed", `${seen.size} conversations`);
        }
        return;
      }
      for (const item of candidates) {
        if (seen.get(item.conversationId) === item.messageKey) continue;
        seen.set(item.conversationId, item.messageKey);
        report("incoming message detected", `${item.kind} ${item.event}${item.muted ? " (muted)" : ""} from ${item.sender}`);
        void win.__TAURI_INTERNALS__?.invoke("incoming_message", { message: item }).catch((error) => console.warn("[InstaDesk] native dispatch failed", error));
      }
    } catch (error) { console.warn("[InstaDesk] inbox parsing failure", error); }
  };
  const schedule = () => { if (timer === undefined) timer = win.setTimeout(scan, 700); };
  new MutationObserver(schedule).observe(win.document.documentElement, { childList: true, subtree: true, characterData: true });
  // Instagram can update the list via a websocket push the observer alone may miss; poll as a backstop.
  win.setInterval(schedule, 5000);
  schedule();
  console.debug("[InstaDesk] inbox observer installed");
}

if (typeof window !== "undefined" && location.hostname.endsWith("instagram.com")) {
  installRemoteIpcFallback(window);
  if (window.__INSTADESK_ROLE__ === "inbox") {
    const start = () => installInboxMonitor(window);
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    installNavigationShortcuts(window);
    const installPageFeatures = () => {
      installContentControls(window);
      installGhostStories(window);
      installPostMediaActions(window);
      installStoryMediaActions(window);
      installInboxMonitor(window);
    };
    if (document.body) installPageFeatures();
    else document.addEventListener("DOMContentLoaded", installPageFeatures, { once: true });
  }
}
