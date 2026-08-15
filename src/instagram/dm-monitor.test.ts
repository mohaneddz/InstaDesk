// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blockedDestination, classifyThread, installContentControls, installNavigationShortcuts, parseCurrentThread, postMediaSources, threadIdFromPath } from "./dm-monitor";

const location = { pathname: "/direct/t/123/", href: "https://www.instagram.com/direct/t/123/" } as Location;
function page(header: string, rows: string): Document {
  document.body.innerHTML = `<main><header>${header}</header><section>${rows}</section></main>`;
  return document;
}

describe("Instagram DM parser", () => {
  it("extracts thread ids only from conversation URLs", () => {
    expect(threadIdFromPath("/direct/t/123/")).toBe("123");
    expect(threadIdFromPath("/direct/inbox/")).toBeNull();
  });
  it("accepts a private peer and received message", () => {
    const doc = page('<a href="/sarah/" aria-label="Sarah">Sarah</a>', '<div data-message-id="m1" aria-label="Received from Sarah: bro look at this">bro look at this</div>');
    expect(parseCurrentThread(doc, location)).toMatchObject([{ conversationId: "123", sender: "Sarah", preview: "bro look at this", messageKey: "m1" }]);
  });
  it("rejects groups", () => {
    const doc = page('<a href="/sarah/">Sarah</a><a href="/alex/">Alex</a>', '<div data-message-id="m1" aria-label="Received from Sarah: hello">hello</div>');
    expect(classifyThread(doc).kind).toBe("group");
    expect(parseCurrentThread(doc, location)).toEqual([]);
  });
  it("rejects own messages", () => {
    const doc = page('<a href="/sarah/">Sarah</a>', '<div data-message-id="m2" aria-label="You sent: hello">hello</div>');
    expect(parseCurrentThread(doc, location)).toEqual([]);
  });
  it("ignores unrelated Instagram notifications", () => {
    document.body.innerHTML = '<main><div role="listitem" aria-label="Alex liked your photo">Alex liked your photo</div></main>';
    expect(parseCurrentThread(document, { pathname: "/accounts/activity/", href: "https://www.instagram.com/accounts/activity/" } as Location)).toEqual([]);
  });
  it("creates the same fallback key when the DOM rerenders", () => {
    const markup = '<div role="row" aria-label="Received from Sarah: stable text"><time datetime="2026-08-13T10:00:00Z"></time>stable text</div>';
    expect(parseCurrentThread(page('<a href="/sarah/">Sarah</a>', markup), location)[0].messageKey)
      .toBe(parseCurrentThread(page('<a href="/sarah/">Sarah</a>', markup), location)[0].messageKey);
  });
  it("fails closed when the header cannot prove a single peer", () => {
    const doc = page("<span>Conversation details unavailable</span>", '<div data-message-id="m3" aria-label="Received: uncertain">uncertain</div>');
    expect(classifyThread(doc).kind).toBe("unknown");
    expect(parseCurrentThread(doc, location)).toEqual([]);
  });
});

describe("content controls", () => {
  const controls = {
    disableHomeFeed: true, disableReels: true, disableExplore: true, disableSearch: true,
    disablePosts: true, disableStories: true, disableSuggestions: true, ghostStories: false
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

    expect(actions).toEqual(["fullscreen"]);
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
