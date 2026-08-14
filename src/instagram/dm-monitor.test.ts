// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blockedDestination, classifyThread, parseCurrentThread, threadIdFromPath } from "./dm-monitor";

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
  const controls = { disableHomeFeed: true, disableReels: true, disableExplore: true, disableSearch: true };
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
});
