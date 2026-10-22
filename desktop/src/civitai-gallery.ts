import { emptyOnlineGalleryTagGroups } from "./online-gallery";
import type {
  OnlineGalleryDetail,
  OnlineGalleryItem,
  OnlineGalleryMedia,
  OnlineGalleryPage,
  OnlineGallerySearchRequest,
  OnlineGallerySort,
  OnlineGalleryTimeRange,
} from "./online-gallery";

export const CIVITAI_API_ORIGIN = "https://civitai.com";
const CIVITAI_IMAGE_ORIGIN = "https://image.civitai.com";
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 200;

type JsonRecord = Record<string, unknown>;
type CivitaiSort = "Most Reactions" | "Most Comments" | "Most Collected" | "Newest" | "Oldest" | "Random";
const MAX_CURSOR_LENGTH = 4096;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function firstCount(source: JsonRecord, keys: string[]): number {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return count(source[key]);
  }
  return 0;
}

function imageUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) return "";
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== CIVITAI_IMAGE_ORIGIN ||
      parsed.username ||
      parsed.password
    ) return "";
    // Validate with URL, but return the original string so Civitai's signed URL
    // query and encoding remain byte-for-byte intact.
    return value;
  } catch {
    return "";
  }
}

function imageId(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value : "";
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return "";
  return id;
}

function safeLevel(image: JsonRecord): boolean {
  const nsfw = image.nsfw;
  if (nsfw === true || nsfw === 1 || nsfw === "1" || nsfw === "true") return false;

  const level = image.browsingLevel;
  let hasSafeLevel = false;
  if (level !== undefined && level !== null) {
    const numeric = typeof level === "number" ? level : typeof level === "string" && level.trim() ? Number(level) : Number.NaN;
    if (!Number.isInteger(numeric) || (numeric !== 0 && numeric !== 1)) return false;
    hasSafeLevel = true;
  }

  const nsfwLevel = image.nsfwLevel;
  if (nsfwLevel !== undefined && nsfwLevel !== null) {
    if (typeof nsfwLevel !== "string" || nsfwLevel.toLowerCase() !== "none") return false;
    hasSafeLevel = true;
  }

  if (nsfw === false || nsfw === 0 || nsfw === "false") hasSafeLevel = true;
  return hasSafeLevel;
}

function mediaFromImage(image: JsonRecord, id: string): OnlineGalleryMedia | undefined {
  if (image.type !== "image") return undefined;
  const url = imageUrl(image.url);
  if (!url) return undefined;
  let extension: string | undefined;
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z\d]+)$/i);
    if (match) extension = match[1].toLowerCase();
  } catch {
    // imageUrl already validates the URL; this is a defensive fallback.
  }
  return {
    id,
    previewUrl: url,
    displayUrl: url,
    downloadUrl: url,
    width: count(image.width),
    height: count(image.height),
    ...(extension ? { extension } : {}),
  };
}

function promptFromMeta(meta: JsonRecord | undefined, key: string): string {
  const direct = text(meta?.[key]);
  // Single-image lookups can wrap generation metadata as { id, meta }.
  return direct.trim() ? direct : text(record(meta?.meta)?.[key]);
}

function ratingFromImage(image: JsonRecord): string {
  const label = text(image.nsfwLevel);
  if (label) return label;
  const level = image.browsingLevel;
  return typeof level === "number" || typeof level === "string" ? String(level) : "";
}

function itemFromImage(image: JsonRecord, media: OnlineGalleryMedia): OnlineGalleryItem {
  const id = media.id;
  const meta = record(image.meta);
  const username = text(image.username);
  const stats = record(image.stats) ?? {};
  const reactionCount = ["likeCount", "dislikeCount", "heartCount", "cryCount", "laughCount"]
    .reduce((sum, key) => sum + count(stats[key]), 0);
  const prompt = promptFromMeta(meta, "prompt");
  const negativePrompt = promptFromMeta(meta, "negativePrompt");
  const title = text(meta?.title) || `Civitai image ${id}`;
  const description = text(meta?.description) || text(image.description);
  const sourceUrl = `${CIVITAI_API_ORIGIN}/images/${id}`;

  return {
    source: "civitai",
    id,
    kind: "work",
    title,
    author: username,
    description,
    createdAt: text(image.createdAt),
    rating: ratingFromImage(image),
    score: reactionCount,
    favoriteCount: firstCount(stats, ["collectedCount", "collectionCount", "favoriteCount"]),
    viewCount: firstCount(stats, ["viewCount"]) || count(image.viewCount),
    mediaCount: 1,
    prompt,
    negativePrompt,
    tags: emptyOnlineGalleryTagGroups(),
    cover: media,
    sourceUrl,
  };
}

function imageItems(payload: unknown): JsonRecord[] {
  const response = record(payload);
  if (!response || !Array.isArray(response.items)) throw new Error("CIVITAI_API_LAYOUT_CHANGED");
  return response.items.map(record).filter((value): value is JsonRecord => !!value);
}

function cursorFrom(payload: unknown): string | undefined {
  const metadata = record(record(payload)?.metadata);
  const cursor = metadata?.nextCursor;
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH) throw new Error("CIVITAI_INVALID_CURSOR");
  return cursor;
}

function sortParameter(value: OnlineGallerySort | undefined): CivitaiSort {
  switch (value ?? "default") {
    case "default":
    case "score": return "Most Reactions";
    case "newest": return "Newest";
    case "oldest": return "Oldest";
    case "favorites": return "Most Collected";
    case "comments": return "Most Comments";
    case "random": return "Random";
    default: throw new Error("CIVITAI_UNSUPPORTED_SORT");
  }
}

function timeRangeParameter(value: OnlineGalleryTimeRange | undefined): string | undefined {
  switch (value ?? "all") {
    case "all": return "AllTime";
    case "day": return "Day";
    case "week": return "Week";
    case "month": return "Month";
    case "year": return "Year";
  }
}

function positivePage(value: number | undefined): number {
  const page = value ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new Error("CIVITAI_INVALID_PAGE");
  return page;
}

function pageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(value));
}

function imagesUrl(params: URLSearchParams): string {
  return `${CIVITAI_API_ORIGIN}/api/v1/images?${params.toString()}`;
}

function baseImageParams(limit: number, safeOnly: boolean): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(limit),
    type: "image",
    withMeta: "true",
  });
  if (safeOnly) params.set("browsingLevel", "1");
  return params;
}

export async function loadCivitaiGalleryPage(
  fetchJson: (url: string) => Promise<unknown>,
  request: OnlineGallerySearchRequest,
): Promise<OnlineGalleryPage> {
  const page = positivePage(request.page);
  const cursor = typeof request.cursor === "string" ? request.cursor : "";
  if (cursor.length > MAX_CURSOR_LENGTH) throw new Error("CIVITAI_INVALID_CURSOR");
  if (page > 1 && !cursor) throw new Error("CIVITAI_CURSOR_REQUIRED_FOR_PAGE");

  const safeOnly = request.safeOnly !== false;
  const size = pageSize(request.pageSize);
  const params = baseImageParams(size, safeOnly);
  const username = (typeof request.query === "string" ? request.query.trim() : "").replace(/^@/, "");
  if (username) params.set("username", username);
  params.set("sort", sortParameter(request.sort));
  params.set("period", timeRangeParameter(request.timeRange) ?? "AllTime");
  if (cursor) params.set("cursor", cursor);

  const payload = await fetchJson(imagesUrl(params));
  const responseItems = imageItems(payload);
  const items = responseItems.flatMap((image) => {
    if (safeOnly && !safeLevel(image)) return [];
    const id = imageId(image.id);
    if (!id) return [];
    const media = mediaFromImage(image, id);
    return media ? [itemFromImage(image, media)] : [];
  });
  const nextCursor = cursorFrom(payload);
  if (cursor && nextCursor === cursor) throw new Error("CIVITAI_CURSOR_LOOP");
  return {
    source: "civitai",
    page,
    pageSize: size,
    hasMore: !!nextCursor,
    ...(nextCursor ? { nextCursor } : {}),
    items,
  };
}

function validateDetailId(value: string): string {
  const id = imageId(value);
  if (!id) throw new Error("CIVITAI_INVALID_ID");
  return id;
}

export async function loadCivitaiGalleryDetail(
  fetchJson: (url: string) => Promise<unknown>,
  rawId: string,
  safeOnly = true,
): Promise<OnlineGalleryDetail> {
  const id = validateDetailId(rawId);
  const params = baseImageParams(1, safeOnly);
  params.set("imageId", id);
  const payload = await fetchJson(imagesUrl(params));
  const image = imageItems(payload).find((candidate) => imageId(candidate.id) === id);
  if (!image) throw new Error("CIVITAI_IMAGE_NOT_FOUND");
  if (safeOnly && !safeLevel(image)) throw new Error("CIVITAI_UNSAFE_IMAGE");
  const media = mediaFromImage(image, id);
  if (!media) throw new Error("CIVITAI_INVALID_IMAGE_RESPONSE");

  const item = itemFromImage(image, media);
  const meta = record(image.meta);
  const prompt = promptFromMeta(meta, "prompt");
  const negativePrompt = promptFromMeta(meta, "negativePrompt");
  const metadata: Record<string, unknown> = {};
  for (const key of ["baseModel", "modelVersionIds", "postId", "nsfw", "nsfwLevel", "browsingLevel", "stats"]) {
    if (image[key] !== undefined) metadata[key] = image[key];
  }
  if (meta) metadata.meta = meta;

  return {
    item,
    media: [media],
    prompt,
    negativePrompt,
    note: "",
    categoryPath: [],
    metadata,
  };
}
