"use strict";
(() => {
  // node_modules/@tauri-apps/api/external/tslib/tslib.es6.js
  function __classPrivateFieldGet(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  }
  function __classPrivateFieldSet(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
  }

  // node_modules/@tauri-apps/api/core.js
  var _Channel_onmessage;
  var _Channel_nextMessageIndex;
  var _Channel_pendingMessages;
  var _Channel_messageEndIndex;
  var _Resource_rid;
  var SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";
  function transformCallback(callback, once = false) {
    return window.__TAURI_INTERNALS__.transformCallback(callback, once);
  }
  var Channel = class {
    constructor(onmessage) {
      _Channel_onmessage.set(this, void 0);
      _Channel_nextMessageIndex.set(this, 0);
      _Channel_pendingMessages.set(this, []);
      _Channel_messageEndIndex.set(this, void 0);
      __classPrivateFieldSet(this, _Channel_onmessage, onmessage || (() => {
      }), "f");
      this.id = transformCallback((rawMessage) => {
        const index = rawMessage.index;
        if ("end" in rawMessage) {
          if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
            this.cleanupCallback();
          } else {
            __classPrivateFieldSet(this, _Channel_messageEndIndex, index, "f");
          }
          return;
        }
        const message = rawMessage.message;
        if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
          __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message);
          __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
          while (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") in __classPrivateFieldGet(this, _Channel_pendingMessages, "f")) {
            const message2 = __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
            __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message2);
            delete __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
            __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
          }
          if (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") === __classPrivateFieldGet(this, _Channel_messageEndIndex, "f")) {
            this.cleanupCallback();
          }
        } else {
          __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[index] = message;
        }
      });
    }
    cleanupCallback() {
      window.__TAURI_INTERNALS__.unregisterCallback(this.id);
    }
    set onmessage(handler) {
      __classPrivateFieldSet(this, _Channel_onmessage, handler, "f");
    }
    get onmessage() {
      return __classPrivateFieldGet(this, _Channel_onmessage, "f");
    }
    [(_Channel_onmessage = /* @__PURE__ */ new WeakMap(), _Channel_nextMessageIndex = /* @__PURE__ */ new WeakMap(), _Channel_pendingMessages = /* @__PURE__ */ new WeakMap(), _Channel_messageEndIndex = /* @__PURE__ */ new WeakMap(), SERIALIZE_TO_IPC_FN)]() {
      return `__CHANNEL__:${this.id}`;
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };
  async function invoke(cmd, args = {}, options) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
  }
  _Resource_rid = /* @__PURE__ */ new WeakMap();

  // src/instagram/dm-monitor.ts
  var DEFAULT_CONTROLS = {
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
  var THREAD_RE = /(?:^|\/)direct\/t\/([^/?#]+)\/?/;
  var GROUP_WORDS = /\b(group|members?|participants?|people)\b/i;
  var OWN_WORDS = /^\s*you\s*(?::|\b(?:sent|reacted|shared|replied|called|unsent)\b)/i;
  var TIMESTAMP_SUFFIX = /\s*·\s*(?:now|just now|\d+\s*[smhdw]|yesterday|\d+\s*(?:sec|min|hour|hr|day|week)s?(?:\s+ago)?)\s*$/i;
  var PROFILE_PICTURE_RE = /profile picture|avatar/i;
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
  var TIME_ONLY = /^(?:·|•|\.|\d+\s*[smhdw]|yesterday|now|just now|\d+\s*(?:sec|min|hour|hr|day|week)s?(?:\s+ago)?)$/i;
  function classifyThread(document2) {
    const root = document2.querySelector('div[role="main"]') ?? document2.querySelector("main") ?? document2.body;
    const header = root.querySelector("header") ?? root.querySelector('[role="banner"]') ?? root.querySelector('[aria-label*="conversation" i]') ?? root.querySelector('[aria-label*="thread" i]') ?? root.querySelector('div[role="main"] > div > div:first-child') ?? root.querySelector("main > div > div > div:first-child") ?? root;
    const semantic = [
      header.getAttribute("aria-label"),
      normalizedText(header),
      ...[...header.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label"))
    ].filter(Boolean).join(" ");
    if (GROUP_WORDS.test(semantic)) return { kind: "group" };
    const hasGroupDetails = Boolean(
      root.querySelector('a[href*="/details"], button[aria-label*="details" i], button[aria-label*="members" i], button[aria-label*="people" i], [aria-label*="group details" i]')
    );
    if (hasGroupDetails) return { kind: "group" };
    for (const img of header.querySelectorAll("img[alt]")) {
      const alt = img.alt || "";
      if (alt.includes(",") || /\band\b/i.test(alt) || GROUP_WORDS.test(alt)) return { kind: "group" };
    }
    if ([...header.querySelectorAll("img")].filter((image) => PROFILE_PICTURE_RE.test(image.alt || "")).length >= 2) {
      return { kind: "group" };
    }
    const headerTitles = [...header.querySelectorAll("h1, h2, h3, h4, span, div")].filter((el) => el.children.length === 0).map((el) => normalizedText(el)).filter((t) => t.length > 0 && t.length < 100 && !TIME_ONLY.test(t));
    for (const title of headerTitles) {
      if (title.includes(",") && title.split(",").length >= 2) {
        return { kind: "group" };
      }
    }
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
    if (peers.size > 1) return { kind: "group" };
    if (peers.size === 1) return { kind: "private", peer: [...peers.values()][0] };
    if (header.querySelectorAll("img").length === 1 && headerTitles.length > 0) {
      const candidateName = headerTitles[0];
      if (!candidateName.includes(",") && !GROUP_WORDS.test(candidateName)) {
        return { kind: "private", peer: candidateName };
      }
    }
    return { kind: "unknown" };
  }
  var REACTION_RE = /(?:liked your message|reacted (?:\S+ )?to your message|reacted to (?:your|a) message)/i;
  var TYPING_RE = /(?:is typing|typing…|typing\.\.\.)/i;
  var STORY_REPLY_RE = /(?:replied to your story|sent a story reply|reacted to your story|mentioned you in (?:their|a) story)/i;
  var NOTE_REPLY_RE = /(?:replied to your note|reacted to your note)/i;
  function inboxEventKind(preview) {
    if (TYPING_RE.test(preview)) return "typing";
    if (NOTE_REPLY_RE.test(preview)) return "noteReply";
    if (STORY_REPLY_RE.test(preview)) return "storyReply";
    if (REACTION_RE.test(preview)) return "reaction";
    return "message";
  }
  function inboxRowMuted(row) {
    if (row.querySelector('[aria-label*="muted" i], [aria-label*="notifications are off" i], svg[aria-label*="mute" i]')) return true;
    return /muted/i.test(row.getAttribute("aria-label") ?? "");
  }
  function inboxRowTitle(row) {
    const directSpans = [...row.querySelectorAll("span, div, h2, h3, h4")].filter((el) => el.children.length === 0).map((el) => normalizedText(el)).filter((txt) => txt.length > 0 && !TIME_ONLY.test(txt) && txt !== "\xB7");
    if (directSpans.length > 0) {
      return directSpans[0];
    }
    const avatarImg = row.querySelector("img[alt]");
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
  function inboxRowPreview(row) {
    const title = inboxRowTitle(row);
    const fullText = normalizedText(row);
    let preview = "";
    const leafSpans = [...row.querySelectorAll("span, div")].filter((s) => s.children.length === 0).map((s) => normalizedText(s)).filter((t) => Boolean(t) && !TIME_ONLY.test(t) && t !== "\xB7");
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
  function inboxRowKind(row) {
    const ariaLabel = row.getAttribute("aria-label") ?? "";
    if (GROUP_WORDS.test(ariaLabel)) return "group";
    if (ariaLabel.split(",").length >= 2) return "group";
    const title = inboxRowTitle(row);
    if (title.split(",").length >= 2) return "group";
    const avatars = [...row.querySelectorAll("img")].filter((image) => PROFILE_PICTURE_RE.test(image.alt || ""));
    if (avatars.length >= 2) return "group";
    if (avatars.some((image) => image.alt.includes(",") || /\band\b/i.test(image.alt))) return "group";
    const preview = inboxRowPreview(row);
    const prefix = preview.match(/^([^:]{1,25}):\s+\S/);
    if (prefix && !OWN_WORDS.test(preview) && prefix[1].trim() !== title) return "group";
    return avatars.length === 1 ? "private" : "unknown";
  }
  function isOwnLastMessage(row, preview) {
    const ariaLabel = row.getAttribute("aria-label") ?? "";
    const fullText = normalizedText(row);
    return OWN_WORDS.test(preview) || OWN_WORDS.test(ariaLabel) || /^\s*you\s*:/i.test(fullText) || /^\s*you\s+sent\b/i.test(fullText);
  }
  function rowThreadId(row) {
    const href = row.getAttribute("href") ?? row.querySelector('a[href*="/direct/t/"]')?.getAttribute("href") ?? row.closest('a[href*="/direct/t/"]')?.getAttribute("href");
    return href ? threadIdFromPath(href) : null;
  }
  function rowConversationId(row) {
    const threadId = rowThreadId(row);
    if (threadId) return threadId;
    const title = inboxRowTitle(row);
    return title && title !== "Instagram" ? `title-${stableHash(title)}` : null;
  }
  function inboxRowElements(document2) {
    const anchors = [...document2.querySelectorAll('a[href*="/direct/t/"]')];
    if (anchors.length) return anchors;
    if (!/^\/direct(?:\/|$)/.test(document2.location?.pathname ?? "")) return [];
    const candidates = [...document2.querySelectorAll('[role="listitem"], [role="row"], [role="button"][tabindex="0"]')].filter((element) => Boolean(element.querySelector("img")) && normalizedText(element).length > 1).filter((element) => !element.closest('article, [role="article"], [role="dialog"]'));
    return candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
  }
  function parseInboxList(document2, origin = "https://www.instagram.com") {
    return inboxRowElements(document2).flatMap((row) => {
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
      if (event.key === "F11") {
        event.preventDefault();
        event.stopImmediatePropagation();
        nativeAction(win, "fullscreen");
      }
    }, true);
  }
  function installContentControls(win) {
    if (win.__INSTADESK_CONTROLS__) return;
    win.__INSTADESK_CONTROLS__ = true;
    const style = win.document.createElement("style");
    style.id = "instadesk-content-controls";
    (win.document.head ?? win.document.documentElement).append(style);
    let controls = { ...DEFAULT_CONTROLS, ...win.__INSTADESK_CONTENT_CONTROLS__ };
    let redirecting = false;
    const loggedIn = () => Boolean(win.document.querySelector('a[href^="/direct/"]')) && !win.document.querySelector('input[name="password"]');
    const restore = (element) => {
      element.style.removeProperty("display");
      element.removeAttribute("data-instadesk-hidden");
    };
    const restoreLayout = () => {
      win.document.querySelectorAll("[data-instadesk-hidden]").forEach(restore);
      win.document.querySelectorAll("[data-instadesk-feed-column]").forEach((element) => {
        element.style.removeProperty("margin-left");
        element.style.removeProperty("margin-right");
        element.removeAttribute("data-instadesk-feed-column");
      });
    };
    const hide = (element) => {
      if (!element) return;
      element.dataset.instadeskHidden = "";
      element.style.setProperty("display", "none", "important");
    };
    const enclosingBlock = (start, root) => {
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
    const rowCount = (element) => element.querySelectorAll('a[href*="/direct/t/"], [role="listitem"], [role="row"]').length;
    const enclosingRowBlock = (row) => {
      let current = row;
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
    const unreadBadges = () => {
      const found = [];
      for (const labelled of win.document.querySelectorAll("[aria-label]")) {
        if (/unread/i.test(labelled.getAttribute("aria-label") ?? "")) hide(labelled);
      }
      for (const link of win.document.querySelectorAll('a[href*="/direct/"], [role="link"]')) {
        for (const leaf of link.querySelectorAll("span, div")) {
          if (leaf.childElementCount === 0 && /^\d+\+?$/.test(normalizedText(leaf))) found.push(leaf.parentElement ?? leaf);
        }
      }
      return found;
    };
    const reconcileHidden = (targets) => {
      for (const element of win.document.querySelectorAll("[data-instadesk-hidden]")) {
        if (!targets.has(element)) restore(element);
      }
      for (const element of targets) hide(element);
    };
    const applySemanticLayout = () => {
      const targets = /* @__PURE__ */ new Set();
      const main = win.document.querySelector("main");
      if (main) {
        if (controls.disableStories) {
          const storyLink = main.querySelector('a[href*="/stories/"]') ?? main.querySelector(`[aria-label*="story" i][role="button"], [aria-label$="\u2019s story" i]`);
          if (storyLink) targets.add(enclosingBlock(storyLink, main));
        }
        if (controls.disableSuggestions) {
          const headings = [...win.document.querySelectorAll("span,div,h1,h2,h3,h4")].filter((element) => element.childElementCount === 0 && /^Suggested for you$/i.test(normalizedText(element)));
          for (const heading of headings) targets.add(enclosingBlock(heading, main));
          const article = main.querySelector("article");
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
          if (kind === "private" && controls.hidePrivateChats || kind === "group" && controls.hideGroupChats || controls.hidePrivateChats && controls.hideGroupChats) {
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
      const rules = [];
      if (controls.disableHomeFeed) rules.push('a[href="/"]:has([aria-label="Home"]),a[href="https://www.instagram.com/"]:has([aria-label="Home"])');
      if (controls.disableReels) rules.push('a[href*="/reels"]:has([aria-label="Reels"]),a:has([aria-label="Reels"])');
      if (controls.disableExplore) rules.push('a[href*="/explore"]:has([aria-label="Explore"]),a:has([aria-label="Explore"])');
      if (controls.disableSearch) rules.push('[role="button"]:has([aria-label="Search"]),[role="link"]:has([aria-label="Search"]),a:has([aria-label="Search"])');
      if (controls.disablePosts) rules.push("main article");
      if (controls.disableStories) rules.push('main a[href*="/stories/"]');
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
        try {
          win.location.replace("/direct/inbox/");
        } catch {
        }
        return;
      }
      if (!redirecting && threadIdFromPath(pathname) && (controls.hidePrivateChats || controls.hideGroupChats)) {
        const classification = classifyThread(win.document);
        const hidden = controls.hidePrivateChats && controls.hideGroupChats || classification.kind === "private" && controls.hidePrivateChats || classification.kind === "group" && controls.hideGroupChats;
        if (hidden) {
          redirecting = true;
          console.debug("[InstaDesk] hidden conversation redirected to DMs", { pathname });
          try {
            win.location.replace("/direct/inbox/");
          } catch {
          }
        }
      }
    };
    const refresh = async () => {
      try {
        const fetched = await win.__TAURI_INTERNALS__?.invoke("get_content_controls");
        if (!fetched) throw new Error("content controls unavailable over IPC");
        controls = { ...DEFAULT_CONTROLS, ...fetched };
        win.__INSTADESK_CONTENT_CONTROLS__ = controls;
        redirecting = false;
        apply();
      } catch (error) {
        apply();
        console.warn("[InstaDesk] could not refresh content controls", error);
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
      const threadLink = target.closest('a[href*="/direct/t/"]');
      if (threadLink && (controls.hidePrivateChats || controls.hideGroupChats)) {
        const kind = inboxRowKind(threadLink);
        if (kind === "private" && controls.hidePrivateChats || kind === "group" && controls.hideGroupChats || controls.hidePrivateChats && controls.hideGroupChats) {
          event.preventDefault();
          event.stopImmediatePropagation();
          console.debug("[InstaDesk] prevented opening hidden conversation", { kind });
          return;
        }
      }
      const link = target.closest("a[href]");
      if (!link) return;
      try {
        if (blockedDestination(new URL(link.href, win.location.href).pathname, controls, loggedIn())) {
          event.preventDefault();
          event.stopImmediatePropagation();
          try {
            win.location.assign("/direct/inbox/");
          } catch {
          }
        }
      } catch {
      }
    }, true);
    new MutationObserver(apply).observe(win.document.body, { childList: true, subtree: true });
    win.addEventListener("popstate", () => {
      redirecting = false;
      apply();
    });
    win.addEventListener("instadesk:settings-changed", (event) => {
      const changed = event.detail;
      if (!changed) {
        void refresh();
        return;
      }
      controls = { ...DEFAULT_CONTROLS, ...changed };
      win.__INSTADESK_CONTENT_CONTROLS__ = controls;
      redirecting = false;
      apply();
    });
    apply();
    void refresh();
  }
  function postMediaSources(article) {
    const media = [];
    for (const video of article.querySelectorAll("video")) {
      const url = video.currentSrc || video.src;
      if (url) media.push({ kind: "video", url });
    }
    for (const image of article.querySelectorAll("img")) {
      const rect = image.getBoundingClientRect();
      if (image.closest("header") || Math.max(image.naturalWidth, image.width, rect.width) < 200) continue;
      const url = image.currentSrc || image.src;
      if (url) media.push({ kind: "image", url });
    }
    return [...new Map(media.map((item) => [item.url, item])).values()];
  }
  function safePostName(article) {
    const profile = article.querySelector('header a[href^="/"]')?.getAttribute("href")?.split("/").filter(Boolean)[0];
    return (profile || "instagram-post").replace(/[^A-Za-z0-9._-]/g, "-");
  }
  function downloadableMedia(article) {
    return postMediaSources(article).filter((item) => /^https?:/i.test(item.url));
  }
  async function invokeDownload(items, base, onProgress) {
    const onProgressChannel = new Channel();
    onProgressChannel.onmessage = (message) => onProgress(message.overallPercent);
    return await invoke("download_media", { items, base, onProgress: onProgressChannel });
  }
  async function downloadPostMedia(article, onProgress) {
    const media = downloadableMedia(article);
    if (!media.length) throw new Error("No downloadable media found in this post");
    return invokeDownload(media, safePostName(article), onProgress);
  }
  async function copyPostImage(article) {
    const image = downloadableMedia(article).find((item) => item.kind === "image");
    if (!image) throw new Error("This post has no copyable image");
    await invoke("copy_image", { url: image.url });
  }
  function installPostMediaActions(win) {
    if (win.__INSTADESK_MEDIA_ACTIONS__) return;
    win.__INSTADESK_MEDIA_ACTIONS__ = true;
    const isPost = (article) => {
      if (article.parentElement?.closest("article")) return false;
      if (/^\/direct(?:\/|$)|^\/stories(?:\/|$)/.test(win.location?.pathname ?? "")) return false;
      if (article.getBoundingClientRect().width < 250) return false;
      return downloadableMedia(article).length > 0;
    };
    const enhance = () => {
      for (const article of win.document.querySelectorAll("article:not([data-instadesk-media-actions])")) {
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
        root.querySelectorAll("button").forEach((button) => {
          const ring = button.querySelector(".ring");
          const pct = button.querySelector(".pct");
          const setProgress = (value) => {
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
              win.setTimeout(() => {
                button.disabled = false;
                button.className = "";
              }, 1400);
            }
          }, true);
        });
        article.append(host);
      }
    };
    new MutationObserver(enhance).observe(win.document.body, { childList: true, subtree: true });
    enhance();
  }
  var STORY_SEEN_URL_PATTERN = /stor(y|ies)[_\-/]?(seen|viewed)|reel[_\-/]?(media[_\-/]?)?seen|seen[_\-/]?stor(y|ies)|media\/seen/i;
  var STORY_SEEN_TOKEN = /(reel|stor(y|ies)|media)[_\-/]?(seen|viewed)|(seen|viewed)[_\-/]?(reel|stor(y|ies)|media|state)|mark[_\-/]?(as[_\-/]?)?seen|seen[_\-/]?mutation|seenmutation/i;
  function looksLikeStorySeenRequest(url, body, method = "GET") {
    if (STORY_SEEN_URL_PATTERN.test(url)) return true;
    if (method.toUpperCase() === "GET") return false;
    return STORY_SEEN_TOKEN.test(`${url} ${body ?? ""}`);
  }
  function requestOperation(url, body) {
    const name = body?.match(/fb_api_req_friendly_name=([^&\s]+)/)?.[1] ?? body?.match(/"?operationName"?\s*[:=]\s*"?([A-Za-z0-9_]+)/)?.[1];
    let path = url;
    try {
      path = new URL(url, "https://www.instagram.com").pathname;
    } catch {
    }
    return name ? `${path} (${name})` : path;
  }
  function installGhostStories(win) {
    if (win.__INSTADESK_GHOST__) return;
    win.__INSTADESK_GHOST__ = true;
    const enabled = () => Boolean(win.__INSTADESK_CONTENT_CONTROLS__?.ghostStories);
    let reports = 0;
    const report = (label, detail) => {
      console.debug(`[InstaDesk] ${label}`, detail);
      if (reports++ > 20) return;
      void win.__TAURI_INTERNALS__?.invoke("report_diagnostic", { label, detail }).catch(() => {
      });
    };
    const noteNearMiss = (url, body, method) => {
      if (!enabled() || method.toUpperCase() === "GET") return;
      const haystack = `${url} ${body ?? ""}`;
      if (/stor(y|ies)|reel/i.test(haystack) && /seen|view|impression/i.test(haystack)) {
        report("ghost mode let a story write through", requestOperation(url, body));
      }
    };
    const nativeFetch = win.fetch.bind(win);
    win.fetch = (async (input, init) => {
      try {
        const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        const body = typeof init?.body === "string" ? init.body : void 0;
        const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
        if (enabled() && looksLikeStorySeenRequest(raw, body, method)) {
          report("ghost mode suppressed a story view receipt", requestOperation(raw, body));
          return new Response(null, { status: 204 });
        }
        noteNearMiss(raw, body, method);
      } catch {
      }
      return nativeFetch(input, init);
    });
    const XHR = win.XMLHttpRequest.prototype;
    const nativeOpen = XHR.open;
    const nativeSend = XHR.send;
    XHR.open = function(method, url, ...rest) {
      this.__instadeskUrl = String(url);
      this.__instadeskMethod = method;
      return nativeOpen.apply(this, [method, url, ...rest]);
    };
    XHR.send = function(body) {
      const url = this.__instadeskUrl;
      const method = this.__instadeskMethod ?? "GET";
      const bodyText = typeof body === "string" ? body : void 0;
      if (url) noteNearMiss(url, bodyText, method);
      if (enabled() && url && looksLikeStorySeenRequest(url, bodyText, method)) {
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
      return nativeSend.call(this, body);
    };
    const nativeSendBeacon = win.navigator.sendBeacon?.bind(win.navigator);
    if (nativeSendBeacon) {
      win.navigator.sendBeacon = (url, data) => {
        const urlStr = String(url);
        const bodyText = typeof data === "string" ? data : void 0;
        if (enabled() && looksLikeStorySeenRequest(urlStr, bodyText, "POST")) {
          report("ghost mode suppressed a story view receipt (sendBeacon)", requestOperation(urlStr, bodyText));
          return true;
        }
        return nativeSendBeacon(url, data);
      };
    }
  }
  function sleep(win, ms) {
    return new Promise((resolve) => win.setTimeout(resolve, ms));
  }
  function storyDialog(win) {
    return win.document.querySelector('div[role="dialog"]');
  }
  function storySegmentCount(dialog) {
    return dialog.querySelectorAll('[role="progressbar"]').length;
  }
  function storyControlButton(dialog, label) {
    for (const button of dialog.querySelectorAll('button,[role="button"]')) {
      if (label.test(button.getAttribute("aria-label") ?? "")) return button;
    }
    return null;
  }
  function isVisible(win, element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return false;
    if (element.closest('[aria-hidden="true"]')) return false;
    const style = win.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
  }
  function activeStoryMedia(win, dialog) {
    const video = [...dialog.querySelectorAll("video")].find((el) => isVisible(win, el));
    if (video) {
      const url2 = video.currentSrc || video.src;
      return url2 ? { kind: "video", url: url2 } : null;
    }
    const image = [...dialog.querySelectorAll("img")].filter((el) => Math.max(el.naturalWidth, el.width) > 200).find((el) => isVisible(win, el));
    if (!image) return null;
    const url = image.currentSrc || image.src;
    return url ? { kind: "image", url } : null;
  }
  async function waitForActiveStoryMedia(win, dialog, timeoutMs = 1500) {
    const start = Date.now();
    let media = activeStoryMedia(win, dialog);
    while (!media && Date.now() - start < timeoutMs) {
      await sleep(win, 90);
      media = activeStoryMedia(win, dialog);
    }
    return media;
  }
  async function downloadActiveStory(win, dialog, onProgress) {
    const media = activeStoryMedia(win, dialog);
    if (!media || !/^https?:/i.test(media.url)) throw new Error("No downloadable story media found");
    return invokeDownload([media], "instagram-story", onProgress);
  }
  async function copyActiveStory(win, dialog) {
    const media = activeStoryMedia(win, dialog);
    if (!media || media.kind !== "image") throw new Error("This story has no copyable image");
    await invoke("copy_image", { url: media.url });
  }
  async function downloadAllStories(win, dialog, onProgress) {
    const total = storySegmentCount(dialog);
    if (!total) throw new Error("Could not detect story segments");
    const collected = [];
    let steppedForward = 0;
    try {
      for (let index = 0; index < total; index++) {
        const media = await waitForActiveStoryMedia(win, dialog);
        if (media && /^https?:/i.test(media.url) && !collected.some((item) => item.url === media.url)) collected.push(media);
        onProgress((index + 1) / total * 50);
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
  function installStoryMediaActions(win) {
    if (win.__INSTADESK_STORY_ACTIONS__) return;
    win.__INSTADESK_STORY_ACTIONS__ = true;
    const enhance = () => {
      const dialog = storyDialog(win);
      if (!dialog || dialog.dataset.instadeskStoryActions !== void 0 || !storySegmentCount(dialog)) return;
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
      root.querySelectorAll("button").forEach((button) => {
        const ring = button.querySelector(".ring");
        const pct = button.querySelector(".pct");
        const setProgress = (value) => {
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
            win.setTimeout(() => {
              button.disabled = false;
              button.className = "";
            }, 1400);
          }
        }, true);
      });
      dialog.append(host);
    };
    new MutationObserver(enhance).observe(win.document.body, { childList: true, subtree: true });
    enhance();
  }
  function installInboxMonitor(win) {
    if (win.__INSTADESK_INBOX_MONITOR__) return;
    win.__INSTADESK_INBOX_MONITOR__ = true;
    const seen = /* @__PURE__ */ new Map();
    let primed = false;
    let timer;
    let emptyScans = 0;
    let reportedShape = false;
    const report = (label, detail) => {
      console.debug(`[InstaDesk] ${label}`, detail);
      void win.__TAURI_INTERNALS__?.invoke("report_diagnostic", { label, detail }).catch(() => {
      });
    };
    const reportShape = () => {
      if (reportedShape) return;
      reportedShape = true;
      const count = (selector) => win.document.querySelectorAll(selector).length;
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
      timer = void 0;
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
      } catch (error) {
        console.warn("[InstaDesk] inbox parsing failure", error);
      }
    };
    const schedule = () => {
      if (timer === void 0) timer = win.setTimeout(scan, 700);
    };
    new MutationObserver(schedule).observe(win.document.documentElement, { childList: true, subtree: true, characterData: true });
    win.setInterval(schedule, 5e3);
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
})();
