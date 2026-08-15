// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blockedDestination, classifyThread, inboxRowKind, installContentControls, installNavigationShortcuts, parseInboxList, postMediaSources, threadIdFromPath } from "./dm-monitor";

function page(header: string, rows: string): Document {
  document.body.innerHTML = `<main><header>${header}</header><section>${rows}</section></main>`;
  return document;
}

describe("Instagram thread classifier", () => {
  it("extracts thread ids only from conversation URLs", () => {
    expect(threadIdFromPath("/direct/t/123/")).toBe("123");
    expect(threadIdFromPath("/direct/inbox/")).toBeNull();
  });
  it("identifies a private 1:1 thread from its header", () => {
    const doc = page('<a href="/sarah/" aria-label="Sarah">Sarah</a>', "");
    expect(classifyThread(doc)).toMatchObject({ kind: "private", peer: "Sarah" });
  });
  it("classifies groups from multiple header peers or wording", () => {
    const doc = page('<a href="/sarah/">Sarah</a><a href="/alex/">Alex</a>', "");
    expect(classifyThread(doc).kind).toBe("group");
  });
  it("fails closed when the header cannot prove a single peer", () => {
    const doc = page("<span>Conversation details unavailable</span>", "");
    expect(classifyThread(doc).kind).toBe("unknown");
  });
});

describe("inbox list parser", () => {
  function inboxPage(rowsHtml: string): Document {
    document.body.innerHTML = `<main>${rowsHtml}</main>`;
    return document;
  }

  it("extracts a private conversation candidate with sender and preview", () => {
    const doc = inboxPage('<a href="/direct/t/123/"><span>Sarah</span> bro look at this<img src="/a.jpg"></a>');
    const [item] = parseInboxList(doc);
    expect(item).toMatchObject({ conversationId: "123", sender: "Sarah", preview: "bro look at this", kind: "private" });
  });

  it("classifies a group thread from its stacked avatars", () => {
    const doc = inboxPage('<a href="/direct/t/456/"><span>Weekend Trip</span> Alex: see you there<img src="/a.jpg"><img src="/b.jpg"></a>');
    const [item] = parseInboxList(doc);
    expect(item.kind).toBe("group");
  });

  it("classifies a group thread from group wording even with one avatar rendered", () => {
    const doc = inboxPage('<a href="/direct/t/789/" aria-label="Group chat"><span>Study Group</span> hey all<img src="/a.jpg"></a>');
    expect(inboxRowKind(doc.querySelector("a")!)).toBe("group");
  });

  it("excludes rows whose last message is the user's own", () => {
    const doc = inboxPage('<a href="/direct/t/123/"><span>Sarah</span> You: on my way<img src="/a.jpg"></a>');
    expect(parseInboxList(doc)).toEqual([]);
  });

  it("produces a stable message key for unchanged previews across rerenders", () => {
    const markup = '<a href="/direct/t/123/"><span>Sarah</span> stable text<img src="/a.jpg"></a>';
    expect(parseInboxList(inboxPage(markup))[0].messageKey).toBe(parseInboxList(inboxPage(markup))[0].messageKey);
  });
});

describe("content controls", () => {
  const controls = {
    disableHomeFeed: true, disableReels: true, disableExplore: true, disableSearch: true,
    disablePosts: true, disableStories: true, disableSuggestions: true, ghostStories: false,
    hidePrivateChats: false, hideGroupChats: false
  };
  it("blocks selected distraction routes", () => {
    expect(blockedDestination("/", controls)).toBe(true);
    expect(blockedDestination("/reels/abc/", controls)).toBe(true);
    expect(blockedDestination("/explore/", controls)).toBe(true);
    expect(blockedDestination("/explore/search/", controls)).toBe(true);
  });
  it("never blocks login or direct messages", () => {
    expect(blockedDestination("/", controls, false)).toBe(false);
    expect(blockedDestination("/direct/inbox/", controls)).toBe(false);
    expect(blockedDestination("/accounts/login/", controls)).toBe(false);
  });
  it("installs navigation hiding rules from native startup state", async () => {
    document.body.innerHTML = `<main>
      <section id="feed"><div id="stories"><a href="/stories/a/"></a><a href="/stories/b/"></a></div><article></article></section>
      <aside id="suggestions"><div>Suggested for you</div><span>See all</span><a href="/a/"></a><a href="/b/"></a><a href="/c/"></a></aside>
    </main>`;
    window.__INSTADESK_CONTENT_CONTROLS__ = controls;
    window.__TAURI_INTERNALS__ = { invoke: async () => controls };
    installContentControls(window);
    await Promise.resolve();

    const rules = document.querySelector<HTMLStyleElement>("#instadesk-content-controls")!.textContent;
    expect(rules).toContain('aria-label="Home"');
    expect(rules).toContain('aria-label="Reels"');
    expect(rules).toContain('aria-label="Explore"');
    expect(rules).toContain('aria-label="Search"');
    expect(rules).toContain("main article");
    expect(document.querySelector<HTMLElement>("#stories")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#suggestions")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#feed")!.style.marginLeft).toBe("auto");
  });
  it("hides private inbox rows while leaving group rows visible", async () => {
    document.body.innerHTML = `<main>
      <a id="private" href="/direct/t/123/"><span>Sarah</span>Sarah hey<img src="/a.jpg"></a>
      <a id="group" href="/direct/t/456/"><span>Trip</span>Trip see you<img src="/a.jpg"><img src="/b.jpg"></a>
    </main>`;
    const hideControls = { ...controls, hidePrivateChats: true, hideGroupChats: false };
    window.__INSTADESK_CONTENT_CONTROLS__ = hideControls;
    window.__TAURI_INTERNALS__ = { invoke: async () => hideControls };
    delete window.__INSTADESK_CONTROLS__;
    installContentControls(window);
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#private")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#group")!.style.display).not.toBe("none");
  });
});

describe("navigation shortcuts", () => {
  it("captures app shortcuts before page handlers", async () => {
    const actions: string[] = [];
    window.__TAURI_INTERNALS__ = { invoke: async (_command, args) => { actions.push((args as { action: string }).action); } };
    installNavigationShortcuts(window);
    let reachedPageHandler = false;
    window.addEventListener("keydown", () => { reachedPageHandler = true; });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", cancelable: true }));
    await Promise.resolve();

    expect(actions).toEqual(["hide_if_open", "hide_if_open", "fullscreen"]);
    expect(reachedPageHandler).toBe(true);
  });
});

describe("post media actions", () => {
  it("collects large post media while excluding the author avatar", () => {
    document.body.innerHTML = `<article><header><img src="https://cdn.example/avatar.jpg" width="40"></header>
      <img src="https://cdn.example/photo.jpg" width="640"><video src="https://cdn.example/video.mp4"></video></article>`;
    expect(postMediaSources(document.querySelector("article")!)).toEqual([
      { kind: "video", url: "https://cdn.example/video.mp4" },
      { kind: "image", url: "https://cdn.example/photo.jpg" }
    ]);
  });
});
