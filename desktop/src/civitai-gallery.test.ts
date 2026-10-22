import { describe, expect, it, vi } from "vitest";
import { loadCivitaiGalleryDetail, loadCivitaiGalleryPage } from "./civitai-gallery";
import type { OnlineGallerySearchRequest } from "./online-gallery";

const signedImageUrl = "https://image.civitai.com/x/a.png?token=source%2Fkeep&expires=123";

function image(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    url: signedImageUrl,
    type: "image",
    width: 832,
    height: 1216,
    username: "Ajuro",
    nsfw: false,
    nsfwLevel: "None",
    browsingLevel: 1,
    createdAt: "2025-04-17T21:28:57.225Z",
    baseModel: "SDXL 1.0",
    stats: { likeCount: 4, heartCount: 3, commentCount: 2 },
    meta: { prompt: "blue sky", negativePrompt: "blurry", sampler: "Euler" },
    ...overrides,
  };
}

function payload(items: unknown[], metadata: Record<string, unknown> = {}) {
  return { items, metadata };
}

function request(overrides: Partial<OnlineGallerySearchRequest> = {}): OnlineGallerySearchRequest {
  return { source: "civitai", ...overrides };
}

describe("Civitai gallery adapter", () => {
  it("reads the nested metadata returned by real single-image lookups", async () => {
    const fetchJson = async () => payload([image({ meta: { id: 123, meta: { prompt: "nested sky", negativePrompt: "nested blur" } } })]);
    const list = await loadCivitaiGalleryPage(fetchJson, request());
    const detail = await loadCivitaiGalleryDetail(fetchJson, "123");
    expect(detail.prompt).toBe("nested sky");
    expect(detail.negativePrompt).toBe("nested blur");
    expect(list.items[0].prompt).toBe(detail.prompt);
    expect(detail.item.prompt).toBe(detail.prompt);
    expect(detail.item.negativePrompt).toBe(detail.negativePrompt);
    expect(detail.metadata.baseModel).toBe("SDXL 1.0");
  });

  it("prefers nonempty direct prompts while accepting a missing field from nested metadata", async () => {
    const detail = await loadCivitaiGalleryDetail(async () => payload([image({ meta: {
      prompt: "direct", negativePrompt: " ", meta: { prompt: "nested", negativePrompt: "nested negative" },
    } })]), "123");
    expect(detail.prompt).toBe("direct");
    expect(detail.negativePrompt).toBe("nested negative");
  });

  it("queries usernames and uses Civitai cursor pagination without following nextPage", async () => {
    const fetchJson = vi.fn(async (_url: string) => payload([image()], {
      nextCursor: "feed:cursor/opaque + value",
      nextPage: "https://attacker.invalid/steal-or-restart",
    }));

    const result = await loadCivitaiGalleryPage(fetchJson, request({
      query: "@Ajuro",
      page: 2,
      pageSize: 48,
      sort: "favorites",
      timeRange: "week",
      cursor: "feed:previous/opaque + value",
    }));

    const calledUrl = new URL(fetchJson.mock.calls[0][0]);
    expect(calledUrl.origin).toBe("https://civitai.com");
    expect(calledUrl.pathname).toBe("/api/v1/images");
    expect(calledUrl.searchParams.get("username")).toBe("Ajuro");
    expect(calledUrl.searchParams.has("q")).toBe(false);
    expect(calledUrl.searchParams.get("limit")).toBe("48");
    expect(calledUrl.searchParams.get("cursor")).toBe("feed:previous/opaque + value");
    expect(calledUrl.searchParams.has("page")).toBe(false);
    expect(calledUrl.searchParams.get("sort")).toBe("Most Collected");
    expect(calledUrl.searchParams.get("period")).toBe("Week");
    expect(calledUrl.searchParams.get("type")).toBe("image");
    expect(calledUrl.searchParams.get("withMeta")).toBe("true");
    expect(calledUrl.searchParams.get("browsingLevel")).toBe("1");
    expect(calledUrl.searchParams.has("apiKey")).toBe(false);
    expect(result.page).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("feed:cursor/opaque + value");
    expect(result.items).toHaveLength(1);
  });

  it("rejects numeric page advancement without a cursor before making a request", async () => {
    const fetchJson = vi.fn();
    await expect(loadCivitaiGalleryPage(fetchJson, request({ page: 2 })))
      .rejects.toThrow("CIVITAI_CURSOR_REQUIRED_FOR_PAGE");
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("keeps an empty page open when the API provides another cursor", async () => {
    const fetchJson = vi.fn(async (_url: string) => payload([], { nextCursor: "feed:continue" }));
    const result = await loadCivitaiGalleryPage(fetchJson, request());
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("feed:continue");
  });

  it("rejects oversized and non-advancing cursors", async () => {
    const oversized = "x".repeat(4097);
    const fetchJson = vi.fn(async (_url: string) => payload([], { nextCursor: oversized }));

    await expect(loadCivitaiGalleryPage(fetchJson, request({ page: 2, cursor: oversized })))
      .rejects.toThrow("CIVITAI_INVALID_CURSOR");
    expect(fetchJson).not.toHaveBeenCalled();
    await expect(loadCivitaiGalleryPage(fetchJson, request()))
      .rejects.toThrow("CIVITAI_INVALID_CURSOR");

    await expect(loadCivitaiGalleryPage(
      async (_url: string) => payload([], { nextCursor: "feed:loop" }),
      request({ page: 2, cursor: "feed:loop" }),
    )).rejects.toThrow("CIVITAI_CURSOR_LOOP");
  });

  it("maps supported sorts and periods and rejects sorts Civitai cannot honor", async () => {
    const fetchJson = vi.fn(async (_url: string) => payload([]));
    const cases = [
      ["newest", "Newest", "day", "Day"],
      ["oldest", "Oldest", "month", "Month"],
      ["score", "Most Reactions", "year", "Year"],
      ["comments", "Most Comments", "all", "AllTime"],
      ["random", "Random", "week", "Week"],
    ] as const;

    for (const [sort, expectedSort, timeRange, expectedPeriod] of cases) {
      await loadCivitaiGalleryPage(fetchJson, request({ sort, timeRange }));
      const url = new URL(fetchJson.mock.calls.at(-1)![0]);
      expect(url.searchParams.get("sort")).toBe(expectedSort);
      expect(url.searchParams.get("period")).toBe(expectedPeriod);
    }
    await expect(loadCivitaiGalleryPage(fetchJson, request({ sort: "name" })))
      .rejects.toThrow("CIVITAI_UNSUPPORTED_SORT");
  });

  it("rejects a changed response envelope instead of treating it as an empty gallery", async () => {
    await expect(loadCivitaiGalleryPage(async () => ({ data: [] }), request()))
      .rejects.toThrow("CIVITAI_API_LAYOUT_CHANGED");
    await expect(loadCivitaiGalleryPage(async () => ({ items: {} }), request()))
      .rejects.toThrow("CIVITAI_API_LAYOUT_CHANGED");
  });

  it("keeps missing prompt metadata empty and records available generation metadata", async () => {
    const fetchJson = vi.fn(async (_url: string) => payload([image({ meta: undefined })]));
    const result = await loadCivitaiGalleryPage(fetchJson, request());
    const item = result.items[0];
    expect(item.prompt).toBe("");
    expect(item.negativePrompt).toBe("");
    expect(item.cover.displayUrl).toBe(signedImageUrl);
    expect(item.cover.downloadUrl).toBe(signedImageUrl);
    expect(item.sourceUrl).toBe("https://civitai.com/images/123");

    const detail = await loadCivitaiGalleryDetail(async () => payload([image({ meta: undefined })]), "123");
    expect(detail.prompt).toBe("");
    expect(detail.negativePrompt).toBe("");
    expect(detail.metadata.baseModel).toBe("SDXL 1.0");
  });

  it("asks the API for safe content by default and locally drops unsafe or unclassified results", async () => {
    const fetchJson = vi.fn(async (_url: string) => payload([
      image({ id: 1 }),
      image({ id: 2, browsingLevel: 2, nsfwLevel: "Soft" }),
      image({ id: 3, nsfw: true, browsingLevel: 1, nsfwLevel: "None" }),
      image({ id: 4, browsingLevel: undefined, nsfwLevel: undefined, nsfw: undefined }),
      image({ id: 5, browsingLevel: 1, nsfwLevel: "Soft" }),
      image({ id: 6, browsingLevel: 4_294_967_296, nsfwLevel: "None", nsfw: false }),
    ]));
    const result = await loadCivitaiGalleryPage(fetchJson, request());
    const url = new URL(fetchJson.mock.calls[0][0]);
    expect(url.searchParams.get("browsingLevel")).toBe("1");
    expect(result.items.map((item) => item.id)).toEqual(["1"]);
  });

  it("allows an explicit broader search while continuing to require image media and trusted URLs", async () => {
    const result = await loadCivitaiGalleryPage(async () => payload([
      image({ id: 1 }),
      image({ id: 2, browsingLevel: 2, nsfwLevel: "Soft", nsfw: true }),
      image({ id: 3, type: "video" }),
      image({ id: 4, type: "audio" }),
      image({ id: 5, url: "http://image.civitai.com/x/a.png" }),
      image({ id: 6, url: "https://image.civitai.com.evil.invalid/x/a.png" }),
      image({ id: 7, url: "https://user@image.civitai.com/x/a.png" }),
    ]), request({ safeOnly: false }));
    expect(result.items.map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("validates detail IDs and uses the public image lookup with metadata", async () => {
    const fetchJson = vi.fn(async (_url: string) => payload([image()]));
    const detail = await loadCivitaiGalleryDetail(fetchJson, "123");
    const url = new URL(fetchJson.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/v1/images");
    expect(url.searchParams.get("imageId")).toBe("123");
    expect(url.searchParams.get("type")).toBe("image");
    expect(url.searchParams.get("withMeta")).toBe("true");
    expect(url.searchParams.get("browsingLevel")).toBe("1");
    expect(detail.item.sourceUrl).toBe("https://civitai.com/images/123");
    expect(detail.prompt).toBe("blue sky");
    expect(detail.negativePrompt).toBe("blurry");

    for (const invalid of ["", "0", "-1", "1/2", "9007199254740992", "01"]) {
      await expect(loadCivitaiGalleryDetail(fetchJson, invalid)).rejects.toThrow("CIVITAI_INVALID_ID");
    }
  });

  it("rejects unsafe details by default and rejects untrusted or non-image detail responses", async () => {
    await expect(loadCivitaiGalleryDetail(
      async () => payload([image({ nsfw: true, browsingLevel: 2, nsfwLevel: "Soft" })]),
      "123",
    )).rejects.toThrow("CIVITAI_UNSAFE_IMAGE");
    await expect(loadCivitaiGalleryDetail(
      async () => payload([image({ url: "https://example.invalid/image.png" })]),
      "123",
      false,
    )).rejects.toThrow("CIVITAI_INVALID_IMAGE_RESPONSE");
    await expect(loadCivitaiGalleryDetail(async () => payload([]), "123"))
      .rejects.toThrow("CIVITAI_IMAGE_NOT_FOUND");
  });
});
