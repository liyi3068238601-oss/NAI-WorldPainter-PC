import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const axiosGet = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({ default: { get: axiosGet } }));
vi.mock("./gallery-network", async () => {
  const actual = await vi.importActual<typeof import("./gallery-network")>("./gallery-network");
  return { ...actual };
});
vi.mock("./proxy", () => ({ proxyConfig: () => ({}), proxyConfigForUrl: async () => ({ proxy: false }) }));
vi.mock("./store", () => ({ getSettings: () => ({ proxyMode: "direct" }), setSetting: vi.fn() }));

import { clearOnlineGalleryDataCache, getOnlineGalleryDetail, searchOnlineGallery } from "./online-gallery";

beforeEach(() => {
  clearOnlineGalleryDataCache();
  axiosGet.mockReset();
});

describe("online gallery adapters", () => {
  it("maps source sorting on the server and separates cached sort orders", async () => {
    axiosGet.mockImplementation(async (url: string) => url.includes("/counts/") ? {data: {counts: {posts: 0}}} : {data: []});
    await searchOnlineGallery({source: "danbooru", query: "sitting order:id", sort: "favorites"});
    await searchOnlineGallery({source: "danbooru", query: "sitting order:id", sort: "oldest"});
    const calls = axiosGet.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/posts.json");
    expect(calls).toHaveLength(2);
    expect(calls[0][1].params.tags).toContain("order:favcount");
    expect(calls[0][1].params.tags).not.toMatch(/order:id\b/);
    expect(calls[1][1].params.tags).toMatch(/order:id(?:_asc)?\b/);
    expect(calls.every(([, options]) => options.params.tags.includes("rating:g"))).toBe(true);
    await expect(searchOnlineGallery({source: "gelbooru", sort: "favorites"})).rejects.toThrow();
  });

  it("does not cache random discoveries", async () => {
    axiosGet.mockImplementation(async (url: string) => url.includes("/counts/") ? {data: {counts: {posts: 0}}} : {data: []});
    await searchOnlineGallery({source: "danbooru", sort: "random"});
    await searchOnlineGallery({source: "danbooru", sort: "random"});
    expect(axiosGet.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/posts.json")).toHaveLength(2);
  });

  it("wires Civitai cursors, safe details and public metadata through IPC", async () => {
    const post = {id: 9, type: "image", browsingLevel: 1, nsfwLevel: "None", url: "https://image.civitai.com/test/example.jpeg", meta: {prompt: "synthetic prompt", negativePrompt: "synthetic negative"}};
    axiosGet.mockImplementation(async (url: string) => ({data: {items: [post], metadata: {nextCursor: new URL(url).searchParams.has("cursor") ? "feed:two:9" : "feed:one:9"}}}));
    const first = await searchOnlineGallery({source: "civitai", sort: "favorites", timeRange: "week"});
    const second = await searchOnlineGallery({source: "civitai", page: 2, cursor: first.nextCursor, sort: "favorites", timeRange: "week"});
    expect(second.page).toBe(2);
    const urls = axiosGet.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[1].searchParams.get("cursor")).toBe("feed:one:9");
    expect(urls[1].searchParams.get("sort")).toBe("Most Collected");
    expect(urls[1].searchParams.get("period")).toBe("Week");
    expect(urls[1].searchParams.get("page")).toBeNull();
    const detail = await getOnlineGalleryDetail({source: "civitai", id: "9", safeOnly: false});
    expect(detail.prompt).toBe("synthetic prompt");
    const detailUrl = new URL(String(axiosGet.mock.calls.at(-1)![0]));
    expect(detailUrl.searchParams.get("imageId")).toBe("9");
    expect(detailUrl.searchParams.get("browsingLevel")).toBeNull();
    await expect(searchOnlineGallery({source: "civitai", page: 2})).rejects.toThrow("CURSOR");
  });
  it("normalizes Safebooru search and detail into one source-neutral shape", async () => {
    const post = {
      id: 42,
      rating: "g",
      preview_file_url: "https://cdn.donmai.us/180x180/demo.jpg",
      large_file_url: "https://cdn.donmai.us/sample/demo.jpg",
      file_url: "https://cdn.donmai.us/original/demo.jpg",
      image_width: 832,
      image_height: 1216,
      tag_string: "1girl solo smile",
      tag_string_artist: "artist_name",
      tag_string_character: "character_name",
      tag_string_copyright: "series_name",
      tag_string_general: "1girl solo smile",
      tag_string_meta: "highres",
      score: 8,
      fav_count: 3,
    };
    axiosGet.mockImplementation(async (url: string) => url.includes("/counts/posts.json")
      ? { data: { counts: { posts: 25 } } }
      : { data: [post] });

    const page = await searchOnlineGallery({ source: "safebooru", page: 1, pageSize: 12, query: "smile", safeOnly: true });
    expect(page.items).toHaveLength(1);
    expect(page.pageSize).toBe(12);
    expect(page.total).toBe(25);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toMatchObject({
      source: "safebooru",
      id: "42",
      prompt: "1girl, solo, smile",
      author: "artist_name",
    });
    expect(axiosGet).toHaveBeenCalledWith(
      "https://safebooru.donmai.us/posts.json",
      expect.objectContaining({ params: expect.objectContaining({ tags: "smile rating:g", limit: 12 }) }),
    );
    expect(axiosGet).toHaveBeenCalledWith(
      "https://safebooru.donmai.us/counts/posts.json",
      expect.objectContaining({ params: { tags: "smile rating:g" } }),
    );

    axiosGet.mockResolvedValueOnce({ data: post });
    const detail = await getOnlineGalleryDetail({ source: "safebooru", id: "42" });
    expect(detail.media[0]).toMatchObject({ width: 832, height: 1216 });
    expect(detail.item.tags.characters).toEqual(["character_name"]);
  });

  it("loads QuickTagCloud collections, entries, assets and details with manifest verification", async () => {
    const codex = {
      id: "demo",
      title: "演示图鉴",
      author: "Tester",
      version: "1.0",
      entries: [{
        id: "demo_1",
        title: "柔和日光",
        tags: "1girl, solo, soft lighting",
        negative: "lowres",
        path: ["光线"],
        image: "demo.jpg",
        original: "demo.png",
        imageWidth: 832,
        imageHeight: 1216,
        images: [{ path: "demo.jpg", original: "demo.png" }],
      }],
    };
    const bytes = Buffer.from(JSON.stringify(codex));
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const manifestEntry = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    axiosGet.mockImplementation(async (url: string) => {
      if (url.endsWith("/data-source.json")) return { data: { baseUrl: "https://assets.quicktagcloud.com/data", pointer: "current.json" } };
      if (url.endsWith("/data/current.json")) return { data: { release: "r-test", manifest: "releases/r-test/manifest.json" } };
      if (url.endsWith("/manifest.json")) return { data: { files: { "demo.json": manifestEntry } } };
      if (url.endsWith("/codexes.json")) return { data: [{ id: "demo", title: "演示图鉴", author: "Tester", version: "1.0", entryCount: 1, imagedCount: 1, cover: "demo.jpg" }] };
      if (url.endsWith("/media.json")) return { data: { baseUrl: "https://assets.quicktagcloud.com", imagePrefix: "images", originalPrefix: "originals" } };
      if (url.endsWith("/demo.json")) return { data: arrayBuffer };
      throw new Error(`Unexpected URL: ${url}`);
    });

    const collections = await searchOnlineGallery({ source: "quicktag", page: 1, safeOnly: true });
    expect(collections.items[0]).toMatchObject({ kind: "collection", id: "demo", title: "演示图鉴" });
    expect(collections.items[0].cover.previewUrl).toBe("https://assets.quicktagcloud.com/images/demo/demo.jpg");

    const entries = await searchOnlineGallery({ source: "quicktag", page: 1, collectionId: "demo", safeOnly: true });
    expect(entries.items[0]).toMatchObject({ id: "demo_1", prompt: "1girl, solo, soft lighting" });
    expect(entries.items[0].cover.downloadUrl).toBe("https://assets.quicktagcloud.com/originals/demo/demo.png");

    const detail = await getOnlineGalleryDetail({ source: "quicktag", collectionId: "demo", id: "demo_1" });
    expect(detail.negativePrompt).toBe("lowres");
    expect(detail.categoryPath).toEqual(["光线"]);
  });
});
