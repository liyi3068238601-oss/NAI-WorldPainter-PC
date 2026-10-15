import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { LocalSrRunResult } from "../../src/local-super-resolution";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({
  app: {
    getPath: () => fixture.root,
    getAppPath: () => path.join(fixture.root, "desktop"),
    isPackaged: false,
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));
vi.mock("./local-media-protocol", () => ({ toLocalMediaUrl: (filePath: string) => `nai-local://${encodeURIComponent(filePath)}` }));

import { createLocalSuperResolutionService } from "./local-super-resolution";

let root = "";
const roots: string[] = [];
const testRoot = path.resolve(process.cwd(), ".tmp", "local-sr-tests");

async function makeRoot() {
  await fs.mkdir(testRoot, { recursive: true });
  const value = await fs.mkdtemp(path.join(testRoot, "case-"));
  roots.push(value);
  return value;
}

async function installFixtureRuntime(runtimeRoot: string) {
  const files = [
    "realesrgan/realesrgan-ncnn-vulkan.exe",
    "realesrgan/models/realesrgan-x4plus-anime.param",
    "realesrgan/models/realesrgan-x4plus-anime.bin",
    "realcugan/realcugan-ncnn-vulkan.exe",
    "realcugan/models-se/up2x-conservative.param",
    "realcugan/models-se/up2x-conservative.bin",
    "realcugan/models-se/up4x-conservative.param",
    "realcugan/models-se/up4x-conservative.bin",
  ];
  for (const relative of files) {
    const target = path.join(runtimeRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "synthetic runtime fixture");
  }
}

async function png(width: number, height: number, filePath: string, background = "#789abc") {
  await sharp({ create: { width, height, channels: 3, background } }).png().toFile(filePath);
}

function service(options: {
  sourcePath: string;
  outputPath: string;
  spawnProcess?: typeof spawn;
  saveDialog?: (dialogOptions: any) => Promise<any>;
}) {
  const runtimeRoot = path.join(root, ".tmp", "sr-runtime");
  return createLocalSuperResolutionService({
    platform: "win32",
    userDataPath: () => root,
    appPath: () => path.join(root, "desktop"),
    execPath: () => path.join(root, "app.exe"),
    isPackaged: () => false,
    openDialog: vi.fn(async (dialogOptions: any) => ({
      canceled: false,
      filePaths: [dialogOptions.properties.includes("openDirectory") ? runtimeRoot : options.sourcePath],
    })) as any,
    saveDialog: options.saveDialog ?? vi.fn(async () => ({ canceled: false, filePath: options.outputPath })) as any,
    spawnProcess: options.spawnProcess,
  });
}

beforeEach(async () => {
  root = await makeRoot();
  fixture.root = root;
  await installFixtureRuntime(path.join(root, ".tmp", "sr-runtime"));
});

afterEach(async () => {
  const cleanup = roots.splice(0);
  for (const item of cleanup) {
    const resolved = path.resolve(item);
    if (!resolved.startsWith(`${testRoot}${path.sep}`)) throw new Error(`Refusing to remove test path outside ${testRoot}`);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

describe("local super-resolution service", () => {
  it("discovers only valid installed models and persists an explicitly chosen runtime path", async () => {
    const sr = service({ sourcePath: "", outputPath: "" });
    expect(await sr.getStatus()).toMatchObject({
      available: true,
      configuredByUser: false,
      models: ["realesrganAnime4x", "realcuganConservative2x", "realcuganConservative4x"],
    });

    const selectedRoot = path.join(root, "custom-runtime");
    await installFixtureRuntime(selectedRoot);
    const chosen = createLocalSuperResolutionService({
      platform: "win32",
      userDataPath: () => root,
      appPath: () => path.join(root, "elsewhere"),
      execPath: () => path.join(root, "app.exe"),
      isPackaged: () => false,
      openDialog: vi.fn(async () => ({ canceled: false, filePaths: [selectedRoot] })) as any,
    });
    expect((await chosen.chooseRuntimeDirectory())?.runtimeRoot).toBe(selectedRoot);
    expect(JSON.parse(await fs.readFile(path.join(root, "local-super-resolution.v1.json"), "utf8")).runtimeRoot).toBe(selectedRoot);
    expect(await chosen.getStatus()).toMatchObject({ configuredByUser: true, runtimeRoot: selectedRoot, available: true });
  });

  it("validates and previews a selected source without exposing its path in the selection", async () => {
    const sourcePath = path.join(root, "source.png");
    await png(800, 600, sourcePath);
    const sr = service({ sourcePath, outputPath: path.join(root, "result.png") });
    const selected = await sr.pickSource();
    expect(selected).toMatchObject({ fileName: "source.png", width: 800, height: 600 });
    expect(selected?.previewUrl).toContain("nai-local://");
    expect(selected).not.toHaveProperty("filePath");
  });

  it("runs the local CLI with a scrubbed environment and saves a size-verified PNG", async () => {
    const sourcePath = path.join(root, "source.png");
    const fixtureOutput = path.join(root, "engine-result.png");
    const outputPath = path.join(root, "saved.png");
    await png(8, 6, sourcePath);
    await png(16, 12, fixtureOutput);
    const commands: Array<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const fakeSpawn = ((executable: string, args: readonly string[], options: any) => {
      commands.push({ executable, args, env: options.env });
      const output = String(args[args.indexOf("-o") + 1]);
      const script = "const fs=require('node:fs');fs.copyFileSync(process.env.LOCAL_SR_FIXTURE_OUTPUT,process.argv[1]);console.log('render 37%');console.error('render 100%');";
      return spawn(process.execPath, ["-e", script, output], {
        ...options,
        env: { ...process.env, ...options.env, LOCAL_SR_FIXTURE_OUTPUT: fixtureOutput },
      });
    }) as typeof spawn;
    const sr = service({ sourcePath, outputPath, spawnProcess: fakeSpawn });
    const selected = await sr.pickSource();
    expect(selected).toBeTruthy();
    const progress: number[] = [];
    const result: LocalSrRunResult = await sr.run({ selectionId: selected!.selectionId, modelId: "realcuganConservative2x", confirmed: true }, (event) => progress.push(event.percent));
    expect(result).toMatchObject({ ok: true, fileName: "saved.png", width: 16, height: 12 });
    if (!result.ok) throw new Error(result.message);
    expect(await fs.readFile(result.outputPath)).toEqual(await fs.readFile(fixtureOutput));
    expect(commands[0]?.executable).toContain("realcugan-ncnn-vulkan.exe");
    expect(commands[0]?.args).toContain("-1");
    expect(commands[0]?.args).toContain("2");
    expect(commands[0]?.env).not.toHaveProperty("PATH");
    expect(progress).toContain(37);
    expect(progress).toContain(100);
    expect((await fs.readdir(path.join(root, "local-super-resolution", "jobs"))).length).toBe(0);
  });

  it("locks preparation, and cancellation while the save dialog is open never starts the CLI", async () => {
    const sourcePath = path.join(root, "source.png");
    await png(8, 6, sourcePath);
    let markDialogStarted!: () => void;
    let resolveDialog!: (value: { canceled: boolean; filePath: string }) => void;
    const dialogStarted = new Promise<void>((resolve) => { markDialogStarted = resolve; });
    const dialogResult = new Promise<{ canceled: boolean; filePath: string }>((resolve) => { resolveDialog = resolve; });
    const saveDialog = vi.fn(async () => { markDialogStarted(); return dialogResult; });
    const spawnProcess = vi.fn(() => { throw new Error("CLI must not launch after preparation cancellation"); }) as unknown as typeof spawn;
    const sr = service({ sourcePath, outputPath: path.join(root, "never.png"), saveDialog, spawnProcess });
    const selected = await sr.pickSource();
    const running = sr.run({ selectionId: selected!.selectionId, modelId: "realcuganConservative2x", confirmed: true });
    await dialogStarted;

    const concurrent = await sr.run({ selectionId: selected!.selectionId, modelId: "realcuganConservative2x", confirmed: true });
    expect(concurrent).toMatchObject({ ok: false, message: "本地超分任务正在运行。" });
    sr.cancel();
    resolveDialog({ canceled: false, filePath: path.join(root, "never.png") });

    expect(await running).toMatchObject({ ok: false, cancelled: true });
    expect(spawnProcess).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "never.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects same-size, same-dimension source content changes using the selection hash", async () => {
    const sourcePath = path.join(root, "source.png");
    const changedPath = path.join(root, "changed.png");
    await png(8, 6, sourcePath, "#789abc");
    const original = await fs.readFile(sourcePath);
    await png(8, 6, changedPath, "#cba987");
    const changed = await fs.readFile(changedPath);
    expect(changed.length).toBe(original.length);
    expect(changed.equals(original)).toBe(false);

    const saveDialog = vi.fn(async () => ({ canceled: false, filePath: path.join(root, "never.png") }));
    const spawnProcess = vi.fn(() => { throw new Error("Changed source must not launch the CLI"); }) as unknown as typeof spawn;
    const sr = service({ sourcePath, outputPath: path.join(root, "never.png"), saveDialog, spawnProcess });
    const frozenSelection = await sr.pickSource();
    await fs.writeFile(sourcePath, changed);
    expect((await fs.stat(sourcePath)).size).toBe(original.length);
    const result = await sr.run({ selectionId: frozenSelection!.selectionId, modelId: "realcuganConservative2x", confirmed: true });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("源图片在选择后发生变化");
    expect(saveDialog).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rechecks the frozen hash after the save dialog before spawning", async () => {
    const sourcePath = path.join(root, "source.png");
    const changedPath = path.join(root, "changed.png");
    await png(8, 6, sourcePath, "#789abc");
    await png(8, 6, changedPath, "#cba987");
    const selectedBytes = await fs.readFile(sourcePath);
    const changedBytes = await fs.readFile(changedPath);
    expect(changedBytes.length).toBe(selectedBytes.length);
    const saveDialog = vi.fn(async () => {
      await fs.writeFile(sourcePath, changedBytes);
      return { canceled: false, filePath: path.join(root, "never.png") };
    });
    const spawnProcess = vi.fn(() => { throw new Error("Changed staged source must not launch the CLI"); }) as unknown as typeof spawn;
    const sr = service({ sourcePath, outputPath: path.join(root, "never.png"), saveDialog, spawnProcess });
    const selected = await sr.pickSource();
    const result = await sr.run({ selectionId: selected!.selectionId, modelId: "realcuganConservative2x", confirmed: true });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("源图片在选择后发生变化");
    expect(saveDialog).toHaveBeenCalledOnce();
    expect(spawnProcess).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "never.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a target that resolves to the source image and preserves the original bytes", async () => {
    const sourcePath = path.join(root, "source.png");
    await png(8, 6, sourcePath);
    const original = await fs.readFile(sourcePath);
    const spawnProcess = vi.fn(() => { throw new Error("The source image must never be overwritten"); }) as unknown as typeof spawn;
    // Model Windows' case-insensitive file aliases even when Vitest runs on a case-sensitive host.
    const sr = service({ sourcePath, outputPath: path.join(root, "SOURCE.PNG"), spawnProcess });
    const selected = await sr.pickSource();
    const result = await sr.run({ selectionId: selected!.selectionId, modelId: "realcuganConservative2x", confirmed: true });
    expect(result).toMatchObject({ ok: false, message: "不能将结果保存到原图路径；请选择其他文件名。" });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(await fs.readFile(sourcePath)).toEqual(original);
  });

  it("requires explicit confirmation and blocks outputs over 32 MP before opening the save dialog", async () => {
    const sourcePath = path.join(root, "large.png");
    await png(3000, 3000, sourcePath);
    const saveDialog = vi.fn(async () => ({ canceled: false, filePath: path.join(root, "never.png") }));
    const sr = createLocalSuperResolutionService({
      platform: "win32",
      userDataPath: () => root,
      appPath: () => path.join(root, "desktop"),
      isPackaged: () => false,
      openDialog: vi.fn(async () => ({ canceled: false, filePaths: [sourcePath] })) as any,
      saveDialog: saveDialog as any,
    });
    const selected = await sr.pickSource();
    const missingConfirmation = await sr.run({ selectionId: selected!.selectionId, modelId: "realcuganConservative2x", confirmed: false });
    expect(missingConfirmation).toMatchObject({ ok: false });
    expect(saveDialog).not.toHaveBeenCalled();
    const oversized = await sr.run({ selectionId: selected!.selectionId, modelId: "realesrganAnime4x", confirmed: true });
    expect(oversized).toMatchObject({ ok: false });
    if (!oversized.ok) expect(oversized.message).toContain("32MP");
    expect(saveDialog).not.toHaveBeenCalled();
  });

  it("cancels a running local process without writing the chosen output", async () => {
    const sourcePath = path.join(root, "source.png");
    await png(8, 6, sourcePath);
    const outputPath = path.join(root, "cancelled.png");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fakeSpawn = ((_executable: string, _args: readonly string[], options: any) => {
      markStarted();
      return spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
        ...options,
        env: process.env,
      });
    }) as typeof spawn;
    const sr = service({ sourcePath, outputPath, spawnProcess: fakeSpawn });
    const selected = await sr.pickSource();
    const running = sr.run({ selectionId: selected!.selectionId, modelId: "realcuganConservative2x", confirmed: true });
    await started;
    sr.cancel();
    expect(await running).toMatchObject({ ok: false, cancelled: true });
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.env.WORLDPAINTER_LOCAL_SR_REAL_TEST !== "1")("runs the installed Real-CUGAN CLI on a synthetic PNG and preserves evidence under .tmp", async () => {
    const evidenceRoot = path.resolve(process.cwd(), ".tmp", "local-sr-runtime-verification");
    await fs.mkdir(evidenceRoot, { recursive: true });
    const evidence = await fs.mkdtemp(path.join(evidenceRoot, "run-"));
    const sourcePath = path.join(evidence, "synthetic-source.png");
    const outputPath = path.join(evidence, "synthetic-upscaled.png");
    await png(64, 64, sourcePath, "#7654ab");

    let stdout = "";
    let stderr = "";
    const spawnProcess = ((executable: string, args: readonly string[], options: any) => {
      const child = spawn(executable, args, options);
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      return child;
    }) as typeof spawn;
    const runtimeRoot = path.resolve(process.cwd(), "..", ".tmp", "sr-runtime");
    const sr = createLocalSuperResolutionService({
      platform: "win32",
      userDataPath: () => evidence,
      appPath: () => process.cwd(),
      execPath: () => process.execPath,
      isPackaged: () => false,
      openDialog: vi.fn(async () => ({ canceled: false, filePaths: [sourcePath] })) as any,
      saveDialog: vi.fn(async () => ({ canceled: false, filePath: outputPath })) as any,
      spawnProcess,
    });
    const status = await sr.getStatus();
    expect(status.runtimeRoot).toBe(runtimeRoot);
    expect(status.models).toContain("realcuganConservative2x");
    const selected = await sr.pickSource();
    expect(selected).toMatchObject({ fileName: "synthetic-source.png", width: 64, height: 64 });
    const progress: LocalSrProgress[] = [];
    const result = await sr.run({ selectionId: selected!.selectionId, modelId: "realcuganConservative2x", confirmed: true }, (event) => progress.push(event));
    if (!result.ok) throw new Error(`Real-CUGAN runtime failed: ${result.message}\n${stderr}`);
    const metadata = await sharp(result.outputPath).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 128, height: 128 });
    expect((await fs.stat(result.outputPath)).size).toBeGreaterThan(45);

    await fs.writeFile(path.join(evidence, "stdout.log"), stdout, "utf8");
    await fs.writeFile(path.join(evidence, "stderr.log"), stderr, "utf8");
    const sourceBytes = await fs.readFile(sourcePath);
    const outputBytes = await fs.readFile(result.outputPath);
    await fs.writeFile(path.join(evidence, "verification.json"), `${JSON.stringify({
      verifiedAt: new Date().toISOString(), runtimeRoot,
      executable: path.join(runtimeRoot, "realcugan", "realcugan-ncnn-vulkan.exe"), modelId: result.modelId,
      source: { fileName: path.basename(sourcePath), width: 64, height: 64, bytes: sourceBytes.length, sha256: createHash("sha256").update(sourceBytes).digest("hex") },
      output: { fileName: path.basename(result.outputPath), width: metadata.width, height: metadata.height, bytes: outputBytes.length, sha256: createHash("sha256").update(outputBytes).digest("hex") },
      progress, stdoutLog: "stdout.log", stderrLog: "stderr.log", networkUsed: false,
    }, null, 2)}\n`, "utf8");
  });
});
