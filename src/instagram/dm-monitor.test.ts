// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { activeStoryMedia, blockedDestination, classifyThread, cleanAndParseJson, downloadAllStories, EMPTY_TIMELINE_RESPONSE, extractMediaFromFiber, extractStoryMediaFromJson, ghostStoryStopColor, inboxEventKind, inboxRowKind, inboxRowMuted, isGreenColor, isStoryGradientColor, looksLikeFeedTimelineRequest, looksLikeStorySeenRequest, installContentControls, installNavigationShortcuts, parseInboxList, postMediaSources, recolorStorySvg, recordVideoRequest, storyItemMap, userStoryReels, threadIdFromPath } from "./dm-monitor";

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
      <div role="listitem"><img alt="Sarah's profile picture" src="/a.jpg"><div><span>Sarah</span></div><div><span>bro look at this</span><span> · </span><span>1m</span></div></div>
    </div>`);
    const [item] = parseInboxList(doc);
    expect(item).toMatchObject({ sender: "Sarah", preview: "bro look at this", kind: "private" });
    expect(item.conversationUrl).toBe("https://www.instagram.com/direct/inbox/");
  });

  it("ignores the notes and story tray above the conversation list", () => {
    history.replaceState({}, "", "/direct/inbox/");
    const doc = inboxPage(`<div role="list">
      <div role="button" tabindex="0"><img alt="profile picture of rasputin964" src="/a.jpg"><span>rasputin964</span><span>Clip</span></div>
      <div role="listitem"><img alt="profile picture of Sarah" src="/b.jpg"><span>Sarah</span><span>hey</span><span>2h</span></div>
    </div>`);
    expect(parseInboxList(doc).map((item) => item.sender)).toEqual(["Sarah"]);
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
    expect(blockedDestination("/", controls)).toBe(false);
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
    expect(rules).toContain('aria-label="Reels"');
    expect(rules).toContain('aria-label="Explore"');
    expect(rules).toContain('aria-label="Search"');
    expect(rules).toContain("main article");
    expect(rules).toContain('main [data-visualcompletion="loading-state"]');
    expect(rules).toContain('main [aria-label*="Loading" i]');
    expect(document.querySelector<HTMLElement>("#stories")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#suggestions")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#feed")!.style.marginLeft).toBe("auto");
  });
  it("hides feed loading spinners when disablePosts is active while leaving stories intact", async () => {
    document.body.innerHTML = `<main>
      <section id="feed">
        <div id="stories"><a href="/stories/a/"></a></div>
        <div id="feed-spinner" role="progressbar" aria-label="Loading..."></div>
        <div id="loading-state" data-visualcompletion="loading-state"></div>
      </section>
    </main>`;
    const postsDisabledControls = { ...controls, disableStories: false, disablePosts: true };
    window.__INSTADESK_CONTENT_CONTROLS__ = postsDisabledControls;
    window.__TAURI_INTERNALS__ = { invoke: async () => postsDisabledControls };
    delete window.__INSTADESK_CONTROLS__;
    installContentControls(window);
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#feed-spinner")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#loading-state")!.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#stories")!.style.display).not.toBe("none");
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
      <div role="listitem" id="row"><img alt="Sarah's profile picture" src="/a.jpg"><span>Sarah</span><span>hey</span><span>1m</span></div>
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
    expect(looksLikeStorySeenRequest("/graphql/query", "fb_api_req_friendly_name=PolarisStoriesV3ReelPageQuery&variables={\"include_seen_state\":true}", "POST")).toBe(false);
    expect(looksLikeStorySeenRequest("/graphql/query", "fb_api_req_friendly_name=PolarisStoriesViewerRootQuery", "POST")).toBe(false);
    expect(looksLikeStorySeenRequest("/api/v1/feed/timeline/", "reason=cold_start", "POST")).toBe(false);
    expect(looksLikeStorySeenRequest("/api/v1/direct_v2/threads/1/items/", "text=hey", "POST")).toBe(false);
  });

  it("classifies close friends green colors vs default story gradient colors", () => {
    // Close friends green
    expect(isGreenColor("#25b94d")).toBe(true);
    expect(isGreenColor("#16c60c")).toBe(true);
    expect(isGreenColor("rgb(37, 185, 77)")).toBe(true);
    expect(isStoryGradientColor("#25b94d")).toBe(false);

    // Default story gradient colors (orange, red, purple, magenta)
    expect(isStoryGradientColor("#f09433")).toBe(true);
    expect(isStoryGradientColor("#dc2743")).toBe(true);
    expect(isStoryGradientColor("#bc1888")).toBe(true);
    expect(isGreenColor("#f09433")).toBe(false);

    // Viewed story gray is ignored
    expect(isGreenColor("#8e8e8e")).toBe(false);
    expect(isStoryGradientColor("#8e8e8e")).toBe(false);
  });

  it("transforms default gradient to pink and close friends green to blue", () => {
    // Default gradient stops -> Pink
    expect(ghostStoryStopColor("#f09433", 0.1)).toBe("#ff758c");
    expect(ghostStoryStopColor("#dc2743", 0.5)).toBe("#ff2d75");
    expect(ghostStoryStopColor("#bc1888", 0.9)).toBe("#e1306c");

    // Close friends green stops -> Blue
    expect(ghostStoryStopColor("#25b94d", 0.1)).toBe("#00c6ff");
    expect(ghostStoryStopColor("#16c60c", 0.5)).toBe("#0095f6");
    expect(ghostStoryStopColor("#00ba34", 0.9)).toBe("#0066ff");
  });

  it("recolors SVG story rings to pink (default) and blue (close friends)", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <svg id="default-story"><linearGradient><stop stop-color="#f09433" offset="0"></stop><stop stop-color="#dc2743" offset="1"></stop></linearGradient><circle stroke="#dc2743"></circle></svg>
      <svg id="cf-story"><linearGradient><stop stop-color="#25b94d" offset="0"></stop></linearGradient><circle stroke="#25b94d"></circle></svg>
    `;
    recolorStorySvg(container, true);

    expect(container.querySelector("#default-story circle")!.getAttribute("stroke")).toBe("#ff2d75");
    expect(container.querySelector("#cf-story circle")!.getAttribute("stroke")).toBe("#0095f6");
    expect(container.querySelector("#default-story stop")!.getAttribute("stop-color")).toBe("#ff758c");
    expect(container.querySelector("#cf-story stop")!.getAttribute("stop-color")).toBe("#00c6ff");
  });
});

describe("feed timeline suppression", () => {
  it("detects feed timeline requests across REST and GraphQL", () => {
    expect(looksLikeFeedTimelineRequest("/api/v1/feed/timeline/")).toBe(true);
    expect(looksLikeFeedTimelineRequest("/graphql/query", "fb_api_req_friendly_name=PolaroidFeedQuery")).toBe(true);
    expect(looksLikeFeedTimelineRequest("/graphql/query", "fb_api_req_friendly_name=usePolaroidFeedQuery")).toBe(true);
    expect(looksLikeFeedTimelineRequest("/graphql/query", "doc_id=123&fb_api_req_friendly_name=FeedTimelineQuery")).toBe(true);
  });

  it("leaves stories, reels tray, and direct message requests alone", () => {
    expect(looksLikeFeedTimelineRequest("/api/v1/feed/reels_tray/")).toBe(false);
    expect(looksLikeFeedTimelineRequest("/api/v1/direct_v2/inbox/")).toBe(false);
    expect(looksLikeFeedTimelineRequest("/graphql/query", "fb_api_req_friendly_name=PolarisStoriesV3SeenMutation")).toBe(false);
  });

  it("provides valid empty timeline payload with more_available: false", () => {
    expect(EMPTY_TIMELINE_RESPONSE.more_available).toBe(false);
    expect(EMPTY_TIMELINE_RESPONSE.feed_items).toHaveLength(0);
    expect(EMPTY_TIMELINE_RESPONSE.data.xdt_api__v1__feed__timeline__connection.page_info.has_next_page).toBe(false);
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

describe("story media actions and caching", () => {
  it("extracts and caches story video and image URLs into userStoryReels and storyItemMap", () => {
    const payload = {
      data: {
        xdt_api__v1__feed__reels_media: {
          reels_media: [
            {
              id: "123456",
              user: { username: "minacantart" },
              items: [
                {
                  id: "99887766",
                  video_versions: [{ url: "https://cdninstagram.com/story-video-1.mp4", width: 1080, height: 1920 }],
                  image_versions2: { candidates: [{ url: "https://cdninstagram.com/story-thumb-1.jpg", width: 1080, height: 1920 }] }
                },
                {
                  id: "99887767",
                  video_versions: [{ url: "https://cdninstagram.com/story-video-2.mp4", width: 1080, height: 1920 }],
                  image_versions2: { candidates: [{ url: "https://cdninstagram.com/story-thumb-2.jpg", width: 1080, height: 1920 }] }
                }
              ]
            }
          ]
        }
      }
    };
    extractStoryMediaFromJson(payload);
    expect(storyItemMap.has("99887766")).toBe(true);
    expect(storyItemMap.get("99887766")?.url).toBe("https://cdninstagram.com/story-video-1.mp4");
    expect(userStoryReels.has("minacantart")).toBe(true);
    expect(userStoryReels.get("minacantart")).toHaveLength(2);
    expect(userStoryReels.get("minacantart")![1].url).toBe("https://cdninstagram.com/story-video-2.mp4");
  });

  it("extracts media URLs from React Fiber objects on DOM nodes", () => {
    const video = document.createElement("video");
    (video as any).__reactFiber$test = {
      memoizedProps: {
        video_versions: [{ url: "https://cdninstagram.com/fiber-video.mp4" }]
      }
    };
    const extracted = extractMediaFromFiber(video);
    expect(extracted?.videoUrl).toBe("https://cdninstagram.com/fiber-video.mp4");
  });

  it("handles Instagram XSSI prefix for (;;); when parsing JSON responses", () => {
    const raw = `for (;;);{"data":{"xdt_api__v1__feed__reels_media":{"reels_media":[{"id":"555","user":{"username":"younesmohamed_77"},"items":[{"id":"777","video_versions":[{"url":"https://cdninstagram.com/younes-video.mp4"}]}]}]}}}`;
    cleanAndParseJson(raw);
    expect(userStoryReels.has("younesmohamed_77")).toBe(true);
    expect(userStoryReels.get("younesmohamed_77")![0].url).toBe("https://cdninstagram.com/younes-video.mp4");
  });

  it("extracts exact number of story items for a user without sub-resolution or chunk pollution", () => {
    const payload = {
      data: {
        xdt_api__v1__feed__reels_media: {
          reels_media: [
            {
              id: "111",
              user: { username: "ko_ghost17" },
              items: [
                {
                  id: "story_1",
                  pk: "1001",
                  media_type: 2,
                  video_versions: [
                    { url: "https://cdninstagram.com/ko-1-1080p.mp4", width: 1080 },
                    { url: "https://cdninstagram.com/ko-1-720p.mp4", width: 720 },
                    { url: "https://cdninstagram.com/ko-1-480p.mp4", width: 480 }
                  ],
                  image_versions2: { candidates: [{ url: "https://cdninstagram.com/ko-1-thumb.jpg" }] }
                },
                {
                  id: "story_2",
                  pk: "1002",
                  media_type: 1,
                  image_versions2: {
                    candidates: [
                      { url: "https://cdninstagram.com/ko-2-full.jpg", width: 1080 },
                      { url: "https://cdninstagram.com/ko-2-small.jpg", width: 360 }
                    ]
                  }
                },
                {
                  id: "story_3",
                  pk: "1003",
                  media_type: 2,
                  video_versions: [
                    { url: "https://cdninstagram.com/ko-3-1080p.mp4", width: 1080 },
                    { url: "https://cdninstagram.com/ko-3-720p.mp4", width: 720 }
                  ]
                }
              ]
            }
          ]
        }
      }
    };
    extractStoryMediaFromJson(payload);
    expect(userStoryReels.get("ko_ghost17")).toHaveLength(3);
    expect(userStoryReels.get("ko_ghost17")!.map((x) => x.url)).toEqual([
      "https://cdninstagram.com/ko-1-1080p.mp4",
      "https://cdninstagram.com/ko-2-full.jpg",
      "https://cdninstagram.com/ko-3-1080p.mp4"
    ]);
  });
});

