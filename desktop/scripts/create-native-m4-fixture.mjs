import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".tmp", "native-m4-fixtures");
if (!fs.existsSync(path.join(root, "package.json"))) throw new Error("Run this generator from its checked-in project location.");
if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing fixture directory: ${target}`);

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const imageSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#a7d8ee"/><stop offset="1" stop-color="#fff1c8"/></linearGradient></defs>
  <rect width="256" height="256" rx="28" fill="url(#sky)"/>
  <circle cx="190" cy="63" r="28" fill="#f5c66b"/>
  <path d="M0 182 66 99l60 83 47-61 83 82v53H0Z" fill="#668e83"/>
  <path d="M0 207 76 151l57 56 55-54 68 60v43H0Z" fill="#315b58"/>
  <path d="M73 193 128 161l54 32v63H73Z" fill="#e9d5ab"/>
  <path d="M96 197v-28l16-18 16 18 16-18 16 18v28" fill="#52647c"/>
  <circle cx="111" cy="181" r="3" fill="#f8e9c9"/><circle cx="145" cy="181" r="3" fill="#f8e9c9"/>
  <path d="M121 191q7 7 14 0" fill="none" stroke="#f8e9c9" stroke-width="3" stroke-linecap="round"/>
  <path d="M106 188 84 183m23 13-22 5m65-13 22-5m-23 13 22 5" stroke="#f8e9c9" stroke-width="2" stroke-linecap="round"/>
</svg>`);
const imageBytes = await sharp(imageSvg).png().toBuffer();
const imageSha = digest(imageBytes);
const imageRef = `sha256/${imageSha.slice(0, 2)}/${imageSha}.png`;
const sourceImage = path.join(target, "image_assets", "sha256", imageSha.slice(0, 2), `${imageSha}.png`);
const databaseFile = path.join(target, "workspace.sqlite");

fs.mkdirSync(path.dirname(sourceImage), { recursive: true });
fs.writeFileSync(sourceImage, imageBytes, { flag: "wx" });
const db = new DatabaseSync(databaseFile);
try {
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE draft (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE gallery (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE workspace (id INTEGER PRIMARY KEY, extra_json TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO meta (id, revision) VALUES (1, 1)").run();
  db.prepare("INSERT INTO draft (id, payload) VALUES (1, ?)").run(JSON.stringify({
    prompt: "storybook illustration, a small cat in a mountain cabin, warm morning light",
    negative: "text, watermark, blurry",
    model: "nai-diffusion-4-5-full", provider: "novelai", width: 832, height: 1216,
    steps: 28, cfg: 5.5, seedText: "4242", batchCount: 1,
    generation: { operation: "txt2img", sampler: "k_euler_ancestral", noiseSchedule: "karras", seed: 4242 },
  }));
  db.prepare("INSERT INTO gallery (id, ordinal, payload) VALUES ('gallery-synthetic-1', 0, ?)").run(JSON.stringify({
    id: "gallery-synthetic-1", title: "Synthetic gallery sample", prompt: "storybook cat in a mountain cabin",
    negative: "text, watermark", width: 832, height: 1216, seed: 4242, variant: 0, favorite: true,
    isDemo: false, model: "nai-diffusion-4-5-full", provider: "novelai", steps: 28, cfg: 5.5,
    assetRef: imageRef, createdAt: "2026-10-15T08:00:00.000Z",
    parameters: { model: "nai-diffusion-4-5-full", prompt: "storybook cat in a mountain cabin", steps: 28, seed: 4242 },
  }));
  db.prepare("INSERT INTO workspace (id, extra_json) VALUES (1, ?)").run(JSON.stringify({
    preferences: { darkTheme: true, reduceMotion: false },
    editor: { zoom: 1, selectedTool: "brush" }, selectedId: "gallery-synthetic-1", demoSequence: 0,
    promptLibrary: {
      schema: 1, groups: ["Synthetic Imports"],
      styles: [{ id: "style-synthetic-1", name: "Storybook Ink", prompt: "soft storybook ink, warm paper texture", negative: "photo", category: "Synthetic Imports", preview_asset_ref: imageRef, created_at: "2026-10-15T08:00:00.000Z" }],
      artists: [{ id: "artist-synthetic-1", name: "Example Artist", prompt: "artist:synthetic_example", categories: ["storybook", "ink"], default_weight: 0.8, use_count: 2, danbooru_count: 0, created_at: "2026-10-15T08:00:00.000Z" }],
    },
    assistant: {
      activeSessionId: "session-synthetic-1",
      memories: { schema: 1, entries: [
        { id: "memory-approved-synthetic-1", trigger: "warm cabin", content: "Use gentle amber light and visible wood grain.", kind: "style", source: "userInstruction", hitCount: 1, createdAt: "2026-10-15T08:00:00.000Z", updatedAt: "2026-10-15T08:00:00.000Z" },
        { id: "memory-pending-synthetic-1", trigger: "small blue scarf", content: "The cat may wear a small blue scarf.", kind: "other", source: "pendingLlmCandidate", hitCount: 0, createdAt: "2026-10-15T08:00:00.000Z", updatedAt: "2026-10-15T08:00:00.000Z" },
      ] },
      sessions: [{ id: "session-synthetic-1", title: "Synthetic cabin illustration", input: "", attachments: [imageRef], turns: [{
        id: "turn-synthetic-1", userText: "Describe a cozy storybook cabin scene.", attachments: [], status: "complete",
        messages: [{ role: "assistant", content: "A small cat sits by a sunlit cabin window, with layered green mountains outside." }],
      }] }],
    },
    vibeLibrary: { schema: 1, entries: [], cache: [] },
  }));
} finally {
  db.close();
}

const databaseBytes = fs.readFileSync(databaseFile);
const manifest = {
  syntheticFixture: true,
  generatedAt: new Date().toISOString(),
  schemaVersion: 1,
  workspaceFile: "workspace.sqlite",
  workspaceSha256: digest(databaseBytes),
  workspaceBytes: databaseBytes.length,
  imageFile: path.relative(target, sourceImage).replaceAll(path.sep, "/"),
  imageRef,
  imageSha256: imageSha,
  imageBytes: imageBytes.length,
  counts: { draft: 1, gallery: 1, styles: 1, artists: 1, approvedMemories: 1, pendingMemories: 1, sessions: 1 },
  credentials: "none; fixture contains only synthetic prompt and sample text",
};
fs.writeFileSync(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ directory: target, ...manifest }, null, 2));
