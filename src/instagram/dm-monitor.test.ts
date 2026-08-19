// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blockedDestination, classifyThread, inboxEventKind, inboxRowKind, inboxRowMuted, looksLikeStorySeenRequest, installContentControls, installNavigationShortcuts, parseInboxList, postMediaSources, threadIdFromPath } from "./dm-monitor";

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
  it("classifies groups from details button in thread header", () => {
    const doc = page('<div><span>Project X</span><a href="/direct/t/123/details/">Details</a></div>', "");
    expect(classifyThread(doc).kind).toBe("group");
  });
  it("classifies groups from comma-separated names in thread header title", () => {
    const doc = page('<div><span>Alice, Bob, Charlie</span></div>', "");
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
    const doc = inboxPage('<a href="/direct/t/123/"><span>Sarah</span> bro look at this<img alt="profile picture of Sarah" src="/a.jpg"></a>');
    const [item] = parseInboxList(doc);
    expect(item).toMatchObject({ conversationId: "123", sender: "Sarah", preview: "bro look at this", kind: "private" });
  });

  it("extracts candidates from absolute instagram conversation URLs", () => {
    const doc = inboxPage('<a href="https://www.instagram.com/direct/t/999/"><span>Mike</span> test message<img alt="profile picture of Mike" src="/a.jpg"></a>');
    const [item] = parseInboxList(doc);
    expect(item).toMatchObject({ conversationId: "999", sender: "Mike", preview: "test message", kind: "private" });
  });

  it("parses rows that carry no thread anchor", () => {
    history.replaceState({}, "", "/direct/inbox/");
    const doc = inboxPage(`<div role="list">
      <div role="listitem"><img alt="Sarah's profile picture" src="/a.jpg"><div><span>Sarah</span></div><div><span>bro look at this</span></div></div>
    </div>`);
    const [item] = parseInboxList(doc);
    expect(item).toMatchObject({ sender: "Sarah", preview: "bro look at this", kind: "private" });
    expect(item.conversationUrl).toBe("https://www.instagram.com/direct/inbox/");
  });

  it("ignores anchor-less rows outside the inbox, where the feed uses the same roles", () => {
    history.replaceState({}, "", "/");
    const doc = inboxPage(`<article role="article">
      <div role="button" tabindex="0"><img alt="poster" src="/a.jpg"><span>I gooned</span><span>449 likes Reply</span></div>
    </article>`);
    expect(parseInboxList(doc)).toEqual([]);
  });

  it("classifies a group thread from comma-separated usernames in row title", () => {
    const doc = inboxPage('<a href="/direct/t/888/"><span>Alice, Bob</span> Hey guys<img src="/a.jpg"></a>');
    const [item] = parseInboxList(doc);
    expect(item.kind).toBe("group");
  });

  it("correctly parses real-world Instagram row with avatar alt and timestamp", () => {
    const html = `<a href="/direct/t/17841401234567890/">
      <div>
        <img alt="ProbablyHim's profile picture" src="/avatar.jpg" />
        <div>
          <div><span>ProbablyHim</span></div>
          <div><span><span>Hi</span><span> · </span><span>1m</span></span></div>
        </div>
      </div>
    </a>`;
    const doc = inboxPage(html);
    const [item] = parseInboxList(doc);
    expect(item).toMatchObject({
      conversationId: "17841401234567890",
      sender: "ProbablyHim",
      preview: "Hi",
      kind: "private"
    });
  });

  it("strips relative timestamps and produces stable message key across timestamp updates", () => {
    const html1 = `<a href="/direct/t/123/"><div><img alt="Alex's profile picture" src="/a.jpg"/><span>Alex</span><span>Hello world · 1m</span></div></a>`;
    const html2 = `<a href="/direct/t/123/"><div><img alt="Alex's profile picture" src="/a.jpg"/><span>Alex</span><span>Hello world · 5m</span></div></a>`;
    const [item1] = parseInboxList(inboxPage(html1));
    const [item2] = parseInboxList(inboxPage(html2));
    expect(item1.preview).toBe("Hello world");
    expect(item2.preview).toBe("Hello world");
    expect(item1.messageKey).toBe(item2.messageKey);
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

  it("excludes rows with You sent a message format", () => {
    const doc = inboxPage('<a href="/direct/t/123/"><span>Sarah</span> You sent a photo · 2m<img src="/a.jpg"></a>');
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
      <a id="private" href="/direct/t/123/"><span>Sarah</span>Sarah hey<img alt="Sarah's profile picture" src="/a.jpg"></a>
      <a id="group" href="/direct/t/456/"><span>Trip</span>Trip see you<img alt="Ann's profile picture" src="/a.jpg"><img alt="Bo's profile picture" src="/b.jpg"></a>
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
  it("hides group inbox rows while leaving private rows visible", async () => {
    document.body.innerHTML = `<main>
      <a id="private" href="/direct/t/123/"><span>Sarah</span>Sarah hey<img alt="Sarah's profile picture" src="/a.jpg"></a>
      <a id="group" href="/direct/t/456/"><span>Alice, Bob</span>Alice, Bob see you<img alt="Alice's profile picture" src="/a.jpg"></a>
    </main>`;
    const hideControls = { ...controls, hidePrivateChats: false, hideGroupChats: true };
    window.__INSTADESK_CONTENT_CONTROLS__ = hideControls;
    window.__TAURI_INTERNALS__ = { invoke: async () => hideControls };
    delete window.__INSTADESK_CONTROLS__;
    installContentControls(window);
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#private")!.style.display).not.toBe("none");
    expect(document.querySelector<HTMLElement>("#group")!.style.display).toBe("none");
  });
  it("removes anchor-less rows and Instagram's unread badge", async () => {
    history.replaceState({}, "", "/direct/inbox/");
    document.body.innerHTML = `<nav><a href="/direct/inbox/"><span><span>2</span></span></a></nav>
    <main><div role="list">
      <div role="listitem" id="row"><img alt="Sarah's profile picture" src="/a.jpg"><span>Sarah</span><span>hey</span></div>
    </div></main>`;
    const hideControls = { ...controls, hidePrivateChats: true, hideGroupChats: true };
    window.__INSTADESK_CONTENT_CONTROLS__ = hideControls;
    window.__TAURI_INTERNALS__ = { invoke: async () => hideControls };
    delete window.__INSTADESK_CONTROLS__;
    installContentControls(window);
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#row")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("nav a span")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>('[role="list"]')!.style.display).not.toBe("none");
  });
  it("leaves unclassifiable rows alone when only one category is hidden", async () => {
    document.body.innerHTML = `<main>
      <a id="unknown" href="/direct/t/1/"><img src="/a.jpg"><span>Sarah</span><span>hey</span></a>
      <a id="private" href="/direct/t/2/"><img alt="profile picture of Mike" src="/b.jpg"><span>Mike</span><span>hey</span></a>
    </main>`;
    const hideControls = { ...controls, hidePrivateChats: true, hideGroupChats: false };
    window.__INSTADESK_CONTENT_CONTROLS__ = hideControls;
    window.__TAURI_INTERNALS__ = { invoke: async () => hideControls };
    delete window.__INSTADESK_CONTROLS__;
    installContentControls(window);
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#private")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#unknown")!.style.display).not.toBe("none");
  });
  it("prevents clicking on hidden conversation links", async () => {
    document.body.innerHTML = `<main>
      <a id="hidden-link" href="/direct/t/777/"><span>Sarah</span><span>Sarah: hey</span><img src="/a.jpg"></a>
    </main>`;
    const hideControls = { ...controls, hidePrivateChats: true, hideGroupChats: false };
    window.__INSTADESK_CONTENT_CONTROLS__ = hideControls;
    window.__TAURI_INTERNALS__ = { invoke: async () => hideControls };
    delete window.__INSTADESK_CONTROLS__;
    installContentControls(window);
    await Promise.resolve();

    const link = document.querySelector<HTMLAnchorElement>("#hidden-link")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const notCanceled = link.dispatchEvent(event);
    expect(notCanceled).toBe(false);
  });
  it("classifies custom group name with single avatar as group when preview has sender prefix", () => {
    const doc = document.createElement("div");
    doc.innerHTML = '<a href="/direct/t/555/"><span>Gaming Lounge</span><span>Alex: let\'s play</span><img src="/a.jpg"></a>';
    expect(inboxRowKind(doc.firstElementChild!)).toBe("group");
  });
  it("preserves comma-separated group title and extracts correct preview", () => {
    const doc = document.createElement("div");
    doc.innerHTML = '<a href="/direct/t/666/"><span>Alice, Bob, Charlie</span><span>Hey all · 2m</span><img src="/a.jpg"><img src="/b.jpg"></a>';
    const [item] = parseInboxList(doc as unknown as Document);
    expect(item.sender).toBe("Alice, Bob, Charlie");
    expect(item.preview).toBe("Hey all");
    expect(item.kind).toBe("group");
  });
});

describe("inbox row classifier", () => {
  it("keeps a 1:1 row private despite story rings, badges and icons", () => {
    document.body.innerHTML = `<main><a href="/direct/t/1/">
      <canvas></canvas><img alt="profile picture of Sarah" src="/a.jpg">
      <svg aria-label="Verified"></svg><svg aria-label="Seen"></svg>
      <span>Sarah</span><span>see you there</span>
    </a></main>`;
    expect(inboxRowKind(document.querySelector("a")!)).toBe("private");
  });

  it("does not read group wording out of the message text", () => {
    document.body.innerHTML = `<main><a href="/direct/t/1/">
      <img alt="profile picture of Sarah" src="/a.jpg"><span>Sarah</span><span>are people coming to the group thing</span>
    </a></main>`;
    expect(inboxRowKind(document.querySelector("a")!)).toBe("private");
  });

  it("reports unknown when nothing identifies the participants", () => {
    document.body.innerHTML = '<main><a href="/direct/t/1/"><img src="/a.jpg"><span>Sarah</span><span>hey</span></a></main>';
    expect(inboxRowKind(document.querySelector("a")!)).toBe("unknown");
  });
});

describe("inbox event classifier", () => {
  it("names reactions, typing, story replies and note replies", () => {
    expect(inboxEventKind("Liked your message")).toBe("reaction");
    expect(inboxEventKind("Reacted 😂 to your message")).toBe("reaction");
    expect(inboxEventKind("Sarah is typing")).toBe("typing");
    expect(inboxEventKind("Replied to your story")).toBe("storyReply");
    expect(inboxEventKind("Replied to your note")).toBe("noteReply");
    expect(inboxEventKind("bro look at this")).toBe("message");
    expect(inboxEventKind("sent an attachment")).toBe("message");
  });

  it("reports muted conversations from the row's own markup", () => {
    document.body.innerHTML = `<main>
      <a id="muted" href="/direct/t/1/"><span>Sarah</span><span>hey</span><img src="/a.jpg"><svg aria-label="Muted"></svg></a>
      <a id="loud" href="/direct/t/2/"><span>Mike</span><span>hey</span><img src="/b.jpg"></a>
    </main>`;
    expect(inboxRowMuted(document.querySelector("#muted")!)).toBe(true);
    expect(inboxRowMuted(document.querySelector("#loud")!)).toBe(false);
  });

  it("carries the event and muted flag through to the candidate", () => {
    document.body.innerHTML = '<main><a href="/direct/t/5/"><span>Sarah</span><span>Liked your message</span><img src="/a.jpg"></a></main>';
    const [item] = parseInboxList(document);
    expect(item).toMatchObject({ event: "reaction", muted: false });
  });
});

describe("navigation shortcuts", () => {
  it("captures F11 before page handlers and leaves the Alt chord to the native hook", async () => {
    const actions: string[] = [];
    window.__TAURI_INTERNALS__ = { invoke: async (_command, args) => { actions.push((args as { action: string }).action); } };
    delete window.__INSTADESK_SHORTCUTS__;
    installNavigationShortcuts(window);
    let reachedPageHandler = false;
    window.addEventListener("keydown", () => { reachedPageHandler = true; });

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "AltLeft", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "AltRight", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", cancelable: true }));
    await Promise.resolve();

    expect(actions).toEqual(["fullscreen"]);
  });
});

describe("ghost story viewer", () => {
  it("suppresses seen receipts across the shapes Instagram has used", () => {
    expect(looksLikeStorySeenRequest("/api/v1/stories/reel/seen/", undefined, "POST")).toBe(true);
    expect(looksLikeStorySeenRequest("/graphql/query", "fb_api_req_friendly_name=PolarisStoriesV3SeenMutation&x=1", "POST")).toBe(true);
    expect(looksLikeStorySeenRequest("/graphql/query", "fb_api_req_friendly_name=PolarisStoriesV3ReelSeenMutation", "POST")).toBe(true);
    expect(looksLikeStorySeenRequest("/api/graphql", "variables={}&doc_id=1&fb_api_req_friendly_name=useMarkSeenMutation", "POST")).toBe(true);
  });

  it("leaves reads and unrelated writes alone", () => {
    expect(looksLikeStorySeenRequest("/graphql/query", "fb_api_req_friendly_name=PolarisStoriesV3ReelPageQuery&seen_state=1", "GET")).toBe(false);
    expect(looksLikeStorySeenRequest("/api/v1/feed/timeline/", "reason=cold_start", "POST")).toBe(false);
    expect(looksLikeStorySeenRequest("/api/v1/direct_v2/threads/1/items/", "text=hey", "POST")).toBe(false);
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
