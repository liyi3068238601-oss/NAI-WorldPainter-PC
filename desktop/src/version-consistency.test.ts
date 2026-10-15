import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORLDPAINTER_DATA_DIRECTORY,
  WORLDPAINTER_STORE_FILE,
  WORLDPAINTER_UPDATE_MESSAGE,
  WORLDPAINTER_UPDATES_ENABLED,
} from "../shared/worldpainter-product";
import { APP_VERSION } from "./types";

const root = process.cwd();
const productRepo = "https://github.com/liyi3068238601-oss/NAI-WorldPainter-PC";
const upstreamRepo = "https://github.com/2786886095/novelai-image-desktop";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("release version consistency", () => {
  it("keeps the desktop version current and the upstream mobile fixture version pinned", () => {
    const packageVersion = JSON.parse(read("package.json")).version as string;
    const upstreamVersion = JSON.parse(read("shared/upstream-reference-version.json")).version as string;
    const fixtureVersionPattern = upstreamVersion.split(".").join("[.]");
    const mobileModel = read("mobile/lib/models/nai_models.dart");
    const mobilePubspec = read("mobile/pubspec.yaml");
    const mcpClient = read("electron/ipc/mcp-client.ts");

    expect(APP_VERSION).toBe(packageVersion);
    expect(mobileModel).toContain(`const appVersion = '${upstreamVersion}';`);
    expect(mobilePubspec).toMatch(
      new RegExp(`^version:\\s+${fixtureVersionPattern}\\+\\d+$`, "m"),
    );
    expect(mcpClient).toContain("version: APP_VERSION");
  });

  it("derives the desktop display version instead of hard-coding it", () => {
    const desktopVersionSource = read("src/types.ts");

    expect(desktopVersionSource).toContain(
      'import { version as packageVersion } from "../package.json";',
    );
    expect(desktopVersionSource).toContain(
      "export const APP_VERSION = packageVersion;",
    );
  });

  it("labels every desktop README as a preview of this fork", () => {
    const previewMarkers: Record<string, string> = {
      "README.md": "迁移预览",
      "README.zh-TW.md": "遷移預覽",
      "README.en.md": "migration preview",
      "README.ja.md": "移行プレビュー",
      "README.ko.md": "마이그레이션 프리뷰",
    };
    const releaseStatus: Record<string, string> = {
      "README.md": "没有公开安装包或正式发行链接",
      "README.zh-TW.md": "沒有公開安裝程式或正式發行連結",
      "README.en.md": "No public installer or formal release is available",
      "README.ja.md": "公開インストーラーや正式な配布リンクはありません",
      "README.ko.md": "공개 설치 파일이나 정식 배포 링크가 없습니다",
    };
    const disabledUpdates: Record<string, string> = {
      "README.md": "自动更新未启用",
      "README.zh-TW.md": "自動更新尚未啟用",
      "README.en.md": "Automatic updates are disabled",
      "README.ja.md": "自動更新は無効です",
      "README.ko.md": "자동 업데이트는 비활성화되어 있습니다",
    };

    for (const [file, marker] of Object.entries(previewMarkers)) {
      const readme = read(file);
      expect(readme, file).toContain(marker);
      expect(readme, file).toContain("../README.md");
      expect(readme, file).toContain(productRepo);
      expect(readme, file).toContain(WORLDPAINTER_DATA_DIRECTORY);
      expect(readme, file).toContain("Langbai");
      expect(readme, file).toContain("MIT");
      expect(readme, file).toContain(releaseStatus[file]);
      expect(readme, file).toContain(disabledUpdates[file]);
      expect(readme, file).toContain(`${upstreamRepo})`);
      expect(readme, file).not.toMatch(/2786886095\/novelai-image-desktop\/(?:releases|actions)(?:\/|\b)/i);
    }
  });

  it("keeps current release notes separate from archived upstream history", () => {
    const releaseNotes = read("docs/RELEASE_NOTES.md");
    const upstreamHistory = read("docs/upstream-reference/RELEASE_NOTES.md");
    const upstreamNote = read("docs/upstream-reference/README.md");

    expect(WORLDPAINTER_UPDATES_ENABLED).toBe(false);
    expect(releaseNotes).toContain(WORLDPAINTER_UPDATE_MESSAGE);
    expect(releaseNotes).toContain(WORLDPAINTER_DATA_DIRECTORY);
    expect(releaseNotes).toContain(WORLDPAINTER_STORE_FILE);
    expect(releaseNotes).toContain(productRepo);
    expect(releaseNotes).not.toMatch(/2786886095\/novelai-image-desktop\/(?:releases|actions)(?:\/|\b)/i);
    expect(releaseNotes).not.toMatch(/GitHub Latest|Windows 安装版|macOS universal|Linux AppImage|Android APK|iOS IPA/i);

    expect(upstreamNote).toContain("不是当前产品文档、发行页或下载入口");
    expect(upstreamNote).toContain("不适用于绘世 PC");
    expect(upstreamNote).toContain(upstreamRepo);
    expect(upstreamHistory).toContain(`${upstreamRepo}/releases/latest`);
    expect(upstreamHistory.slice(0, 500)).toMatch(/上游发行记录.*不适用于本项目/);
  });
});
