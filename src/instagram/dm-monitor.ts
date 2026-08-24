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
const PROFILE_PICTURE_RE = /profile picture|avatar/i;
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

  // Stacked participant avatars. Counting every <img> is not enough evidence:
  // a header carries badges and icons alongside the people in the thread.
  if ([...header.querySelectorAll<HTMLImageElement>("img")].filter((image) => PROFILE_PICTURE_RE.test(image.alt || "")).length >= 2) {
    return { kind: "group" };
  }
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
  kind: "private" | "group" | "unknown";
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
export function inboxRowKind(row: Element): "private" | "group" | "unknown" {
  // Only the row's own label is trusted for wording: the preview is message
  // text, and a message that happens to mention a group or people is not
  // evidence of anything.
  const ariaLabel = row.getAttribute("aria-label") ?? "";
  if (GROUP_WORDS.test(ariaLabel)) return "group";
  if (ariaLabel.split(",").length >= 2) return "group";

  const title = inboxRowTitle(row);
  if (title.split(",").length >= 2) return "group";

  // Instagram renders one profile picture per participant, so stacked avatars
  // are the reliable signal. Counting every <img> is not: verified badges,
  // reaction thumbnails and story rings all put extra images in the row.
  const avatars = [...row.querySelectorAll<HTMLImageElement>("img")]
    .filter((image) => PROFILE_PICTURE_RE.test(image.alt || ""));
  if (avatars.length >= 2) return "group";
  if (avatars.some((image) => image.alt.includes(",") || /\band\b/i.test(image.alt))) return "group";

  // Group previews are prefixed with the member who spoke: "Sarah: hey".
  const preview = inboxRowPreview(row);
  const prefix = preview.match(/^([^:]{1,25}):\s+\S/);
  if (prefix && !OWN_WORDS.test(preview) && prefix[1].trim() !== title) return "group";

  // A single identified participant is the only positive evidence of a 1:1
  // chat. Without it the row stays unknown rather than being guessed at, so a
  // single-category hide can never take out the whole inbox.
  return avatars.length === 1 ? "private" : "unknown";
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
function hasTimestamp(row: Element): boolean {
  if (TIMESTAMP_SUFFIX.test(normalizedText(row))) return true;
  return [...row.querySelectorAll("span, div, time, abbr")]
    .some((element) => element.children.length === 0 && TIME_ONLY.test(normalizedText(element)));
}

/** Reports how rows were found, so a bad notification can be traced to its source. */
export function inboxRowSource(document: Document): "anchor" | "fallback" | "none" {
  if (document.querySelector('a[href*="/direct/t/"]')) return "anchor";
  return inboxRowElements(document).length ? "fallback" : "none";
}

export function inboxRowElements(document: Document): HTMLElement[] {
  const anchors = [...document.querySelectorAll<HTMLElement>('a[href*="/direct/t/"]')];
  if (anchors.length) return anchors;
  // The fallback matches on role alone, which the feed also uses — posts and
  // comment rows look just like conversation rows to it. It is only trustworthy
  // on the inbox itself, where every such row is a conversation.
  if (!/^\/direct(?:\/|$)/.test(document.location?.pathname ?? "")) return [];
  const candidates = [...document.querySelectorAll<HTMLElement>('[role="listitem"], [role="row"], [role="button"][tabindex="0"]')]
    .filter((element) => Boolean(element.querySelector("img")) && normalizedText(element).length > 1)
    .filter((element) => !element.closest('article, [role="article"], [role="dialog"]'))
    // Every conversation row carries the time of its last message. The notes
    // and story tray above the list does not, and its avatar-plus-a-line shape
    // is otherwise indistinguishable from a conversation.
    .filter(hasTimestamp);
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

      if (controls.disablePosts) {
        const storyLink = main.querySelector<HTMLElement>('a[href*="/stories/"]');
        let storyTray: HTMLElement | null = null;
        if (storyLink) {
          let curr: HTMLElement | null = storyLink;
          while (curr && curr !== main && curr.parentElement !== main) {
            if (curr.getAttribute("role") === "menu" || curr.getAttribute("role") === "list" || /stories/i.test(curr.getAttribute("aria-label") ?? "") || curr.id === "stories") {
              storyTray = curr;
              break;
            }
            curr = curr.parentElement;
          }
          if (!storyTray) storyTray = storyLink.parentElement;
        }
        const dialog = win.document.querySelector<HTMLElement>('div[role="dialog"]');
        const loaders = main.querySelectorAll<HTMLElement>(
          '[data-visualcompletion="loading-state"], svg[aria-label*="Loading" i], [aria-label*="Loading" i], [aria-busy="true"]'
        );
        for (const loader of loaders) {
          if ((!storyTray || !storyTray.contains(loader)) && (!dialog || !dialog.contains(loader)) && !loader.closest('a[href*="/stories/"], div[role="dialog"]')) {
            targets.add(loader);
          }
        }
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

    if (controls.ghostStories) {
      for (const canvas of win.document.querySelectorAll<HTMLCanvasElement>("main canvas, header canvas, [role='menu'] canvas, [role='list'] canvas, a[href*='/stories/'] canvas")) {
        recolorStoryCanvas(canvas, true);
      }
      recolorStorySvg(win.document, true);
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
    if (controls.disableReels) rules.push('a[href*="/reels"]:has([aria-label="Reels"]),a:has([aria-label="Reels"])');
    if (controls.disableExplore) rules.push('a[href*="/explore"]:has([aria-label="Explore"]),a:has([aria-label="Explore"])');
    if (controls.disableSearch) rules.push('[role="button"]:has([aria-label="Search"]),[role="link"]:has([aria-label="Search"]),a:has([aria-label="Search"])');
    if (controls.disablePosts) {
      rules.push(
        "main article",
        'main:not(:has(div[role="dialog"])) [data-instadesk-feed-spinner]',
        'main [data-visualcompletion="loading-state"]:not(div[role="dialog"] *):not(a[href*="/stories/"] *)',
        'main svg[aria-label*="Loading" i]:not(div[role="dialog"] *):not(a[href*="/stories/"] *)',
        'main [aria-label*="Loading" i]:not(div[role="dialog"] *):not(a[href*="/stories/"] *)',
        'main [data-loading="true"]:not(div[role="dialog"] *):not(a[href*="/stories/"] *)'
      );
    }
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
  // Instagram builds many things out of <article>: feed posts, but also the DM
  // pane, suggestion cards and modal shells. Attaching to all of them scattered
  // the buttons over unrelated parts of the page and left most of them with no
  // media to act on, so the element has to prove it is a post first.
  const isPost = (article: HTMLElement): boolean => {
    if (article.parentElement?.closest("article")) return false;
    if (/^\/direct(?:\/|$)|^\/stories(?:\/|$)/.test(win.location?.pathname ?? "")) return false;
    if (article.getBoundingClientRect().width < 250) return false;
    return downloadableMedia(article).length > 0;
  };
  const enhance = () => {
    for (const article of win.document.querySelectorAll<HTMLElement>("article:not([data-instadesk-media-actions])")) {
      // Not marked as handled: an article can gain its media after first paint,
      // and it should pick the buttons up on the pass that follows.
      if (!isPost(article)) continue;
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

export const EMPTY_TIMELINE_RESPONSE = {
  feed_items: [],
  num_results: 0,
  more_available: false,
  auto_load_more_enabled: false,
  is_direct_styles: false,
  status: "ok",
  data: {
    xdt_api__v1__feed__timeline__connection: {
      edges: [],
      page_info: {
        has_next_page: false,
        end_cursor: null
      }
    }
  }
};

const FEED_TIMELINE_URL_PATTERN = /\/api\/v1\/feed\/timeline\/?|\/feed\/timeline\/?/i;
const FEED_TIMELINE_TOKEN = /(?:Polaroid|Polaris)?FeedTimeline(?:Query|RootQuery|Pagination)?|xdt_api__v1__feed__timeline|usePolaroidFeedQuery|PolaroidFeedQuery/i;

export function looksLikeFeedTimelineRequest(url: string, body?: string, method = "GET"): boolean {
  if (FEED_TIMELINE_URL_PATTERN.test(url)) return true;
  if (/(?:stories|story|reels|reel|direct|dialog)/i.test(`${url} ${body ?? ""}`)) {
    return false;
  }
  if (FEED_TIMELINE_TOKEN.test(`${url} ${body ?? ""}`)) return true;
  return false;
}

export function requestOperationName(url: string, body?: string): string {
  const name = body?.match(/fb_api_req_friendly_name=([^&\s]+)/)?.[1]
    ?? body?.match(/"?operationName"?\s*[:=]\s*"?([A-Za-z0-9_]+)/)?.[1];
  return name ?? "";
}

/**
 * Instagram has no documented "mark as seen" endpoint; the request shape has
 * shifted between a legacy REST path and a GraphQL mutation carried in the
 * POST body over the years. Matching both keeps ghost mode working across
 * that drift, but it stays a heuristic — a future rename can silently defeat
 * it, the same tradeoff the content-control heuristics above already accept.
 */
const STORY_SEEN_URL_PATTERN = /\/(?:stories|reel|media)\/(?:reel_)?seen\/?|seen[_\-/]?(?:stories|reel|media)\/?/i;
const STORY_SEEN_MUTATION_TOKEN = /(?:Stories|Reel|Story|Media).*Seen.*Mutation|Seen.*(?:Stories|Reel|Story|Media).*Mutation|useMarkSeenMutation|reel_seen|stories_seen/i;

/**
 * A seen receipt is always a write. Restricting the body match to non-GET
 * requests and excluding read queries keeps the operations that *fetch* stories
 * from being suppressed along with the receipts.
 */
export function looksLikeStorySeenRequest(url: string, body?: string, method = "GET"): boolean {
  if (STORY_SEEN_URL_PATTERN.test(url)) return true;
  if (method.toUpperCase() === "GET") return false;
  const opName = requestOperationName(url, body);
  // Never block read queries that fetch story content (e.g. PolarisStoriesV3ReelPageQuery, PolarisStoriesViewerRootQuery)!
  if (/Query$/i.test(opName) || /PageQuery|ViewerQuery|ReelsMedia|ReelPage/i.test(`${url} ${body ?? ""}`)) {
    return false;
  }
  return STORY_SEEN_MUTATION_TOKEN.test(`${url} ${body ?? ""}`);
}

/** Names the GraphQL operation so a drifted receipt can be identified from the log. */
function requestOperation(url: string, body?: string): string {
  const name = body?.match(/fb_api_req_friendly_name=([^&\s]+)/)?.[1]
    ?? body?.match(/"?operationName"?\s*[:=]\s*"?([A-Za-z0-9_]+)/)?.[1];
  let path = url;
  try { path = new URL(url, "https://www.instagram.com").pathname; } catch { /* keep the raw value */ }
  return name ? `${path} (${name})` : path;
}

export function isGreenColor(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (c.includes("green") || c.includes("lime")) return true;
  if (/^#([0-9a-f]{6}|[0-9a-f]{3}|[0-9a-f]{8})$/i.test(c)) {
    const hex = c.slice(1);
    let r = 0, g = 0, b = 0;
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
    return g > 100 && g > r * 1.15 && g > b * 1.15;
  }
  const rgbMatch = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    return g > 100 && g > r * 1.15 && g > b * 1.15;
  }
  const hslMatch = c.match(/hsla?\s*\(\s*(\d+)/i);
  if (hslMatch) {
    const h = Number(hslMatch[1]);
    return h >= 80 && h <= 170;
  }
  return false;
}

export function isStoryGradientColor(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (isGreenColor(c)) return false;
  if (c.includes("transparent") || c === "none") return false;
  if (/^#([0-9a-f]{6}|[0-9a-f]{3}|[0-9a-f]{8})$/i.test(c)) {
    const hex = c.slice(1);
    let r = 0, g = 0, b = 0;
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
    if (Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && Math.abs(r - b) < 25) return false;
    return r > 100 || b > 120;
  }
  const rgbMatch = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    if (Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && Math.abs(r - b) < 25) return false;
    return r > 100 || b > 120;
  }
  const hslMatch = c.match(/hsla?\s*\(\s*(\d+)/i);
  if (hslMatch) {
    const h = Number(hslMatch[1]);
    return h < 80 || h > 170;
  }
  return false;
}

export function ghostStoryStopColor(color: string, offset: number, kind?: "close-friends" | "default"): string {
  if (kind === "close-friends" || isGreenColor(color)) {
    if (offset <= 0.3) return "#00c6ff";
    if (offset <= 0.7) return "#0095f6";
    return "#0066ff";
  }
  if (kind === "default" || isStoryGradientColor(color)) {
    if (offset <= 0.3) return "#ff758c";
    if (offset <= 0.7) return "#ff2d75";
    return "#e1306c";
  }
  return color;
}

export function recolorStoryCanvas(canvas: HTMLCanvasElement, enabled: boolean): void {
  if (!enabled) return;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    if (width < 20 || height < 20) return;
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    let modified = false;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 30) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && Math.abs(r - b) < 20) continue;
      if (g > 100 && g > r * 1.15 && g > b * 1.15) {
        data[i] = 0;
        data[i + 1] = 149;
        data[i + 2] = 246;
        modified = true;
      } else if (r > 100 || (b > 100 && r > g)) {
        data[i] = 255;
        data[i + 1] = 45;
        data[i + 2] = 117;
        modified = true;
      }
    }
    if (modified) {
      ctx.putImageData(imgData, 0, 0);
    }
  } catch { /* Canvas pixel manipulation best effort */ }
}

export function recolorStorySvg(root: Document | HTMLElement, enabled: boolean): void {
  if (!enabled) return;
  for (const stop of root.querySelectorAll<SVGStopElement>("stop[stop-color]")) {
    const color = stop.getAttribute("stop-color") ?? "";
    const offset = parseFloat(stop.getAttribute("offset") ?? "0");
    if (isGreenColor(color)) {
      stop.setAttribute("stop-color", ghostStoryStopColor(color, offset, "close-friends"));
    } else if (isStoryGradientColor(color)) {
      stop.setAttribute("stop-color", ghostStoryStopColor(color, offset, "default"));
    }
  }
  for (const circle of root.querySelectorAll<SVGCircleElement>("circle[stroke]")) {
    const stroke = circle.getAttribute("stroke") ?? "";
    if (isGreenColor(stroke)) {
      circle.setAttribute("stroke", "#0095f6");
    } else if (isStoryGradientColor(stroke)) {
      circle.setAttribute("stroke", "#ff2d75");
    }
  }
}

/** Suppresses the network calls that report a story view while leaving media loads untouched. */
export function installGhostStories(win: Window): void {
  if (win.__INSTADESK_GHOST__) return;
  win.__INSTADESK_GHOST__ = true;
  const enabledGhost = () => Boolean(win.__INSTADESK_CONTENT_CONTROLS__?.ghostStories);
  const enabledDisablePosts = () => Boolean(win.__INSTADESK_CONTENT_CONTROLS__?.disablePosts);

  let reports = 0;
  const report = (label: string, detail: string) => {
    console.debug(`[InstaDesk] ${label}`, detail);
    // Capped: this runs on the network path and only the first few requests of
    // each kind are needed to tell whether a receipt was matched or missed.
    if (reports++ > 20) return;
    void win.__TAURI_INTERNALS__?.invoke("report_diagnostic", { label, detail }).catch(() => { /* diagnostics are best effort */ });
  };
  // A write that mentions a story or reel but did not match is exactly what a
  // renamed receipt would look like, so it is worth surfacing rather than
  // silently letting through.
  const noteNearMiss = (url: string, body: string | undefined, method: string) => {
    if (!enabledGhost() || method.toUpperCase() === "GET") return;
    const haystack = `${url} ${body ?? ""}`;
    if (/stor(y|ies)|reel/i.test(haystack) && /seen|view|impression/i.test(haystack)) {
      report("ghost mode let a story write through", requestOperation(url, body));
    }
  };

  const nativeFetch = win.fetch.bind(win);
  win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    try {
      if (enabledGhost() && looksLikeStorySeenRequest(raw, body, method)) {
        report("ghost mode suppressed a story view receipt", requestOperation(raw, body));
        return new Response(null, { status: 204 });
      }
      if (enabledDisablePosts() && looksLikeFeedTimelineRequest(raw, body, method)) {
        console.debug("[InstaDesk] suppressed timeline feed request because Disable Posts is active", requestOperation(raw, body));
        return new Response(JSON.stringify(EMPTY_TIMELINE_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      noteNearMiss(raw, body, method);
    } catch { /* Fall through to the real request on any inspection failure. */ }

    const response = await nativeFetch(input, init);
    try {
      recordVideoRequest(raw, win);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("json") || contentType.includes("javascript") || raw.includes("/graphql/") || raw.includes("/api/")) {
        response.clone().text().then((text) => {
          cleanAndParseJson(text);
        }).catch(() => { /* ignore text read errors */ });
      }
    } catch { /* ignore response clone failures */ }
    return response;
  }) as typeof fetch;

  const XHR = (win as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest.prototype as XMLHttpRequest & { __instadeskUrl?: string };
  const nativeOpen = XHR.open;
  const nativeSend = XHR.send;
  XHR.open = function (this: XMLHttpRequest & { __instadeskUrl?: string; __instadeskMethod?: string }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__instadeskUrl = String(url);
    this.__instadeskMethod = method;
    recordVideoRequest(this.__instadeskUrl, win);
    return (nativeOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest & { __instadeskUrl?: string; __instadeskMethod?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = this.__instadeskUrl;
    const method = this.__instadeskMethod ?? "GET";
    const bodyText = typeof body === "string" ? body : undefined;
    if (url) noteNearMiss(url, bodyText, method);
    if (enabledGhost() && url && looksLikeStorySeenRequest(url, bodyText, method)) {
      report("ghost mode suppressed a story view receipt (xhr)", requestOperation(url, bodyText));
      win.setTimeout(() => {
        Object.defineProperty(this, "readyState", { value: 4, configurable: true });
        Object.defineProperty(this, "status", { value: 204, configurable: true });
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("load"));
        this.dispatchEvent(new Event("loadend"));
      }, 0);
      return;
    }
    if (enabledDisablePosts() && url && looksLikeFeedTimelineRequest(url, bodyText, method)) {
      console.debug("[InstaDesk] suppressed timeline feed request (xhr) because Disable Posts is active", requestOperation(url, bodyText));
      win.setTimeout(() => {
        Object.defineProperty(this, "readyState", { value: 4, configurable: true });
        Object.defineProperty(this, "status", { value: 200, configurable: true });
        Object.defineProperty(this, "response", { value: JSON.stringify(EMPTY_TIMELINE_RESPONSE), configurable: true });
        Object.defineProperty(this, "responseText", { value: JSON.stringify(EMPTY_TIMELINE_RESPONSE), configurable: true });
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("load"));
        this.dispatchEvent(new Event("loadend"));
      }, 0);
      return;
    }

    this.addEventListener("load", () => {
      try {
        const text = this.responseText;
        if (text) cleanAndParseJson(text);
      } catch { /* ignore */ }
    });

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
      if (enabledGhost() && looksLikeStorySeenRequest(urlStr, bodyText, "POST")) {
        report("ghost mode suppressed a story view receipt (sendBeacon)", requestOperation(urlStr, bodyText));
        return true; // pretend delivery succeeded
      }
      return nativeSendBeacon(url, data);
    };
  }

  // Intercept Canvas gradient and stroke color drawing for story rings
  if (typeof win.CanvasGradient !== "undefined") {
    const gradProto = win.CanvasGradient.prototype;
    const nativeAddColorStop = gradProto.addColorStop;
    gradProto.addColorStop = function (this: CanvasGradient & { __instadeskKind?: "close-friends" | "default" }, offset: number, color: string) {
      if (enabledGhost()) {
        if (this.__instadeskKind === undefined) {
          this.__instadeskKind = isGreenColor(color) ? "close-friends" : (isStoryGradientColor(color) ? "default" : undefined);
        }
        color = ghostStoryStopColor(color, offset, this.__instadeskKind);
      }
      return nativeAddColorStop.call(this, offset, color);
    };
  }

  if (typeof win.CanvasRenderingContext2D !== "undefined") {
    const ctxProto = win.CanvasRenderingContext2D.prototype;
    const strokeDesc = Object.getOwnPropertyDescriptor(ctxProto, "strokeStyle")
      || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctxProto), "strokeStyle");
    if (strokeDesc?.set) {
      const nativeStrokeSet = strokeDesc.set;
      Object.defineProperty(ctxProto, "strokeStyle", {
        ...strokeDesc,
        set(this: CanvasRenderingContext2D, val: string | CanvasGradient | CanvasPattern) {
          if (enabledGhost() && typeof val === "string") {
            if (isGreenColor(val)) val = "#0095f6";
            else if (isStoryGradientColor(val)) val = "#ff2d75";
          }
          return nativeStrokeSet.call(this, val);
        }
      });
    }
  }
}

export interface StoryItem {
  id: string;
  pk?: string;
  code?: string;
  username: string;
  kind: "video" | "image";
  url: string;
  thumbUrl?: string;
}

export const userStoryReels = new Map<string, StoryItem[]>();
export const storyItemMap = new Map<string, StoryItem>();
export const userVideoUrls = new Map<string, string[]>();

export function recordVideoRequest(url: string, win?: Window): void {
  if (!url || !/\.mp4(\?|$)|cdninstagram\.com\/o1\/v\/|fbcdn\.net\/v\//i.test(url)) return;
  const username = win ? getFocusedUsername(win, getCenteredStoryContainer(win)) : "";
  if (username) {
    let list = userVideoUrls.get(username);
    if (!list) {
      list = [];
      userVideoUrls.set(username, list);
    }
    // Record only the single latest video URL for single-story fallback; never pollute story reel with chunks!
    if (!list.includes(url)) {
      list.push(url);
      if (list.length > 5) list.shift();
    }
  }
}

export function cleanAndParseJson(rawText: string): void {
  if (!rawText) return;
  let clean = rawText.trim();
  if (clean.startsWith("for (;;);")) clean = clean.slice(9).trim();
  else if (clean.startsWith("while(1);")) clean = clean.slice(9).trim();

  if (clean.startsWith("{") || clean.startsWith("[")) {
    try {
      const json = JSON.parse(clean);
      extractStoryMediaFromJson(json);
      return;
    } catch { /* multi-line fallback */ }
  }

  for (const line of clean.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        extractStoryMediaFromJson(parsed);
      } catch { /* ignore invalid line */ }
    }
  }
}

export function extractStoryMediaFromJson(data: any, inheritedUsername?: string, depth = 0): void {
  if (!data || typeof data !== "object" || depth > 20) return;

  if (Array.isArray(data)) {
    for (const el of data) extractStoryMediaFromJson(el, inheritedUsername, depth + 1);
    return;
  }

  const username = (data.user?.username ?? data.owner?.username ?? data.username ?? inheritedUsername ?? "").toLowerCase();

  // 1. Check if this is a complete Reel container with an `items` array
  if (Array.isArray(data.items) && data.items.length > 0 && username) {
    const genuineItems: StoryItem[] = [];
    for (const rawItem of data.items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const id = String(rawItem.pk ?? rawItem.id ?? rawItem.code ?? "").toLowerCase();
      if (!id) continue;

      const isVideo = rawItem.media_type === 2
        || (Array.isArray(rawItem.video_versions) && rawItem.video_versions.length > 0)
        || (Array.isArray(rawItem.video_resources) && rawItem.video_resources.length > 0)
        || typeof rawItem.video_url === "string";

      const videoUrl = (Array.isArray(rawItem.video_versions) && rawItem.video_versions[0]?.url)
        || (Array.isArray(rawItem.video_resources) && rawItem.video_resources[0]?.src)
        || (typeof rawItem.video_url === "string" && rawItem.video_url)
        || undefined;

      const imageUrl = (Array.isArray(rawItem.image_versions2?.candidates) && rawItem.image_versions2.candidates[0]?.url)
        || (typeof rawItem.display_url === "string" && rawItem.display_url)
        || (typeof rawItem.thumbnail_src === "string" && rawItem.thumbnail_src)
        || undefined;

      const kind: "video" | "image" = (isVideo && videoUrl) ? "video" : "image";
      const url = (kind === "video" ? videoUrl : imageUrl) ?? imageUrl ?? videoUrl;

      if (url && /^https?:/i.test(url)) {
        const storyItem: StoryItem = {
          id,
          pk: String(rawItem.pk ?? id).toLowerCase(),
          code: rawItem.code,
          username,
          kind,
          url,
          thumbUrl: imageUrl
        };
        const existingIdx = genuineItems.findIndex((x) => x.id === id || (storyItem.pk && x.pk === storyItem.pk));
        if (existingIdx >= 0) {
          genuineItems[existingIdx] = storyItem;
        } else {
          genuineItems.push(storyItem);
        }
        storyItemMap.set(id, storyItem);
        if (rawItem.id) storyItemMap.set(String(rawItem.id).toLowerCase(), storyItem);
        if (rawItem.pk) storyItemMap.set(String(rawItem.pk).toLowerCase(), storyItem);
        if (rawItem.code) storyItemMap.set(String(rawItem.code).toLowerCase(), storyItem);
      }
    }

    if (genuineItems.length > 0) {
      userStoryReels.set(username, genuineItems);
    }
  }

  // 2. Single story media object with id
  if ((data.id || data.pk) && (data.video_versions || data.image_versions2 || data.display_url || data.video_url)) {
    const id = String(data.pk ?? data.id ?? data.code ?? "").toLowerCase();
    const isVideo = data.media_type === 2
      || (Array.isArray(data.video_versions) && data.video_versions.length > 0)
      || (Array.isArray(data.video_resources) && data.video_resources.length > 0)
      || typeof data.video_url === "string";

    const videoUrl = (Array.isArray(data.video_versions) && data.video_versions[0]?.url)
      || (Array.isArray(data.video_resources) && data.video_resources[0]?.src)
      || (typeof data.video_url === "string" && data.video_url)
      || undefined;

    const imageUrl = (Array.isArray(data.image_versions2?.candidates) && data.image_versions2.candidates[0]?.url)
      || (typeof data.display_url === "string" && data.display_url)
      || (typeof data.thumbnail_src === "string" && data.thumbnail_src)
      || undefined;

    const kind: "video" | "image" = (isVideo && videoUrl) ? "video" : "image";
    const url = (kind === "video" ? videoUrl : imageUrl) ?? imageUrl ?? videoUrl;

    if (url && /^https?:/i.test(url) && id) {
      const storyItem: StoryItem = {
        id,
        pk: String(data.pk ?? id).toLowerCase(),
        code: data.code,
        username,
        kind,
        url,
        thumbUrl: imageUrl
      };
      storyItemMap.set(id, storyItem);
      if (data.id) storyItemMap.set(String(data.id).toLowerCase(), storyItem);
      if (data.pk) storyItemMap.set(String(data.pk).toLowerCase(), storyItem);
      if (data.code) storyItemMap.set(String(data.code).toLowerCase(), storyItem);

      if (username) {
        let reel = userStoryReels.get(username);
        if (!reel) {
          reel = [];
          userStoryReels.set(username, reel);
        }
        const existingIdx = reel.findIndex((x) => x.id === id || (storyItem.pk && x.pk === storyItem.pk));
        if (existingIdx >= 0) {
          reel[existingIdx] = storyItem;
        } else {
          reel.push(storyItem);
        }
      }
    }
  }

  // 3. Recurse down structural container keys only (skip media resolution sub-arrays)
  for (const key of Object.keys(data)) {
    if (key === "video_versions" || key === "image_versions2" || key === "candidates" || key === "video_resources" || key === "__proto__" || key === "constructor") {
      continue;
    }
    extractStoryMediaFromJson(data[key], username, depth + 1);
  }
}

function scanObjectForMedia(obj: any, depth = 0): { videoUrl?: string; imageUrl?: string } | null {
  if (!obj || depth > 12 || typeof obj !== "object") return null;

  if (Array.isArray(obj.video_versions) && obj.video_versions[0]?.url) {
    return {
      videoUrl: obj.video_versions[0].url,
      imageUrl: obj.image_versions2?.candidates?.[0]?.url
    };
  }
  if (Array.isArray(obj.video_resources) && obj.video_resources[0]?.src) {
    return { videoUrl: obj.video_resources[0].src, imageUrl: obj.display_url };
  }
  if (typeof obj.videoUrl === "string" && /^https?:/i.test(obj.videoUrl)) {
    return { videoUrl: obj.videoUrl, imageUrl: obj.imageUrl };
  }
  if (typeof obj.video_url === "string" && /^https?:/i.test(obj.video_url)) {
    return { videoUrl: obj.video_url, imageUrl: obj.display_url };
  }
  if (typeof obj.playback_url === "string" && /^https?:/i.test(obj.playback_url)) {
    return { videoUrl: obj.playback_url };
  }
  if (typeof obj.src === "string" && /\.mp4(\?|$)/i.test(obj.src)) {
    return { videoUrl: obj.src };
  }
  if (typeof obj.url === "string" && /\.mp4(\?|$)/i.test(obj.url)) {
    return { videoUrl: obj.url };
  }

  for (const prop of ["item", "story", "media", "entry", "node", "reel", "memoizedProps", "pendingProps", "stateNode", "child", "sibling", "return"]) {
    if (obj[prop]) {
      const res = scanObjectForMedia(obj[prop], depth + 1);
      if (res) return res;
    }
  }
  return null;
}

export function extractMediaFromFiber(el: Element | null): { videoUrl?: string; imageUrl?: string } | null {
  if (!el) return null;
  for (const key in el) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactProps$")) {
      const fiber = (el as any)[key];
      const res = scanObjectForMedia(fiber, 0);
      if (res) return res;
    }
  }
  return null;
}

function sleep(win: Window, ms: number): Promise<void> {
  return new Promise((resolve) => win.setTimeout(resolve, ms));
}

function isViewingStory(win: Window): boolean {
  const pathname = win.location?.pathname ?? "";
  if (/^\/stories\//.test(pathname)) return true;
  const dialog = win.document.querySelector<HTMLElement>('div[role="dialog"]');
  if (dialog && (dialog.querySelector("video, img") || dialog.querySelector('[role="progressbar"]') || /story/i.test(dialog.getAttribute("aria-label") ?? ""))) {
    return true;
  }
  return false;
}

function storyContainer(win: Window): HTMLElement {
  const dialog = win.document.querySelector<HTMLElement>('div[role="dialog"]');
  if (dialog) return dialog;
  return win.document.querySelector<HTMLElement>("main section, main") ?? win.document.body;
}

function getCenteredStoryContainer(win: Window): HTMLElement {
  const dialog = win.document.querySelector<HTMLElement>('div[role="dialog"]');
  if (dialog) return dialog;
  const candidates = [...win.document.querySelectorAll<HTMLElement>("section, main > div, div:has(> video)")];
  const centerX = win.innerWidth / 2;
  let closest: HTMLElement | null = null;
  let minDiff = Infinity;
  for (const cand of candidates) {
    const rect = cand.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 300) {
      const candCenter = rect.left + rect.width / 2;
      const diff = Math.abs(candCenter - centerX);
      if (diff < minDiff) {
        minDiff = diff;
        closest = cand;
      }
    }
  }
  return closest ?? win.document.querySelector<HTMLElement>("main section, main") ?? win.document.body;
}

function getFocusedUsername(win: Window, root?: HTMLElement | null): string {
  const pathname = win.location?.pathname ?? "";
  const match = pathname.match(/\/stories\/([^\/]+)(?:\/(\d+))?/i);
  const urlUser = match?.[1]?.toLowerCase();
  const headerLink = root?.querySelector?.<HTMLAnchorElement>('header a[href*="/"]');
  const domUser = headerLink?.getAttribute("href")?.replace(/^\/|\/$/g, "").split("/")[0]?.toLowerCase();
  return (domUser || urlUser || "").toLowerCase();
}

function getActiveSegmentIndex(win: Window, root: HTMLElement): number {
  const progressBars = [...root.querySelectorAll<HTMLElement>('[role="progressbar"], header > div > div > div')];
  if (!progressBars.length) return 0;
  for (let i = 0; i < progressBars.length; i++) {
    const bar = progressBars[i];
    const val = bar.getAttribute("aria-valuenow");
    if (val && Number(val) > 0 && Number(val) < 100) return i;
    const inner = bar.firstElementChild as HTMLElement | null;
    if (inner) {
      const style = win.getComputedStyle(inner);
      const transform = style.transform;
      if (transform && transform !== "none" && !transform.includes("matrix(1, 0, 0, 1, 0, 0)")) {
        return i;
      }
      const width = inner.style.width;
      if (width && width !== "0%" && width !== "100%") return i;
    }
  }
  return 0;
}

function storyControlButton(dialog: HTMLElement, label: RegExp): HTMLElement | null {
  for (const button of dialog.querySelectorAll<HTMLElement>('button,[role="button"],[aria-label]')) {
    if (label.test(button.getAttribute("aria-label") ?? "")) return button;
  }
  return null;
}

function isVisible(win: Window, element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 30 || rect.height < 30) return false;
  const style = win.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
}

/** Finds the media element for the segment currently playing and focused. */
export async function activeStoryMedia(win: Window, root: HTMLElement): Promise<PostMedia | null> {
  const pathname = win.location?.pathname ?? "";
  const match = pathname.match(/\/stories\/([^\/]+)(?:\/(\d+))?/i);
  const urlStoryId = match?.[2]?.toLowerCase();

  // 1. Direct match by URL Story ID in storyItemMap
  if (urlStoryId && storyItemMap.has(urlStoryId)) {
    const item = storyItemMap.get(urlStoryId)!;
    return { kind: item.kind, url: item.url };
  }

  // 2. Check focused user's story reel
  const container = getCenteredStoryContainer(win);
  const username = getFocusedUsername(win, container);

  if (username && userStoryReels.has(username)) {
    const reel = userStoryReels.get(username)!;
    if (reel.length > 0) {
      if (urlStoryId) {
        const found = reel.find((x) => x.id === urlStoryId || x.pk === urlStoryId);
        if (found) return { kind: found.kind, url: found.url };
      }
      const segIndex = getActiveSegmentIndex(win, container);
      const safeIndex = Math.min(Math.max(0, segIndex), reel.length - 1);
      const item = reel[safeIndex];
      if (item) return { kind: item.kind, url: item.url };
    }
  }

  // 3. React Fiber on centered playing video or centered image
  const centerVideo = container.querySelector<HTMLVideoElement>("video") ?? win.document.querySelector<HTMLVideoElement>("video");
  if (centerVideo) {
    const fiberMedia = extractMediaFromFiber(centerVideo)
      ?? extractMediaFromFiber(centerVideo.parentElement)
      ?? extractMediaFromFiber(container);
    if (fiberMedia?.videoUrl && /^https?:/i.test(fiberMedia.videoUrl)) {
      return { kind: "video", url: fiberMedia.videoUrl };
    }
    for (const source of centerVideo.querySelectorAll<HTMLSourceElement>("source")) {
      if (source.src && /^https?:/i.test(source.src)) return { kind: "video", url: source.src };
    }
    if (centerVideo.src && /^https?:/i.test(centerVideo.src)) return { kind: "video", url: centerVideo.src };
    if (centerVideo.currentSrc && /^https?:/i.test(centerVideo.currentSrc)) return { kind: "video", url: centerVideo.currentSrc };
  }

  // 4. Centered image
  const centerImg = container.querySelector<HTMLImageElement>("img");
  if (centerImg && Math.max(centerImg.naturalWidth, centerImg.width, centerImg.getBoundingClientRect().width) > 160) {
    const fiberMedia = extractMediaFromFiber(centerImg);
    if (fiberMedia?.imageUrl) return { kind: "image", url: fiberMedia.imageUrl };
    const srcset = centerImg.getAttribute("srcset");
    if (srcset) {
      const parts = srcset.split(",").map((s) => s.trim().split(/\s+/));
      const highest = parts[parts.length - 1]?.[0];
      if (highest && /^https?:/i.test(highest)) return { kind: "image", url: highest };
    }
    const url = centerImg.currentSrc || centerImg.src;
    if (url && /^https?:/i.test(url)) return { kind: "image", url };
  }

  // 5. Sniffed video stream for user
  if (username && userVideoUrls.has(username)) {
    const list = userVideoUrls.get(username)!;
    if (list.length > 0) return { kind: "video", url: list[list.length - 1] };
  }

  if (centerVideo?.poster && /^https?:/i.test(centerVideo.poster)) {
    return { kind: "image", url: centerVideo.poster };
  }

  return null;
}

async function waitForActiveStoryMedia(win: Window, root: HTMLElement, timeoutMs = 1500): Promise<PostMedia | null> {
  const start = Date.now();
  let media = await activeStoryMedia(win, root);
  while (!media && Date.now() - start < timeoutMs) {
    await sleep(win, 90);
    media = await activeStoryMedia(win, root);
  }
  return media;
}

export async function downloadActiveStory(win: Window, root: HTMLElement, onProgress: (percent: number) => void): Promise<number> {
  const container = getCenteredStoryContainer(win);
  const username = getFocusedUsername(win, container) || "instagram";
  const media = await waitForActiveStoryMedia(win, container, 2000);
  if (!media || !/^https?:/i.test(media.url)) throw new Error("No downloadable story media found for " + username);
  return invokeDownload([media], `${username}-story`, onProgress);
}

export async function copyActiveStory(win: Window, root: HTMLElement): Promise<void> {
  const container = getCenteredStoryContainer(win);
  const video = container.querySelector<HTMLVideoElement>("video") ?? win.document.querySelector<HTMLVideoElement>("video");
  if (video && isVisible(win, video)) {
    try {
      const canvas = win.document.createElement("canvas");
      canvas.width = video.videoWidth || video.clientWidth || 1080;
      canvas.height = video.videoHeight || video.clientHeight || 1920;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl && dataUrl.startsWith("data:image/png;base64,")) {
          await invoke("copy_image", { url: dataUrl });
          return;
        }
      }
    } catch (error) {
      console.warn("[InstaDesk] canvas video frame copy fallback", error);
    }
  }

  const media = await waitForActiveStoryMedia(win, container, 1500);
  if (!media) throw new Error("No story media found to copy");
  if (media.kind === "video") {
    const poster = video?.poster;
    if (poster && /^https?:/i.test(poster)) {
      await invoke("copy_image", { url: poster });
      return;
    }
    throw new Error("Cannot copy video to clipboard as image");
  }
  await invoke("copy_image", { url: media.url });
}

/**
 * Downloads all stories belonging to the currently focused user.
 */
export async function downloadAllStories(win: Window, root: HTMLElement, onProgress: (percent: number) => void): Promise<number> {
  const container = getCenteredStoryContainer(win);
  const username = getFocusedUsername(win, container);
  if (!username) throw new Error("Could not detect focused story user");

  // 1. If we have the focused user's full story reel in userStoryReels:
  const reel = userStoryReels.get(username);
  if (reel && reel.length > 0) {
    const uniqueItems: PostMedia[] = [];
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    for (const item of reel) {
      if (!seenIds.has(item.id) && !seenUrls.has(item.url)) {
        seenIds.add(item.id);
        seenUrls.add(item.url);
        uniqueItems.push({ kind: item.kind, url: item.url });
      }
    }
    if (uniqueItems.length > 0) {
      return invokeDownload(uniqueItems, `${username}-story`, onProgress);
    }
  }

  // 2. Otherwise fallback to active focused media
  const current = await waitForActiveStoryMedia(win, container, 1500);
  if (!current) throw new Error("No downloadable stories found for " + username);
  return invokeDownload([current], `${username}-story`, onProgress);
}

/** Adds copy/download/download-all actions to the open story viewer at bottom left. */
export function installStoryMediaActions(win: Window): void {
  if (win.__INSTADESK_STORY_ACTIONS__) return;
  win.__INSTADESK_STORY_ACTIONS__ = true;

  let host: HTMLElement | null = null;

  const enhance = () => {
    const active = isViewingStory(win);
    if (!active) {
      if (host) {
        host.remove();
        host = null;
      }
      return;
    }

    if (host && win.document.body.contains(host)) return;

    host = win.document.createElement("div");
    host.id = "instadesk-story-actions-host";
    host.style.cssText = "position:fixed;left:24px;bottom:28px;z-index:2147483647;display:block;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .actions{display:flex;gap:8px;padding:7px;border:1px solid rgba(255,255,255,.22);border-radius:14px;background:rgba(18,18,24,.88);box-shadow:0 10px 32px rgba(0,0,0,.6);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
      button{position:relative;width:36px;height:36px;display:grid;place-items:center;padding:0;border:0;border-radius:10px;background:rgba(255,255,255,.1);color:#f5f5f7;cursor:pointer;transition:all .15s ease}
      button:hover{background:rgba(255,255,255,.22);transform:scale(1.08);color:#fff}
      button:active{background:rgba(255,255,255,.32);transform:scale(.95)}
      button:disabled{cursor:progress}
      svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
      .ok{color:#52e080!important;background:rgba(82,224,128,.2)!important}
      .error{color:#ff6b6b!important;background:rgba(255,107,107,.2)!important}
      .ring{position:absolute;inset:2px;border-radius:8px;display:none;place-items:center;background:conic-gradient(#b64bd0 calc(var(--pct,0)*1%),rgba(255,255,255,.2) 0)}
      .ring::after{content:"";position:absolute;inset:2px;border-radius:6px;background:#14141a}
      .pct{position:relative;font:600 10px "Segoe UI",sans-serif;color:#f0f0f3}
      button.busy .ring{display:grid}button.busy svg{visibility:hidden}
    </style><div class="actions">
      <button data-action="download" title="Download story (video/photo)" aria-label="Download story"><svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/></svg><span class="ring"><span class="pct">0</span></span></button>
      <button data-action="copy" title="Copy story image to clipboard" aria-label="Copy story image"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span class="ring"><span class="pct">0</span></span></button>
      <button data-action="downloadAll" title="Download all stories in this tray" aria-label="Download all stories"><svg viewBox="0 0 24 24"><path d="M7 3v10m-4-4 4 4 4-4M17 3v10m-4-4 4 4 4-4M5 20h14"/></svg><span class="ring"><span class="pct">0</span></span></button>
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
          const container = storyContainer(win);
          if (button.dataset.action === "download") {
            setProgress(0);
            button.classList.add("busy");
            await downloadActiveStory(win, container, setProgress);
          } else if (button.dataset.action === "copy") {
            await copyActiveStory(win, container);
          } else {
            setProgress(0);
            button.classList.add("busy");
            await downloadAllStories(win, container, setProgress);
          }
          button.classList.remove("busy");
          button.classList.add("ok");
        } catch (error) {
          button.classList.remove("busy");
          button.classList.add("error");
          console.warn("[InstaDesk] story media action failed", error);
        } finally {
          win.setTimeout(() => {
            button.disabled = false;
            button.className = "";
          }, 1400);
        }
      }, true);
    });

    win.document.body.append(host);
  };

  new MutationObserver(enhance).observe(win.document.body, { childList: true, subtree: true });
  win.addEventListener("popstate", enhance);
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
        report("incoming message detected", `${item.kind} ${item.event}${item.muted ? " (muted)" : ""} from ${item.sender} via ${inboxRowSource(win.document)} on ${win.location.pathname}`);
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
  installGhostStories(window);
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
    };
    if (document.body) installPageFeatures();
    else document.addEventListener("DOMContentLoaded", installPageFeatures, { once: true });
  }
}
