import type {
  OnlineGalleryItem,
  OnlineGallerySearchRequest,
  OnlineGallerySort,
  OnlineGalleryTimeRange,
} from "./online-gallery";

type GallerySource = OnlineGallerySearchRequest["source"];
type BooruSource = Extract<GallerySource, "danbooru" | "safebooru" | "gelbooru">;

const SORT_OPTIONS: Record<GallerySource, readonly OnlineGallerySort[]> = {
  "tags-gallery": ["score", "count", "name", "favorites"],
  civitai: ["newest", "oldest", "score", "favorites", "comments", "random"],
  danbooru: ["default", "newest", "oldest", "score", "favorites", "random"],
  safebooru: ["default", "newest", "oldest", "score", "favorites", "random"],
  gelbooru: ["default", "newest", "oldest", "score", "random"],
  quicktag: ["default", "name", "name-desc", "random"],
};

const DEFAULT_SORTS: Record<GallerySource, OnlineGallerySort> = {
  "tags-gallery": "score",
  civitai: "score",
  danbooru: "default",
  safebooru: "default",
  gelbooru: "default",
  quicktag: "default",
};

const BOORU_SORT_TERMS: Record<BooruSource, Partial<Record<OnlineGallerySort, string>>> = {
  danbooru: {
    newest: "order:id_desc",
    oldest: "order:id_asc",
    score: "order:score",
    favorites: "order:favcount",
    random: "order:random",
  },
  safebooru: {
    newest: "order:id_desc",
    oldest: "order:id_asc",
    score: "order:score",
    favorites: "order:favcount",
    random: "order:random",
  },
  gelbooru: {
    newest: "sort:id:desc",
    oldest: "sort:id:asc",
    score: "sort:score:desc",
    random: "sort:random",
  },
};

const RANGE_DAYS: Record<Exclude<OnlineGalleryTimeRange, "all">, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const BOORU_SOURCES: readonly BooruSource[] = ["danbooru", "safebooru", "gelbooru"];

export function gallerySortOptions(source: GallerySource): OnlineGallerySort[] {
  return [...SORT_OPTIONS[source]];
}

export function defaultGallerySort(source: GallerySource): OnlineGallerySort {
  return DEFAULT_SORTS[source];
}

export function normalizeGallerySort(source: GallerySource, value?: unknown): OnlineGallerySort {
  if (value === undefined) return defaultGallerySort(source);
  if (typeof value === "string" && SORT_OPTIONS[source].includes(value as OnlineGallerySort)) {
    return value as OnlineGallerySort;
  }
  throw new RangeError(`Unsupported ${source} gallery sort: ${String(value)}`);
}

export function gallerySupportsTimeRange(source: GallerySource): boolean {
  return source === "danbooru" || source === "safebooru" || source === "civitai";
}

function isBooruSource(source: GallerySource): source is BooruSource {
  return BOORU_SOURCES.includes(source as BooruSource);
}

function removeTerms(query: string, names: readonly string[]): string {
  const alternatives = names.join("|");
  const pattern = new RegExp(`(^|\\s)-?(?:${alternatives}):[^\\s]+`, "gi");
  return query.replace(pattern, " ").replace(/\s+/g, " ").trim();
}

function appendTerm(query: string, term: string): string {
  return query ? `${query} ${term}` : term;
}

export function buildBooruQuery(request: OnlineGallerySearchRequest): string {
  if (!isBooruSource(request.source)) {
    throw new RangeError(`Booru query is not supported for ${request.source}`);
  }

  const sort = normalizeGallerySort(request.source, request.sort);
  let query = (request.query ?? "").trim();
  if (sort !== "default") query = removeTerms(query, ["order", "sort"]);

  const timeRange = request.timeRange ?? "all";
  if (timeRange !== "all" && !Object.prototype.hasOwnProperty.call(RANGE_DAYS, timeRange)) {
    throw new RangeError(`Unsupported gallery time range: ${timeRange}`);
  }
  if (timeRange !== "all" && !gallerySupportsTimeRange(request.source)) throw new RangeError("Unsupported gallery time range");
  if (timeRange !== "all") query = removeTerms(query, ["date", "age"]);

  if (request.safeOnly !== false) {
    query = removeTerms(query, ["rating"]);
    query = appendTerm(query, request.source === "gelbooru" ? "rating:general" : "rating:g");
  }

  if (sort !== "default") {
    const term = BOORU_SORT_TERMS[request.source][sort];
    if (!term) throw new RangeError(`Unsupported ${request.source} gallery sort: ${sort}`);
    query = appendTerm(query, term);
  }

  if (timeRange !== "all") {
    query = appendTerm(query, `age:<${RANGE_DAYS[timeRange as Exclude<OnlineGalleryTimeRange, "all">]}d`);
  }

  return query;
}

const QUICKTAG_COLLATOR = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function sortQuickGalleryItems(
  items: OnlineGalleryItem[],
  sort: OnlineGallerySort,
  seed: number,
): OnlineGalleryItem[] {
  const normalized = normalizeGallerySort("quicktag", sort);
  if (normalized === "default") return [...items];

  if (normalized === "name" || normalized === "name-desc") {
    const direction = normalized === "name" ? 1 : -1;
    return items
      .map((item, index) => ({ item, index }))
      .sort((left, right) => direction * QUICKTAG_COLLATOR.compare(left.item.title, right.item.title) || left.index - right.index)
      .map(({ item }) => item);
  }

  const result = [...items];
  const random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export interface GalleryDiscoveryText {
  sort: string;
  timeRange: string;
  model: string;
  username: string;
  reactions: string;
  metricRange: string;
  missingPrompt: string;
  modelNotice: string;
  shuffle: string;
  sorts: Record<OnlineGallerySort, string>;
  periods: Record<OnlineGalleryTimeRange, string>;
}

const ENGLISH_TEXT: GalleryDiscoveryText = {
  sort: "Sort",
  timeRange: "Time range",
  model: "Model",
  username: "Creator",
  reactions: "Most reacted",
  metricRange: "Popularity period",
  missingPrompt: "No generation prompt is available for this image.",
  modelNotice: "Prompts are for reference; results depend on the model used.",
  shuffle: "Shuffle",
  sorts: {
    default: "Default",
    newest: "Newest",
    oldest: "Oldest",
    score: "Score",
    favorites: "Favorites",
    comments: "Comments",
    random: "Random",
    name: "Name, ascending",
    "name-desc": "Name, descending",
    count: "Count",
  },
  periods: {
    all: "All time",
    day: "Last 24 hours",
    week: "Last 7 days",
    month: "Last 30 days",
    year: "Last 365 days",
  },
};

const DISCOVERY_TEXT: Record<string, Partial<GalleryDiscoveryText>> = {
  "zh-CN": {
    sort: "排序",
    timeRange: "时间范围",
    model: "模型",
    username: "作者用户名（可加 @）",
    reactions: "互动最多",
    metricRange: "热度统计范围",
    missingPrompt: "这张图片没有可用的生成提示词。",
    modelNotice: "提示词仅供参考，实际生成效果取决于所用模型。",
    shuffle: "打乱顺序",
    sorts: {
      default: "默认",
      newest: "最新",
      oldest: "最早",
      score: "评分",
      favorites: "收藏数",
      comments: "评论数",
      random: "随机",
      name: "名称升序",
      "name-desc": "名称降序",
      count: "投稿数",
    },
    periods: { all: "不限", day: "最近24小时", week: "最近7天", month: "最近30天", year: "最近365天" },
  },
  "zh-TW": {
    sort: "排序",
    timeRange: "時間範圍",
    model: "模型",
    username: "作者",
    reactions: "互動最多",
    metricRange: "熱門度統計範圍",
    missingPrompt: "這張圖片沒有可用的生成提示詞。",
    modelNotice: "提示詞僅供參考，實際生成效果取決於所使用的模型。",
    shuffle: "打亂順序",
    sorts: {
      default: "預設",
      newest: "最新",
      oldest: "最早",
      score: "評分",
      favorites: "收藏數",
      comments: "評論數",
      random: "隨機",
      name: "名稱升序",
      "name-desc": "名稱降序",
      count: "數量",
    },
    periods: { all: "不限", day: "最近24小時", week: "最近7天", month: "最近30天", year: "最近365天" },
  },
  "ja-JP": {
    sort: "並び替え",
    timeRange: "期間",
    model: "モデル",
    username: "投稿者",
    reactions: "反応が多い順",
    metricRange: "人気度の集計期間",
    missingPrompt: "この画像には利用可能な生成プロンプトがありません。",
    modelNotice: "プロンプトは参考用です。生成結果は使用するモデルによって異なります。",
    shuffle: "シャッフル",
    sorts: {
      default: "標準",
      newest: "新しい順",
      oldest: "古い順",
      score: "スコア",
      favorites: "お気に入り数",
      comments: "コメント数",
      random: "ランダム",
      name: "名前の昇順",
      "name-desc": "名前の降順",
      count: "件数",
    },
    periods: { all: "全期間", day: "過去24時間", week: "過去7日間", month: "過去30日間", year: "過去365日間" },
  },
  "ko-KR": {
    sort: "정렬",
    timeRange: "기간",
    model: "모델",
    username: "작성자",
    reactions: "반응 많은 순",
    metricRange: "인기 통계 기간",
    missingPrompt: "이 이미지에는 사용할 수 있는 생성 프롬프트가 없습니다.",
    modelNotice: "프롬프트는 참고용이며 생성 결과는 사용한 모델에 따라 달라집니다.",
    shuffle: "순서 섞기",
    sorts: {
      default: "기본",
      newest: "최신순",
      oldest: "오래된 순",
      score: "점수",
      favorites: "즐겨찾기 수",
      comments: "댓글 수",
      random: "무작위",
      name: "이름 오름차순",
      "name-desc": "이름 내림차순",
      count: "개수",
    },
    periods: { all: "전체 기간", day: "최근 24시간", week: "최근 7일", month: "최근 30일", year: "최근 365일" },
  },
};

export function galleryDiscoveryText(language: string | null | undefined): GalleryDiscoveryText {
  const localized = language ? DISCOVERY_TEXT[language] ?? {} : {};
  return {
    ...ENGLISH_TEXT,
    ...localized,
    sorts: { ...ENGLISH_TEXT.sorts, ...localized.sorts },
    periods: { ...ENGLISH_TEXT.periods, ...localized.periods },
  };
}
