import { describe, expect, it } from "vitest";
import {
  appendPhoneArtistImports,
  appendPhoneStyleImports,
  classifyPhoneArtistConflict,
  classifyPhoneStyleConflict,
  matchPhoneAssetFilename,
  parsePhoneArtistPromptsJson,
  parsePhoneStylePresetsJson,
} from "./worldpainter-material-import";

describe("WorldPainter mobile prompt-library import", () => {
  it("matches preview images only by the exact selected basename", () => {
    expect(matchPhoneAssetFilename("style_001.jpg", ["style_001.jpg", "extra.png"]))
      .toEqual({ status: "matched", filename: "style_001.jpg" });
    expect(matchPhoneAssetFilename("style_001.jpg", ["other_style_001.jpg"]))
      .toEqual({ status: "missing" });
    expect(matchPhoneAssetFilename("style_001.jpg", ["style_001.jpg", "STYLE_001.JPG"]))
      .toEqual({ status: "ambiguous", filenames: ["style_001.jpg", "STYLE_001.JPG"] });
    expect(matchPhoneAssetFilename(null, ["style_001.jpg"]))
      .toEqual({ status: "no-reference" });
  });

  it("parses style JSON and rejects unsafe preview references without losing prompt text", () => {
    const result = parsePhoneStylePresetsJson(JSON.stringify([
      { title: "Clean", prompt: "artist:sample", assetImage: "assets/style_001.jpg" },
      { title: "Unsafe", prompt: "artist:other", assetImage: "../../outside.png" },
      { title: "Clean", prompt: "artist:sample", assetImage: "assets/style_001.jpg" },
      { title: "Missing prompt", prompt: "  " },
    ]));

    expect(result.sourceRows).toBe(4);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ name: "Clean", assetImage: "style_001.jpg" });
    expect(result.items[1]).toMatchObject({ name: "Unsafe", assetImage: null });
    expect(result.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "assetImage must not be absolute or traverse parent folders.",
      "Duplicate style row skipped.",
      "Skipped: each style needs a non-empty title/name and prompt.",
    ]));
    expect(() => parsePhoneStylePresetsJson("{" )).toThrow(/JSON is invalid/);
  });

  it("parses artist categories, timestamps and optional images with safe defaults", () => {
    const result = parsePhoneArtistPromptsJson(JSON.stringify({
      version: 12,
      artists: [
        {
          name: "artist one",
          tag: "artist_one",
          categories: ["未分类", " 未分类 ", "画师"],
          danbooruCount: 24,
          createdAt: 1769965631124,
          assetImage: "assets/artist_001.jpg",
        },
        {
          name: "artist two",
          tag: "artist_two",
          categories: "invalid",
          danbooruCount: -1,
          createdAt: Number.MAX_VALUE,
          assetImage: "C:\\secret\\private.jpg",
        },
        { name: "missing tag" },
      ],
    }));

    expect(result.sourceRows).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      name: "artist one",
      categories: ["未分类", "画师"],
      danbooruCount: 24,
      assetImage: "artist_001.jpg",
    });
    expect(result.items[0].createdAt).toBe(new Date(1769965631124).toISOString());
    expect(result.items[1]).toMatchObject({
      danbooruCount: 0,
      createdAt: new Date(0).toISOString(),
      assetImage: null,
    });
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("distinguishes exact duplicates from same-name/tag conflicts", () => {
    const styles = parsePhoneStylePresetsJson(JSON.stringify([
      { title: "Same", prompt: "artist:a" },
      { title: "Same", prompt: "artist:b" },
    ])).items;
    expect(classifyPhoneStyleConflict(styles[0], [{ name: "Same", prompt: "artist:a" }]))
      .toBe("exact-duplicate");
    expect(classifyPhoneStyleConflict(styles[1], [{ name: "Same", prompt: "artist:a" }]))
      .toBe("name-or-tag-conflict");
    expect(classifyPhoneStyleConflict(styles[1], [])).toBe("none");

    const artists = parsePhoneArtistPromptsJson(JSON.stringify({ artists: [
      { name: "A", tag: "a_tag", categories: ["style"], danbooruCount: 4 },
      { name: "A", tag: "A_TAG", categories: ["other"], danbooruCount: 5 },
    ] })).items;
    expect(classifyPhoneArtistConflict(artists[0], [artists[0]])).toBe("exact-duplicate");
    expect(classifyPhoneArtistConflict(artists[1], [artists[0]])).toBe("name-or-tag-conflict");
  });

  it("appends idempotently and preserves existing user material", () => {
    const style = parsePhoneStylePresetsJson(JSON.stringify([
      { title: "Imported", prompt: "artist:one" },
    ])).items[0];
    const existingStyle: { id: string; name: string; prompt: string; note?: string } = {
      id: "user-style", name: "My style", prompt: "user prompt", note: "keep",
    };
    const withStyle = appendPhoneStyleImports([existingStyle], [style, style]);
    expect(withStyle).toHaveLength(2);
    expect(withStyle[0]).toEqual(existingStyle);
    expect(appendPhoneStyleImports(withStyle, [style])).toEqual(withStyle);

    const artist = parsePhoneArtistPromptsJson(JSON.stringify({ artists: [
      { name: "Artist", tag: "artist", categories: [], danbooruCount: 0 },
    ] })).items[0];
    const existingArtist: {
      id: string;
      name: string;
      tag: string;
      categories: string[];
      danbooruCount: number;
      note?: string;
    } = {
      id: "user-artist",
      name: "Personal Artist",
      tag: "custom_tag",
      categories: ["mine"],
      danbooruCount: 1,
      note: "keep",
    };
    const withArtist = appendPhoneArtistImports([existingArtist], [artist, artist]);
    expect(withArtist).toHaveLength(2);
    expect(withArtist[0]).toEqual(existingArtist);
    expect(appendPhoneArtistImports(withArtist, [artist])).toEqual(withArtist);
  });
});
