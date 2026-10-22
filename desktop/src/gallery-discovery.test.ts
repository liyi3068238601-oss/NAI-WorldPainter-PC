import { describe, expect, it } from "vitest";
import type { OnlineGalleryItem, OnlineGallerySort, OnlineGalleryTimeRange } from "./online-gallery";
import {
  buildBooruQuery,
  defaultGallerySort,
  galleryDiscoveryText,
  gallerySortOptions,
  gallerySupportsTimeRange,
  normalizeGallerySort,
  sortQuickGalleryItems,
} from "./gallery-discovery";

function quickItem(id: string, title: string): OnlineGalleryItem {
  return {
    source: "quicktag",
    id,
    kind: "work",
    collectionId: "collection",
    title,
    author: "",
    description: "",
    createdAt: "",
    rating: "general",
    score: 0,
    favoriteCount: 0,
    viewCount: 0,
    mediaCount: 0,
    prompt: "",
    negativePrompt: "",
    tags: { artists: [], characters: [], copyrights: [], general: [], meta: [] },
    cover: { id, previewUrl: "", displayUrl: "", downloadUrl: "", width: 0, height: 0 },
    sourceUrl: "https://novelai.quicktagcloud.com/",
  };
}

describe("gallery discovery options", () => {
  it("uses the requested defaults and only exposes supported sorts", () => {
    expect(defaultGallerySort("danbooru")).toBe("default");
    expect(defaultGallerySort("safebooru")).toBe("default");
    expect(defaultGallerySort("gelbooru")).toBe("default");
    expect(defaultGallerySort("quicktag")).toBe("default");
    expect(defaultGallerySort("tags-gallery")).toBe("score");
    expect(defaultGallerySort("civitai")).toBe("score");
    expect(normalizeGallerySort("civitai", undefined)).toBe("score");

    expect(gallerySortOptions("tags-gallery")).toEqual(["score", "count", "name", "favorites"]);
    expect(gallerySortOptions("gelbooru")).toEqual(["default", "newest", "oldest", "score", "random"]);
    expect(gallerySortOptions("quicktag")).toEqual(["default", "name", "name-desc", "random"]);
    expect(gallerySortOptions("civitai")).toEqual(["newest", "oldest", "score", "favorites", "comments", "random"]);
    expect(() => normalizeGallerySort("gelbooru", "favorites")).toThrow(RangeError);
    expect(() => normalizeGallerySort("tags-gallery", "default")).toThrow(RangeError);
    expect(() => normalizeGallerySort("quicktag", "name-desc-extra")).toThrow(RangeError);
  });

  it("marks only Booru and Civitai sources as time-range capable", () => {
    expect(gallerySupportsTimeRange("danbooru")).toBe(true);
    expect(gallerySupportsTimeRange("safebooru")).toBe(true);
    expect(gallerySupportsTimeRange("gelbooru")).toBe(false);
    expect(gallerySupportsTimeRange("civitai")).toBe(true);
    expect(gallerySupportsTimeRange("quicktag")).toBe(false);
    expect(gallerySupportsTimeRange("tags-gallery")).toBe(false);
  });
});

describe("buildBooruQuery", () => {

  it("preserves manually entered order and dates for the default sort and all time", () => {
    expect(buildBooruQuery({
      source: "danbooru",
      query: "cat order:score sort:random date:2020-01-01 age:2d rating:e",
      sort: "default",
      timeRange: "all",
      safeOnly: true,
    })).toBe("cat order:score sort:random date:2020-01-01 age:2d rating:g");
  });

  it("replaces conflicting sort, age, date, and rating terms for an explicit range", () => {
    expect(buildBooruQuery({
      source: "danbooru",
      query: "fox order:score sort:random date:2020-01-01 age:2d rating:e",
      sort: "favorites",
      timeRange: "week",
      safeOnly: true,
    })).toBe("fox rating:g order:favcount age:<7d");
  });

  it("uses Gelbooru sort syntax and its safe rating", () => {
    expect(buildBooruQuery({
      source: "gelbooru",
      query: "anime order:score sort:random",
      sort: "newest",
      safeOnly: true,
    })).toBe("anime rating:general sort:id:desc");
  });

  it.each([
    ["danbooru", "newest", "order:id_desc"],
    ["danbooru", "oldest", "order:id_asc"],
    ["danbooru", "score", "order:score"],
    ["danbooru", "favorites", "order:favcount"],
    ["danbooru", "random", "order:random"],
    ["safebooru", "favorites", "order:favcount"],
    ["gelbooru", "newest", "sort:id:desc"],
    ["gelbooru", "oldest", "sort:id:asc"],
    ["gelbooru", "score", "sort:score:desc"],
    ["gelbooru", "random", "sort:random"],
  ] as const)("maps %s %s to the source query term", (source, sort, term) => {
    expect(buildBooruQuery({ source, query: "cat order:manual sort:manual", sort, safeOnly: false })).toBe(`cat ${term}`);
  });

  it.each([
    ["day", "1"],
    ["week", "7"],
    ["month", "30"],
    ["year", "365"],
  ] as const satisfies readonly (readonly [Exclude<OnlineGalleryTimeRange, "all">, string])[])(
    "adds the rolling %s age limit and removes existing date/age filters",
    (range, cutoff) => {
      expect(buildBooruQuery({
        source: "safebooru",
        query: "bird date:2020-01-01 age:2d",
        sort: "default",
        timeRange: range,
        safeOnly: false,
      })).toBe(`bird age:<${cutoff}d`);
    },
  );

  it("rejects non-Booru sources and unsupported Booru sorts", () => {
    expect(() => buildBooruQuery({ source: "quicktag", query: "fox" })).toThrow(RangeError);
    expect(() => buildBooruQuery({ source: "gelbooru", query: "fox", sort: "favorites" })).toThrow(RangeError);
  });
});

describe("sortQuickGalleryItems", () => {
  it("keeps default order, sorts names stably, and leaves input untouched", () => {
    const items = [quickItem("z", "zebra"), quickItem("a1", "alpha"), quickItem("a2", "Alpha"), quickItem("b", "beta")];

    expect(sortQuickGalleryItems(items, "default", 1).map((item) => item.id)).toEqual(["z", "a1", "a2", "b"]);
    expect(sortQuickGalleryItems(items, "name", 1).map((item) => item.id)).toEqual(["a1", "a2", "b", "z"]);
    expect(sortQuickGalleryItems(items, "name-desc", 1).map((item) => item.id)).toEqual(["z", "b", "a1", "a2"]);
    expect(items.map((item) => item.id)).toEqual(["z", "a1", "a2", "b"]);
  });

  it("shuffles with a repeatable seed instead of a random comparator", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"].map((id) => quickItem(id, id));
    const first = sortQuickGalleryItems(items, "random", 1234).map((item) => item.id);

    expect(sortQuickGalleryItems(items, "random", 1234).map((item) => item.id)).toEqual(first);
    expect(first).toHaveLength(items.length);
    expect(new Set(first)).toEqual(new Set(items.map((item) => item.id)));
    expect(() => sortQuickGalleryItems(items, "score" as OnlineGallerySort, 1234)).toThrow(RangeError);
  });
});

describe("galleryDiscoveryText", () => {
  it("provides five-language labels and falls back to English for unknown locales", () => {
    expect(galleryDiscoveryText("zh-CN").periods.day).toBe("最近24小时");
    expect(galleryDiscoveryText("zh-CN").reactions).toBe("互动最多");
    expect(galleryDiscoveryText("zh-CN").metricRange).toBe("热度统计范围");
    expect(galleryDiscoveryText("zh-TW").sort).toBe("排序");
    expect(galleryDiscoveryText("ja-JP").shuffle).toBe("シャッフル");
    expect(galleryDiscoveryText("ko-KR").timeRange).toBe("기간");
    expect(galleryDiscoveryText("ko-KR").modelNotice).toContain("모델");
    expect(galleryDiscoveryText("zh-CN").modelNotice).toBe("提示词仅供参考，实际生成效果取决于所用模型。");
    expect(galleryDiscoveryText("fr-FR").modelNotice).toBe("Prompts are for reference; results depend on the model used.");
    expect(galleryDiscoveryText("fr-FR").sorts.favorites).toBe("Favorites");
  });
});
