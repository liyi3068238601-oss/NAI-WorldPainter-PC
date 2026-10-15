import { app, dialog } from "electron";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  LOCAL_SR_MAX_INPUT_BYTES,
  LOCAL_SR_MAX_OUTPUT_BYTES,
  getLocalSrModel,
  planLocalSuperResolution,
  type LocalSrModelId,
  type LocalSrProgress,
  type LocalSrRunResult,
  type LocalSrRuntimeStatus,
  type LocalSrSourceSelection,
} from "../../src/local-super-resolution";
import { toLocalMediaUrl } from "./local-media-protocol";

const CONFIG_FILE = "local-super-resolution.v1.json";
const RUNTIME_TIMEOUT_MS = 20 * 60 * 1000;

interface RuntimeProbe {
  root: string;
  models: LocalSrModelId[];
  commands: Partial<Record<LocalSrModelId, { executable: string; modelDirectory: string; workingDirectory: string }>>;
}

interface LocalSrServiceDependencies {
  platform?: string;
  userDataPath?: () => string;
  appPath?: () => string;
  execPath?: () => string;
  isPackaged?: () => boolean;
  openDialog?: typeof dialog.showOpenDialog;
  saveDialog?: typeof dialog.showSaveDialog;
  spawnProcess?: typeof spawn;
}

function modelRuntime(root: string, modelId: LocalSrModelId): { executable: string; modelDirectory: string; workingDirectory: string } {
  if (modelId === "realesrganAnime4x") {
    const workingDirectory = path.join(root, "realesrgan");
    return {
      executable: path.join(workingDirectory, "realesrgan-ncnn-vulkan.exe"),
      modelDirectory: path.join(workingDirectory, "models"),
      workingDirectory,
    };
  }
  const workingDirectory = path.join(root, "realcugan");
  return {
    executable: path.join(workingDirectory, "realcugan-ncnn-vulkan.exe"),
    modelDirectory: path.join(workingDirectory, "models-se"),
    workingDirectory,
  };
}

async function isFile(filePath: string) {
  try { return (await fs.stat(filePath)).isFile(); } catch { return false; }
}

export async function probeLocalSrRuntime(runtimeRoot: string): Promise<RuntimeProbe> {
  const root = path.resolve(runtimeRoot);
  const models: LocalSrModelId[] = [];
  const commands: RuntimeProbe["commands"] = {};
  for (const modelId of ["realesrganAnime4x", "realcuganConservative2x", "realcuganConservative4x"] as const) {
    const runtime = modelRuntime(root, modelId);
    const modelName = modelId === "realesrganAnime4x"
      ? "realesrgan-x4plus-anime"
      : modelId === "realcuganConservative2x" ? "up2x-conservative" : "up4x-conservative";
    if (await isFile(runtime.executable)
      && await isFile(path.join(runtime.modelDirectory, `${modelName}.param`))
      && await isFile(path.join(runtime.modelDirectory, `${modelName}.bin`))) {
      models.push(modelId);
      commands[modelId] = runtime;
    }
  }
  return { root, models, commands };
}

function percentFromText(text: string): number | null {
  const matches = [...text.matchAll(/(?<!\d)(\d{1,3})(?:\.\d+)?\s*%/g)];
  const value = matches.length ? Number(matches[matches.length - 1][1]) : NaN;
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function outputDestination(pathFromDialog: string) {
  const resolved = path.resolve(pathFromDialog);
  const extension = path.extname(resolved).toLocaleLowerCase();
  if (extension && extension !== ".png") return null;
  return extension === ".png" ? resolved : `${resolved}.png`;
}

async function sha256File(filePath: string, maxBytes = LOCAL_SR_MAX_INPUT_BYTES): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    let bytes = 0;
    stream.on("data", (chunk: Buffer | string) => {
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        stream.destroy(new Error("源图片超过 64 MB 本地处理上限。"));
        return;
      }
      hash.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function sameFilePath(sourcePath: string, targetPath: string, platform: string): Promise<boolean> {
  const pathKey = (filePath: string) => {
    const normalized = path.normalize(path.resolve(filePath));
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (pathKey(sourcePath) === pathKey(targetPath)) return true;

  const [sourceStat, targetStat] = await Promise.all([
    fs.stat(sourcePath).catch(() => null), fs.stat(targetPath).catch(() => null),
  ]);
  if (sourceStat && targetStat && sourceStat.dev === targetStat.dev
    && sourceStat.ino !== 0 && sourceStat.ino === targetStat.ino) return true;

  const sourceRealPath = await fs.realpath(sourcePath).catch(() => null);
  if (!sourceRealPath) return false;
  const [targetRealPath, targetParentRealPath] = await Promise.all([
    fs.realpath(targetPath).catch(() => null),
    fs.realpath(path.dirname(targetPath)).catch(() => null),
  ]);
  if (targetRealPath && pathKey(sourceRealPath) === pathKey(targetRealPath)) return true;
  return !!targetParentRealPath
    && pathKey(sourceRealPath) === pathKey(path.join(targetParentRealPath, path.basename(targetPath)));
}

function uniqueStrings<T extends string>(values: T[]) {
  return [...new Set(values)];
}

export function createLocalSuperResolutionService(deps: LocalSrServiceDependencies = {}) {
  const platform = deps.platform ?? process.platform;
  const userDataPath = deps.userDataPath ?? (() => app.getPath("userData"));
  const appPath = deps.appPath ?? (() => app.getAppPath());
  const execPath = deps.execPath ?? (() => process.execPath);
  const isPackaged = deps.isPackaged ?? (() => app.isPackaged);
  const openDialog = deps.openDialog ?? dialog.showOpenDialog.bind(dialog);
  const saveDialog = deps.saveDialog ?? dialog.showSaveDialog.bind(dialog);
  const spawnProcess = deps.spawnProcess ?? spawn;
  const selections = new Map<string, { filePath: string; fileName: string; width: number; height: number; bytes: number; sha256: string }>();
  let active: { controller: AbortController; child?: ReturnType<typeof spawn> } | null = null;

  const configPath = () => path.join(userDataPath(), CONFIG_FILE);

  async function readConfiguredRuntime() {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath(), "utf8")) as { runtimeRoot?: unknown };
      return typeof parsed.runtimeRoot === "string" && parsed.runtimeRoot.trim()
        ? path.resolve(parsed.runtimeRoot)
        : null;
    } catch { return null; }
  }

  async function writeConfiguredRuntime(runtimeRoot: string) {
    const filePath = configPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, runtimeRoot })}\n`, { flag: "wx" });
    try { await fs.rename(temporary, filePath); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }

  function discoveredRuntimeRoots() {
    const packaged = path.join(path.dirname(execPath()), "data", "sr");
    if (isPackaged()) return [packaged];
    return uniqueStrings([
      path.resolve(appPath(), "..", ".tmp", "sr-runtime"),
      packaged,
    ]);
  }

  async function getStatus(): Promise<LocalSrRuntimeStatus> {
    if (platform !== "win32") {
      return { available: false, runtimeRoot: null, configuredByUser: false, models: [], reason: "本地超分目前仅支持 Windows 桌面版。" };
    }
    const configured = await readConfiguredRuntime();
    const roots = configured ? [configured] : discoveredRuntimeRoots();
    let firstRoot: string | null = roots[0] ?? null;
    for (const root of roots) {
      const probe = await probeLocalSrRuntime(root);
      if (!firstRoot) firstRoot = probe.root;
      if (probe.models.length) {
        return { available: true, runtimeRoot: probe.root, configuredByUser: !!configured, models: probe.models };
      }
    }
    return {
      available: false,
      runtimeRoot: firstRoot,
      configuredByUser: !!configured,
      models: [],
      reason: configured ? "所选目录中未找到可用的本地超分模型。" : "Windows 本地超分运行时或模型未安装；可选择本地运行目录。",
    };
  }

  async function chooseRuntimeDirectory(): Promise<LocalSrRuntimeStatus | null> {
    const result = await openDialog({
      title: "选择本地超分运行目录",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = path.resolve(result.filePaths[0]);
    const stat = await fs.stat(chosen).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("所选路径不是有效目录。");
    await writeConfiguredRuntime(chosen);
    return getStatus();
  }

  async function pickSource(): Promise<LocalSrSourceSelection | null> {
    const result = await openDialog({
      title: "选择要本地放大的图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = path.resolve(result.filePaths[0]);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > LOCAL_SR_MAX_INPUT_BYTES) {
      throw new Error("源图片为空，或超过 64 MB 本地处理上限。");
    }
    const metadata = await sharp(filePath, { limitInputPixels: 300_000_000 }).metadata();
    if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "")) {
      throw new Error("无法读取图片尺寸；请选择 PNG、JPEG 或 WebP 图片。");
    }
    const sha256 = await sha256File(filePath);
    const afterHash = await fs.stat(filePath);
    if (afterHash.size !== stat.size || afterHash.mtimeMs !== stat.mtimeMs) {
      throw new Error("源图片在选择时发生变化；请重新选择图片。");
    }
    const selectionId = randomUUID();
    selections.set(selectionId, {
      filePath,
      fileName: path.basename(filePath),
      width: metadata.width,
      height: metadata.height,
      bytes: stat.size,
      sha256,
    });
    while (selections.size > 12) selections.delete(selections.keys().next().value!);
    return {
      selectionId,
      fileName: path.basename(filePath),
      width: metadata.width,
      height: metadata.height,
      bytes: stat.size,
      previewUrl: toLocalMediaUrl(filePath),
    };
  }

  async function run(
    request: { selectionId: string; modelId: string; confirmed: boolean },
    onProgress: (progress: LocalSrProgress) => void = () => undefined,
  ): Promise<LocalSrRunResult> {
    if (active) return { ok: false, message: "本地超分任务正在运行。" };
    if (request.confirmed !== true) return { ok: false, message: "请先确认所选图片、模型与预计输出尺寸。" };
    const source = selections.get(request.selectionId);
    const model = getLocalSrModel(request.modelId);
    if (!source || !model) return { ok: false, message: "图片选择已失效，或所选模型无效。请重新选择。" };
    const plan = planLocalSuperResolution(source.width, source.height, model.id);
    if (!plan.withinPixelLimit) return { ok: false, message: "输入或预计输出超过 32MP 上限；请先缩小源图或选择较低倍率模型。" };
    const controller = new AbortController();
    const job = { controller, child: undefined as ReturnType<typeof spawn> | undefined };
    // Lock synchronously before the first await (including status probes and
    // native dialogs), so two IPC calls cannot prepare the same model at once.
    active = job;
    const jobsRoot = path.join(userDataPath(), "local-super-resolution", "jobs");
    let jobDirectory: string | null = null;
    let timedOut = false;
    let cancelled = false;
    const send = (message: string, percent: number) => {
      try { onProgress({ message, percent }); } catch { /* Renderer may have closed. */ }
    };
    const canceledResult = (): LocalSrRunResult => ({ ok: false, cancelled: true, message: "本地超分已取消。" });
    try {
      const selectedHash = await sha256File(source.filePath);
      if (controller.signal.aborted) return canceledResult();
      if (selectedHash !== source.sha256) throw new Error("源图片在选择后发生变化；请重新选择图片。");

      const status = await getStatus();
      if (controller.signal.aborted) return canceledResult();
      if (!status.models.includes(model.id)) return { ok: false, message: status.reason ?? "所选本地超分模型尚未安装。" };
      const runtime = await probeLocalSrRuntime(status.runtimeRoot!);
      if (controller.signal.aborted) return canceledResult();
      const command = runtime.commands[model.id];
      if (!command) return { ok: false, message: "所选本地超分模型运行文件不完整。" };

      const save = await saveDialog({
        title: "保存本地超分结果",
        defaultPath: path.join(path.dirname(source.filePath), `${path.parse(source.fileName).name}-local-${model.scale}x.png`),
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (controller.signal.aborted) return canceledResult();
      if (save.canceled || !save.filePath) return { ok: false, cancelled: true, message: "已取消本地超分。" };

      const targetPath = outputDestination(save.filePath);
      if (!targetPath) return { ok: false, message: "本地超分结果为 PNG；请使用 .png 文件名保存。" };
      if (await sameFilePath(source.filePath, targetPath, platform)) {
        return { ok: false, message: "不能将结果保存到原图路径；请选择其他文件名。" };
      }
      if (controller.signal.aborted) return canceledResult();
      const targetDirectory = path.dirname(targetPath);
      if (!(await fs.stat(targetDirectory).catch(() => null))?.isDirectory()) {
        return { ok: false, message: "保存目录不存在。" };
      }
      if (controller.signal.aborted) return canceledResult();

      await fs.mkdir(jobsRoot, { recursive: true });
      if (controller.signal.aborted) return canceledResult();
      jobDirectory = await fs.mkdtemp(path.join(jobsRoot, "job-"));
      if (controller.signal.aborted) return canceledResult();
      const inputExtension = path.extname(source.fileName).toLocaleLowerCase();
      const inputPath = path.join(jobDirectory, `source${inputExtension}`);
      const outputPath = path.join(jobDirectory, "result.png");
      await fs.copyFile(source.filePath, inputPath);
      if (controller.signal.aborted) return canceledResult();
      const currentStat = await fs.stat(inputPath);
      const currentMetadata = await sharp(inputPath, { limitInputPixels: 300_000_000 }).metadata();
      const stagedHash = await sha256File(inputPath);
      if (currentStat.size !== source.bytes || currentMetadata.width !== source.width || currentMetadata.height !== source.height
        || stagedHash !== source.sha256) {
        throw new Error("源图片在选择后发生变化；请重新选择图片。");
      }
      if (controller.signal.aborted) return canceledResult();
      const modelName = model.id === "realesrganAnime4x" ? "realesrgan-x4plus-anime"
        : model.id === "realcuganConservative2x" ? "up2x-conservative" : "up4x-conservative";
      const args = model.engine === "realesrgan"
        ? ["-i", inputPath, "-o", outputPath, "-n", modelName, "-s", "4", "-t", "0", "-m", command.modelDirectory, "-f", "png", "-j", "2:1:2", "-v"]
        : ["-i", inputPath, "-o", outputPath, "-n", "-1", "-s", String(model.scale), "-t", "0", "-c", "0", "-m", command.modelDirectory, "-f", "png", "-j", "2:1:2", "-v"];
      const environment: NodeJS.ProcessEnv = { TEMP: jobDirectory, TMP: jobDirectory };
      const systemRoot = process.env.SystemRoot?.trim();
      if (systemRoot) { environment.SystemRoot = systemRoot; environment.WINDIR = systemRoot; }
      if (controller.signal.aborted) return canceledResult();
      send("正在启动本地超分", 0);
      const child = spawnProcess(command.executable, args, {
        cwd: command.workingDirectory,
        env: environment,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.child = child;
      let timeout: NodeJS.Timeout | null = null;
      let killWatchdog: NodeJS.Timeout | null = null;
      let resolveForcedStop!: (cause: "cancelled" | "timeout") => void;
      const forcedStop = new Promise<"cancelled" | "timeout">((resolve) => { resolveForcedStop = resolve; });
      const terminate = (cause: "cancelled" | "timeout") => {
        if (cause === "cancelled") cancelled = true;
        else timedOut = true;
        if (timeout) clearTimeout(timeout);
        child.kill();
        if (!killWatchdog) killWatchdog = setTimeout(() => resolveForcedStop(cause), 5_000);
      };
      const abort = () => terminate("cancelled");
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      let lastPercent = -1;
      const listen = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return;
        let pending = "";
        stream.on("data", (chunk: Buffer | string) => {
          pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
          const lines = pending.split(/\r\n|\r|\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const percent = percentFromText(line);
            if (percent !== null && percent !== lastPercent) {
              lastPercent = percent;
              send("正在进行本地超分", percent);
            }
          }
        });
        stream.on("end", () => {
          const percent = percentFromText(pending);
          if (percent !== null && percent !== lastPercent) {
            lastPercent = percent;
            send("正在进行本地超分", percent);
          }
        });
      };
      listen(child.stdout);
      listen(child.stderr);
      timeout = setTimeout(() => terminate("timeout"), RUNTIME_TIMEOUT_MS);
      let outcome: { kind: "exit"; code: number | null } | { kind: "cancelled" | "timeout" };
      try {
        const exited = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve(code));
        });
        outcome = await Promise.race([
          exited.then((code) => ({ kind: "exit" as const, code })),
          forcedStop.then((kind) => ({ kind })),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (killWatchdog) clearTimeout(killWatchdog);
        controller.signal.removeEventListener("abort", abort);
      }
      if (outcome.kind === "cancelled" || controller.signal.aborted || cancelled) return canceledResult();
      if (outcome.kind === "timeout" || timedOut) return { ok: false, message: "本地超分处理超时。" };
      if (outcome.kind !== "exit") return { ok: false, message: "本地超分进程未能正常退出。" };
      if (outcome.code !== 0) return { ok: false, message: "本地超分未能完成；请检查 Windows 图形驱动和运行时。" };

      const resultStat = await fs.stat(outputPath).catch(() => null);
      if (controller.signal.aborted) return canceledResult();
      if (!resultStat?.isFile() || resultStat.size < 45 || resultStat.size > LOCAL_SR_MAX_OUTPUT_BYTES) {
        return { ok: false, message: "本地超分结果文件为空或超过 64 MB 上限。" };
      }
      const outputMetadata = await sharp(outputPath).metadata();
      if (controller.signal.aborted) return canceledResult();
      if (outputMetadata.format !== "png" || outputMetadata.width !== plan.outputWidth || outputMetadata.height !== plan.outputHeight) {
        return { ok: false, message: "本地超分输出尺寸或 PNG 格式与预计结果不符。" };
      }
      const outputBytes = await fs.readFile(outputPath);
      if (controller.signal.aborted) return canceledResult();
      if (await sameFilePath(source.filePath, targetPath, platform)) {
        return { ok: false, message: "不能将结果保存到原图路径；请选择其他文件名。" };
      }
      if (controller.signal.aborted) return canceledResult();
      const stagedTarget = `${targetPath}.${randomUUID()}.tmp`;
      await fs.writeFile(stagedTarget, outputBytes, { flag: "wx" });
      if (controller.signal.aborted) {
        await fs.rm(stagedTarget, { force: true }).catch(() => undefined);
        return canceledResult();
      }
      try { await fs.rename(stagedTarget, targetPath); }
      catch (error) {
        await fs.rm(stagedTarget, { force: true }).catch(() => undefined);
        throw error;
      }
      send("本地超分完成", 100);
      return {
        ok: true,
        outputPath: targetPath,
        outputUrl: toLocalMediaUrl(targetPath),
        fileName: path.basename(targetPath),
        width: plan.outputWidth,
        height: plan.outputHeight,
        modelId: model.id,
      };
    } catch (error) {
      if (controller.signal.aborted || cancelled) return canceledResult();
      return { ok: false, message: error instanceof Error ? error.message : "本地超分运行失败。" };
    } finally {
      if (jobDirectory) await fs.rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
      selections.delete(request.selectionId);
      if (active === job) active = null;
    }
  }

  function cancel() {
    active?.controller.abort();
  }

  return { getStatus, chooseRuntimeDirectory, pickSource, run, cancel };
}

const localSuperResolutionService = createLocalSuperResolutionService();

export const localSrGetStatus = localSuperResolutionService.getStatus;
export const localSrChooseRuntimeDirectory = localSuperResolutionService.chooseRuntimeDirectory;
export const localSrPickSource = localSuperResolutionService.pickSource;
export const localSrRun = localSuperResolutionService.run;
export const localSrCancel = localSuperResolutionService.cancel;
