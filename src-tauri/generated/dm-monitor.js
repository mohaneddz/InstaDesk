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
  var THREAD_RE = /^\/direct\/t\/([^/?#]+)\/?/;
  var GROUP_WORDS = /\b(group|members?|participants?|people)\b/i;
  var OWN_WORDS = /\b(you sent|sent by you|your message)\b/i;
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
  function classifyThread(document2) {
    const main = document2.querySelector("main") ?? document2.body;
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
  function isOwnLastMessage(row, preview) {
    const text = `${row.getAttribute("aria-label") ?? ""} ${normalizedText(row)}`;
    return OWN_WORDS.test(text) || /^you\s*:/i.test(preview);
  }
  function inboxRowKind(row) {
    const text = `${row.getAttribute("aria-label") ?? ""} ${normalizedText(row)}`;
    if (GROUP_WORDS.test(text)) return "group";
    const avatars = row.querySelectorAll("img").length;
    if (avatars >= 2) return "group";
    if (avatars === 1) return "private";
    return "unknown";
  }
  function inboxRowTitle(row) {
    const nameSpan = row.querySelector("span");
    const name = nameSpan ? normalizedText(nameSpan) : "";
    return name || (row.getAttribute("aria-label") ?? "").split(",")[0].trim() || "Instagram";
  }
  function inboxRowPreview(row) {
    const text = normalizedText(row);
    const title = inboxRowTitle(row);
    const rest = title && text.startsWith(title) ? text.slice(title.length) : text;
    return rest.replace(/^[\s·:,-]+/, "").slice(0, 240);
  }
  function parseInboxList(document2, origin = "https://www.instagram.com") {
    const rows = [...document2.querySelectorAll('a[href^="/direct/t/"]')];
    return rows.flatMap((row) => {
      const conversationId = threadIdFromPath(row.getAttribute("href") ?? "");
      if (!conversationId) return [];
      const preview = inboxRowPreview(row);
      if (!preview || isOwnLastMessage(row, preview)) return [];
      return [{
        conversationId,
        conversationUrl: new URL(`/direct/t/${conversationId}/`, origin).href,
        sender: inboxRowTitle(row),
        preview,
        messageKey: stableHash(`${conversationId}|${preview}`),
        kind: inboxRowKind(row)
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
        return;
      }
      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        nativeAction(win, "hide_if_open");
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
    const restoreLayout = () => {
      win.document.querySelectorAll("[data-instadesk-hidden]").forEach((element) => {
        element.style.removeProperty("display");
        element.removeAttribute("data-instadesk-hidden");
      });
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
        block = parent;
      }
      return block;
    };
    const applySemanticLayout = () => {
      restoreLayout();
      const main = win.document.querySelector("main");
      if (!main) return;
      if (controls.disableStories) {
        const storyLink = main.querySelector('a[href*="/stories/"]') ?? main.querySelector(`[aria-label*="story" i][role="button"], [aria-label$="\u2019s story" i]`);
        if (storyLink) hide(enclosingBlock(storyLink, main));
      }
      if (controls.disableSuggestions) {
        const headings = [...win.document.querySelectorAll("span,div,h1,h2,h3,h4")].filter((element) => element.childElementCount === 0 && /^Suggested for you$/i.test(normalizedText(element)));
        for (const heading of headings) hide(enclosingBlock(heading, main));
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
      if (controls.hidePrivateChats || controls.hideGroupChats) {
        for (const row of main.querySelectorAll('a[href^="/direct/t/"]')) {
          const kind = inboxRowKind(row);
          if (kind === "private" && controls.hidePrivateChats || kind === "group" && controls.hideGroupChats) {
            hide(enclosingBlock(row, main));
          }
        }
      }
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
      style.textContent = rules.length ? `${rules.join(",")} { display:none !important; }` : "";
      applySemanticLayout();
      const pathname = win.location?.pathname;
      if (!pathname) return;
      if (!redirecting && blockedDestination(pathname, controls, loggedIn())) {
        redirecting = true;
        console.debug("[InstaDesk] blocked page redirected to DMs", { pathname });
        win.location.replace("/direct/inbox/");
        return;
      }
      if (!redirecting && threadIdFromPath(pathname) && (controls.hidePrivateChats || controls.hideGroupChats)) {
        const classification = classifyThread(win.document);
        const hidden = classification.kind === "private" && controls.hidePrivateChats || classification.kind === "group" && controls.hideGroupChats;
        if (hidden) {
          redirecting = true;
          console.debug("[InstaDesk] hidden conversation redirected to DMs", { pathname });
          win.location.replace("/direct/inbox/");
        }
      }
    };
    const refresh = async () => {
      try {
        controls = { ...DEFAULT_CONTROLS, ...await win.__TAURI_INTERNALS__?.invoke("get_content_controls") };
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
    new MutationObserver(apply).observe(win.document.body, { childList: true, subtree: true });
    win.addEventListener("popstate", apply);
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
    const enhance = () => {
      for (const article of win.document.querySelectorAll("article:not([data-instadesk-media-actions])")) {
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
  var STORY_SEEN_URL_PATTERN = /stor(y|ies)[_-]?(seen|viewed)|reel[_-]?(media[_-]?)?seen|seen[_-]?stor(y|ies)|media\/seen/i;
  var STORY_SEEN_BODY_PATTERN = /reel[_-]?seen|stor(y|ies)[_-]?seen|seenState|PolarisStoriesV3ReelSeenMutation/i;
  function looksLikeStorySeenRequest(url, body) {
    if (STORY_SEEN_URL_PATTERN.test(url)) return true;
    return Boolean(body && url.includes("/graphql/") && STORY_SEEN_BODY_PATTERN.test(body));
  }
  function installGhostStories(win) {
    if (win.__INSTADESK_GHOST__) return;
    win.__INSTADESK_GHOST__ = true;
    const enabled = () => Boolean(win.__INSTADESK_CONTENT_CONTROLS__?.ghostStories);
    const nativeFetch = win.fetch.bind(win);
    win.fetch = (async (input, init) => {
      try {
        const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        const body = typeof init?.body === "string" ? init.body : void 0;
        if (enabled() && looksLikeStorySeenRequest(raw, body)) {
          console.debug("[InstaDesk] ghost mode suppressed a story view receipt");
          return new Response(null, { status: 204 });
        }
      } catch {
      }
      return nativeFetch(input, init);
    });
    const XHR = win.XMLHttpRequest.prototype;
    const nativeOpen = XHR.open;
    const nativeSend = XHR.send;
    XHR.open = function(method, url, ...rest) {
      this.__instadeskUrl = String(url);
      return nativeOpen.apply(this, [method, url, ...rest]);
    };
    XHR.send = function(body) {
      const url = this.__instadeskUrl;
      const bodyText = typeof body === "string" ? body : void 0;
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
      return nativeSend.call(this, body);
    };
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
    const scan = () => {
      timer = void 0;
      try {
        const candidates = parseInboxList(win.document);
        if (!primed) {
          for (const item of candidates) seen.set(item.conversationId, item.messageKey);
          primed = true;
          console.debug(`[InstaDesk] inbox monitor primed with ${seen.size} conversations`);
          return;
        }
        for (const item of candidates) {
          if (seen.get(item.conversationId) === item.messageKey) continue;
          seen.set(item.conversationId, item.messageKey);
          console.debug("[InstaDesk] incoming message detected", { conversationId: item.conversationId, kind: item.kind });
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
      };
      if (document.body) installPageFeatures();
      else document.addEventListener("DOMContentLoaded", installPageFeatures, { once: true });
    }
  }
})();
