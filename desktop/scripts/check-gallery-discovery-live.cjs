"use strict";

const fs = require("node:fs");
const path = require("node:path");
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const reportPath = path.join(repoRoot, "docs", "evidence", "gallery-discovery-20261022", "live-report.json");

const {
  loadTagsGalleryPage,
  tagsGalleryDetailUrl,
  parseTagsGalleryDetail,
} = require(path.join(desktopRoot, "dist-electron", "src", "tags-gallery.js"));
const {
  loadCivitaiGalleryPage,
  loadCivitaiGalleryDetail,
} = require(path.join(desktopRoot, "dist-electron", "src", "civitai-gallery.js"));
const { buildBooruQuery } = require(path.join(desktopRoot, "dist-electron", "src", "gallery-discovery.js"));

const REQUEST_TIMEOUT_MS = 20_000;
const errors = [];
const report = {
  checkedAt: new Date().toISOString(),
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  constraints: {
    publicGetOnly: true,
    userConfigurationRead: false,
    credentialsUsed: false,
    imagesDownloaded: false,
    rawPromptsPersisted: false,
  },
  tagsGallery: {},
  civitai: {},
  booru: {},
  errors,
};

function safeError(error) {
  if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) return "request_timeout";
  const message = String(error && error.message ? error.message : error || "request_failed");
  const code = message.match(/^(?:HTTP_\d{3}|TAGS_GALLERY_[A-Z_]+|CIVITAI_[A-Z_]+)$/);
  if (code) return code[0];
  if (error && typeof error.code === "string" && /^[A-Z0-9_]{2,40}$/.test(error.code)) return error.code;
  return "request_failed";
}

function recordError(source, stage, error) {
  errors.push({ source, stage, error: safeError(error) });
}

async function publicGet(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: accept,
        "User-Agent": "Langbai-Gallery-Live-Check/1.0",
      },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function publicHtml(url) {
  const response = await publicGet(url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
  return response.body;
}

function compactIds(items, count = 5) {
  return items.slice(0, count).map((item) => String(item.id));
}

function summarizeDetail(id, prompt, model, expectedModel) {
  const modelName = typeof model === "string" ? model : "";
  return {
    id: String(id),
    hasPrompt: typeof prompt === "string" && Boolean(prompt.trim()),
    hasModel: Boolean(modelName),
    modelMatchesRequested: expectedModel ? modelName.toLowerCase().includes(expectedModel) : undefined,
  };
}

function promptCoverage(page) {
  const items = page && Array.isArray(page.items) ? page.items : [];
  return {
    count: items.length,
    promptCount: items.filter((item) => typeof item.prompt === "string" && Boolean(item.prompt.trim())).length,
    negativePromptCount: items.filter((item) => typeof item.negativePrompt === "string" && Boolean(item.negativePrompt.trim())).length,
  };
}

function firstPromptItem(page) {
  return page && Array.isArray(page.items)
    ? page.items.find((item) => typeof item.prompt === "string" && Boolean(item.prompt.trim()))
    : undefined;
}

async function checkTagsModel(model) {
  const expectedModel = model === "v5" ? "v5" : "v4.5";
  const upstreamRequests = [];
  const fetchHtml = async (url) => {
    const parsed = new URL(url);
    const meta = {
      upstreamPage: Number(parsed.searchParams.get("p") || 1),
      requestSort: parsed.searchParams.get("s") || "score",
      model,
    };
    upstreamRequests.push(meta);
    try {
      const response = await publicGet(url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
      meta.httpStatus = response.status;
      return response.body;
    } catch (error) {
      meta.error = safeError(error);
      throw error;
    }
  };

  const result = {
    model,
    requestSort: "score",
    pageSize: 48,
    firstPage: null,
    crossBoundaryPage: null,
    detail: null,
    upstreamRequests,
  };
  report.tagsGallery[model] = result;

  let firstPage;
  try {
    firstPage = await loadTagsGalleryPage(fetchHtml, "artist", 1, 48, "", "score", model);
    result.firstPage = {
      page: firstPage.page,
      count: firstPage.items.length,
      total: firstPage.total,
      ids: compactIds(firstPage.items),
      hasMore: firstPage.hasMore,
      requestSort: "score",
    };
  } catch (error) {
    recordError("tags-gallery", `${model}:page-1`, error);
  }

  try {
    const before = upstreamRequests.length;
    const page = await loadTagsGalleryPage(fetchHtml, "artist", 2, 48, "", "score", model);
    const pageRequests = upstreamRequests.slice(before);
    const firstIds = new Set((firstPage?.items ?? []).map((item) => String(item.id)));
    const pageIds = page.items.map((item) => String(item.id));
    result.crossBoundaryPage = {
      page: page.page,
      pageSize: page.pageSize,
      offset: 48,
      upstreamPageSize: 60,
      crossesUpstreamBoundary: (48 % 60) + page.pageSize > 60,
      crossBoundaryObserved: pageRequests.some((request) => request.upstreamPage === 1)
        && pageRequests.some((request) => request.upstreamPage === 2),
      upstreamPagesRequested: pageRequests.map((request) => request.upstreamPage),
      count: page.items.length,
      total: page.total,
      ids: compactIds(page.items),
      overlapWithPreviousPage: pageIds.filter((id) => firstIds.has(id)).length,
      requestSort: "score",
    };
  } catch (error) {
    recordError("tags-gallery", `${model}:page-2-size-48`, error);
  }

  if (firstPage && firstPage.items.length) {
    const id = String(firstPage.items[0].id);
    try {
      const detailHtml = await publicHtml(tagsGalleryDetailUrl(id));
      const detail = parseTagsGalleryDetail(detailHtml, id);
      result.detail = summarizeDetail(id, detail.prompt, detail.metadata && detail.metadata.model, expectedModel);
    } catch (error) {
      recordError("tags-gallery", `${model}:detail`, error);
    }
  }
}

async function checkCivitai() {
  const requests = [];
  const fetchJson = async (url) => {
    const parsed = new URL(url);
    const meta = {
      isDetail: parsed.searchParams.has("imageId"),
      requestSort: parsed.searchParams.get("sort") || "",
      period: parsed.searchParams.get("period") || "",
      hasCursor: parsed.searchParams.has("cursor"),
    };
    requests.push(meta);
    try {
      const response = await publicGet(url, "application/json");
      meta.httpStatus = response.status;
      try {
        return JSON.parse(response.body);
      } catch {
        throw new Error("invalid_json_response");
      }
    } catch (error) {
      meta.error = safeError(error);
      throw error;
    }
  };

  const result = {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    newestPage1: null,
    cursorPage2: null,
    promptCoverage: { status: "not_checked", pages: {} },
    promptDetail: null,
    favoritesPage: null,
    scoreFallbackPage: null,
    requests,
  };
  report.civitai = result;

  let newestPage;
  let cursorPage;
  try {
    newestPage = await loadCivitaiGalleryPage(fetchJson, {
      source: "civitai", page: 1, pageSize: 6, sort: "newest", timeRange: "all", safeOnly: true,
    });
    result.newestPage1 = {
      page: newestPage.page,
      count: newestPage.items.length,
      ids: compactIds(newestPage.items),
      ...promptCoverage(newestPage),
      hasNextCursor: Boolean(newestPage.nextCursor),
      requestSort: requests.at(-1)?.requestSort,
      period: requests.at(-1)?.period,
    };
  } catch (error) {
    recordError("civitai", "newest-page-1", error);
  }

  if (newestPage?.nextCursor) {
    try {
      cursorPage = await loadCivitaiGalleryPage(fetchJson, {
        source: "civitai",
        page: 2,
        pageSize: 6,
        cursor: newestPage.nextCursor,
        sort: "newest",
        timeRange: "all",
        safeOnly: true,
      });
      result.cursorPage2 = {
        page: cursorPage.page,
        count: cursorPage.items.length,
        ids: compactIds(cursorPage.items),
        ...promptCoverage(cursorPage),
        promptSummary: promptCoverage(cursorPage),
        hasNextCursor: Boolean(cursorPage.nextCursor),
        cursorSent: requests.at(-1)?.hasCursor === true,
        requestSort: requests.at(-1)?.requestSort,
        period: requests.at(-1)?.period,
      };
    } catch (error) {
      recordError("civitai", "cursor-page-2", error);
    }
  } else if (newestPage) {
    recordError("civitai", "cursor-page-2", new Error("CIVITAI_NO_NEXT_CURSOR"));
  }

  let favoritesPage;
  try {
    favoritesPage = await loadCivitaiGalleryPage(fetchJson, {
      source: "civitai", page: 1, pageSize: 6, sort: "favorites", timeRange: "month", safeOnly: true,
    });
    result.favoritesPage = {
      page: favoritesPage.page,
      count: favoritesPage.items.length,
      ids: compactIds(favoritesPage.items),
      ...promptCoverage(favoritesPage),
      hasNextCursor: Boolean(favoritesPage.nextCursor),
      requestSort: requests.at(-1)?.requestSort,
      metricRange: requests.at(-1)?.period,
    };
  } catch (error) {
    recordError("civitai", "favorites-page-1", error);
  }

  const candidatePages = [
    ["newest-page-1", newestPage],
    ["cursor-page-2", cursorPage],
    ["favorites-page-1", favoritesPage],
  ];
  const candidate = candidatePages
    .map(([source, page]) => ({ source, item: firstPromptItem(page) }))
    .find((entry) => entry.item);

  async function inspectPromptDetail(source, item) {
    const id = String(item.id);
    try {
      const detail = await loadCivitaiGalleryDetail(fetchJson, id, true);
      const prompt = typeof detail.prompt === "string" ? detail.prompt : "";
      const negativePrompt = typeof detail.negativePrompt === "string" ? detail.negativePrompt : "";
      const metadata = detail.metadata && typeof detail.metadata === "object" ? detail.metadata : {};
      const hasBaseModel = Object.prototype.hasOwnProperty.call(metadata, "baseModel")
        && metadata.baseModel !== null && metadata.baseModel !== "";
      const hasModelVersionIds = Object.prototype.hasOwnProperty.call(metadata, "modelVersionIds");
      result.promptDetail = {
        source,
        id,
        listHasPrompt: true,
        hasNestedPromptMetadata: typeof metadata.meta?.meta?.prompt === "string",
        hasPrompt: Boolean(prompt.trim()),
        promptLength: prompt.length,
        hasNegativePrompt: Boolean(negativePrompt.trim()),
        negativePromptLength: negativePrompt.length,
        hasBaseModel,
        hasModelVersionIds,
        hasModelMetadata: hasBaseModel || hasModelVersionIds,
      };
      result.promptCoverage = {
        status: result.promptDetail.hasPrompt ? "covered" : "not_covered",
        reason: result.promptDetail.hasPrompt ? undefined : "detail_prompt_missing",
        pages: {
          newestPage1: newestPage ? promptCoverage(newestPage) : null,
          cursorPage2: result.cursorPage2 ? result.cursorPage2.promptSummary : null,
          favoritesPage1: favoritesPage ? promptCoverage(favoritesPage) : null,
        },
        detailId: id,
      };
    } catch (error) {
      recordError("civitai", "prompt-bearing-detail", error);
      result.promptCoverage = {
        status: "detail_request_failed",
        pages: {
          newestPage1: newestPage ? promptCoverage(newestPage) : null,
          cursorPage2: result.cursorPage2 ? result.cursorPage2.promptSummary : null,
          favoritesPage1: favoritesPage ? promptCoverage(favoritesPage) : null,
        },
        detailId: id,
      };
    }
  }

  if (candidate) {
    await inspectPromptDetail(candidate.source, candidate.item);
  } else if (newestPage && favoritesPage
    && promptCoverage(newestPage).promptCount === 0
    && promptCoverage(favoritesPage).promptCount === 0) {
    try {
      const fallback = await loadCivitaiGalleryPage(fetchJson, {
        source: "civitai", page: 1, pageSize: 20, sort: "score", timeRange: "all", safeOnly: true,
      });
      result.scoreFallbackPage = {
        page: fallback.page,
        pageSize: fallback.pageSize,
        count: fallback.items.length,
        ids: compactIds(fallback.items),
        ...promptCoverage(fallback),
        requestSort: requests.at(-1)?.requestSort,
        metricRange: requests.at(-1)?.period,
        safeOnly: true,
      };
      const fallbackItem = firstPromptItem(fallback);
      if (fallbackItem) {
        await inspectPromptDetail("score-fallback-page-1", fallbackItem);
      } else {
        result.promptCoverage = {
          status: "not_covered",
          reason: "no_prompt_in_latest_favorites_or_safe_score_page",
          pages: {
            newestPage1: promptCoverage(newestPage),
            cursorPage2: result.cursorPage2 ? result.cursorPage2.promptSummary : null,
            favoritesPage1: promptCoverage(favoritesPage),
            scoreFallbackPage1: promptCoverage(fallback),
          },
        };
      }
    } catch (error) {
      recordError("civitai", "safe-score-fallback-page-1", error);
      result.promptCoverage = {
        status: "fallback_request_failed",
        pages: {
          newestPage1: promptCoverage(newestPage),
          cursorPage2: result.cursorPage2 ? result.cursorPage2.promptSummary : null,
          favoritesPage1: promptCoverage(favoritesPage),
        },
      };
    }
  } else {
    result.promptCoverage = {
      status: "not_covered",
      reason: "latest_or_favorites_page_unavailable",
      pages: {
        newestPage1: newestPage ? promptCoverage(newestPage) : null,
        cursorPage2: result.cursorPage2 ? result.cursorPage2.promptSummary : null,
        favoritesPage1: favoritesPage ? promptCoverage(favoritesPage) : null,
      },
    };
  }
}

async function checkBooru(source) {
  const host = source === "danbooru" ? "danbooru.donmai.us" : "safebooru.donmai.us";
  const request = { source, query: "1girl", sort: "score", timeRange: "day", safeOnly: true };
  const tags = buildBooruQuery(request, new Date());
  const url = new URL(`https://${host}/posts.json`);
  url.searchParams.set("tags", tags);
  url.searchParams.set("limit", "5");
  url.searchParams.set("page", "1");

  const result = {
    requestSort: request.sort,
    requestTimeRange: request.timeRange,
    sortTermIncluded: tags.includes("order:score"),
    ageTermIncluded: /(?:^|\s)age:<1d(?:\s|$)/.test(tags),
    safeRatingIncluded: /(?:^|\s)rating:g(?:\s|$)/.test(tags),
    count: null,
    ids: [],
    httpStatus: null,
  };
  report.booru[source] = result;

  try {
    const response = await publicGet(url.toString(), "application/json");
    result.httpStatus = response.status;
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error("invalid_json_response");
    }
    const posts = Array.isArray(payload) ? payload : Array.isArray(payload && payload.post) ? payload.post : [];
    const ids = posts.map((post) => post && post.id).filter((id) => id !== undefined && id !== null).map(String);
    result.count = ids.length;
    result.ids = ids.slice(0, 5);
  } catch (error) {
    recordError(source, "score-age-json", error);
  }
}

async function checkDanbooruNewestOrder() {
  const request = { source: "danbooru", query: "1girl", sort: "newest", timeRange: "all", safeOnly: true };
  const tags = buildBooruQuery(request, new Date());
  const url = new URL("https://danbooru.donmai.us/posts.json");
  url.searchParams.set("tags", tags);
  url.searchParams.set("limit", "1");
  url.searchParams.set("page", "1");

  const result = {
    requestSort: request.sort,
    limit: 1,
    sortTermIncluded: tags.split(/\s+/).includes("order:id_desc"),
    safeRatingIncluded: tags.split(/\s+/).includes("rating:g"),
    count: null,
    ids: [],
    httpStatus: null,
  };
  report.booru.danbooruNewestOrderIdDesc = result;

  try {
    const response = await publicGet(url.toString(), "application/json");
    result.httpStatus = response.status;
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error("invalid_json_response");
    }
    const posts = Array.isArray(payload) ? payload : Array.isArray(payload && payload.post) ? payload.post : [];
    const ids = posts.map((post) => post && post.id).filter((id) => id !== undefined && id !== null).map(String);
    result.count = ids.length;
    result.ids = ids.slice(0, 1);
  } catch (error) {
    recordError("danbooru", "newest-order-id-desc", error);
  }
}

async function main() {
  if (process.argv.includes("--danbooru-id-desc-only")) {
    try {
      const previous = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      for (const [key, value] of Object.entries(previous)) {
        if (key !== "errors" && key !== "checkedAt") report[key] = value;
      }
      errors.push(...(Array.isArray(previous.errors) ? previous.errors : []));
    } catch (error) {
      recordError("live-check", "load-previous-report", error);
    }
    report.checkedAt = new Date().toISOString();
    await checkDanbooruNewestOrder();
  } else {
    for (const model of ["v4-5", "v5"]) await checkTagsModel(model);
    await checkCivitai();
    for (const source of ["danbooru", "safebooru"]) await checkBooru(source);
    await checkDanbooruNewestOrder();
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const summary = {
    report: path.relative(repoRoot, reportPath).replace(/\\/g, "/"),
    errorCount: errors.length,
    tagsGalleryModels: Object.keys(report.tagsGallery),
    civitaiNewestCount: report.civitai.newestPage1 && report.civitai.newestPage1.count,
    booruCounts: Object.fromEntries(Object.entries(report.booru).map(([source, value]) => [source, value.count])),
  };
  console.log(JSON.stringify(summary));
  if (errors.length) process.exitCode = 1;
}

main().catch((error) => {
  recordError("live-check", "fatal", error);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ report: path.relative(repoRoot, reportPath).replace(/\\/g, "/"), errorCount: errors.length }));
  process.exitCode = 1;
});
