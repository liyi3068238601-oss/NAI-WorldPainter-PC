import { dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { NAI_INPAINT_MODELS, normalizeGenerateParams, normalizeNAIBaseModel, isNAIV5Model, type GenerateParams, type MobileInpaintRequest, type LoadImageResult } from '../../src/types';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, validateImage } from './image-codec';
import { toLocalMediaUrl } from './local-media-protocol';

/** Compare non-secret runtime stamps inside the account operation snapshot before any paid submission. */
export function assertMobileInpaintAccount(request: MobileInpaintRequest, current: { accountId?: string; revision: string }) {
  if (!request || typeof request.expectedAccountRevision !== 'string' || !request.expectedAccountRevision || request.expectedAccountRevision !== current.revision || request.expectedAccountId !== current.accountId) throw Error('新版重绘所属账户已变化或未确认；未提交，请重新点击生成。');
}

const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);

/** Check the header before decoding, so an IPC payload cannot allocate an unbounded bitmap. */
export function decodeMobilePng(base64: string, maxPixels = MAX_IMAGE_PIXELS) {
  if (typeof base64 !== 'string') throw Error('图片必须是 PNG。');
  const raw = base64.replace(/^data:image\/png;base64,/, '');
  if (!raw || raw.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw Error('PNG 数据为空、格式无效或超过 32 MB。');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length < 33 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0,8).equals(PNG_SIGNATURE) || bytes.toString('ascii',12,16) !== 'IHDR') throw Error('图片必须是有效 PNG。');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > maxPixels) throw Error('PNG 尺寸超出处理上限。');
  const png = PNG.sync.read(bytes);
  if (png.width !== width || png.height !== height) throw Error('PNG 尺寸异常。');
  return { bytes, png, width, height };
}

export function prepareMobileInpaintRequest(request: MobileInpaintRequest) {
  if (!request || !request.params || !NAI_INPAINT_MODELS.some(model => model.value === request.model)) throw Error('请选择有效的重绘模型。');
  const { width, height } = request.params;
  if (![width,height].every(value => Number.isInteger(value) && value >= 64 && value <= 1920 && value % 64 === 0)) throw Error('处理分辨率必须为 64 的倍数，且在 64–1920 像素之间。');
  const image = decodeMobilePng(request.imageBase64, 1920 * 1920);
  const mask = decodeMobilePng(request.maskBase64, 1920 * 1920);
  if (image.width !== width || image.height !== height || mask.width !== width || mask.height !== height) throw Error('处理图片、蒙版与请求尺寸必须一致。');
  if (!Number.isFinite(request.strength)) throw Error('重绘强度无效。');
  let painted = false;
  for (let i = 0; i < mask.png.data.length; i += 4) if (mask.png.data[i] > 0 && mask.png.data[i+3] > 0) { painted = true; break; }
  if (!painted) throw Error('输出框内没有重绘蒙版。');
  return { imageBase64: image.bytes.toString('base64'), maskBase64: mask.bytes.toString('base64'), strength: Math.min(1, Math.max(.01, request.strength)), width, height };
}

/** Saved replay parameters describe the actual inpaint checkpoint, never a different main-tab model. */
export function normalizeMobileInpaintParams(request: MobileInpaintRequest): GenerateParams {
  const params = normalizeGenerateParams({ ...request.params,
    model: normalizeNAIBaseModel(request.model) as GenerateParams['model'],
    metadataReplay: undefined,
  });
  return { ...params, steps: isNAIV5Model(params.model) ? Math.min(28, params.steps) : params.steps };
}

/** Mobile official API semantics. Its source/color checkboxes are not transported on this channel. */
export function applyMobileOfficialInpaintParameters(parameters: Record<string, unknown>, input: ReturnType<typeof prepareMobileInpaintRequest>) {
  parameters.image = input.imageBase64;
  parameters.mask = input.maskBase64;
  parameters.strength = input.strength;
  // Phone official transport fixes these four values after authored captions are built.
  // Keep PC-side tag insertion disabled in saved params; do not append quality/UC text locally.
  parameters.qualityToggle = true;
  parameters.quality_toggle = true;
  parameters.ucPreset = 1;
  parameters.uc_preset = 1;
  delete parameters.qualityPresetId;
  delete parameters.tag_hint_qt;
  // The mobile official builder does not emit these PC editor-specific controls.
  for (const field of ['legacy','legacy_v3_extend','dynamic_thresholding','skip_cfg_above_sigma','tag_hint_transparent_background','straight_alpha','deliberate_euler_ancestral_bug','prefer_brownian']) delete parameters[field];
  const negative = parameters.v4_negative_prompt;
  if (negative && typeof negative === 'object' && !Array.isArray(negative)) delete (negative as Record<string, unknown>).legacy_uc;
  delete parameters.inpaintImg2ImgStrength;
  delete parameters.img2img;
  delete parameters.add_original_image;
  delete parameters.color_correct;
  delete parameters.noise;
  return parameters;
}

/** Read-only source loading never changes the legacy workbench image binding. */
export async function readMobileInpaintSource(filePath: string): Promise<LoadImageResult> {
  try {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !['.png','.jpg','.jpeg','.webp','.gif','.avif'].includes(path.extname(filePath).toLowerCase())) throw Error('请选择支持的图片文件。');
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || !stat.size || stat.size > MAX_IMAGE_BYTES) throw Error('图片为空或超过 32 MB。');
    const bytes = await fs.readFile(filePath);
    const decoded = await validateImage(bytes);
    const meta = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, pages: 1 }).metadata();
    const swapped = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
    return { ok: true, image: { filePath, fileUrl: toLocalMediaUrl(filePath), width: swapped ? decoded.height : decoded.width, height: swapped ? decoded.width : decoded.height } };
  } catch (error) { return { ok: false, message: `导入图片失败：${error instanceof Error ? error.message : '未知错误'}` }; }
}

export async function pickMobileInpaintSource(): Promise<LoadImageResult> {
  try {
    const picked = await dialog.showOpenDialog({ title: '导入新版局部重绘图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png','jpg','jpeg','webp','gif','avif'] }] });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, message: '已取消导入。' };
    return readMobileInpaintSource(picked.filePaths[0]);
  } catch (error) { return { ok: false, message: `导入图片失败：${error instanceof Error ? error.message : '未知错误'}` }; }
}

/** The native picker owns the destination. Exclusive creation never overwrites an existing image. */
export async function saveMobileInpaint(base64: string): Promise<LoadImageResult> {
  try {
    const input = decodeMobilePng(base64, 32 * 1024 * 1024);
    const selection = await dialog.showSaveDialog({ title: '保存新版局部重绘', defaultPath: `绘世-局部重绘-${Date.now()}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
    if (selection.canceled || !selection.filePath) return { ok: false, message: '已取消保存。' };
    const filePath = /\.png$/i.test(selection.filePath) ? selection.filePath : `${selection.filePath}.png`;
    const handle = await fs.open(filePath, 'wx');
    try { await handle.writeFile(input.bytes); await handle.sync(); }
    catch (error) { await handle.close().catch(() => undefined); await fs.unlink(filePath).catch(() => undefined); throw error; }
    await handle.close();
    return { ok: true, image: { filePath, fileUrl: toLocalMediaUrl(filePath), width: input.width, height: input.height }, message: `已保存 ${path.basename(filePath)}。` };
  } catch (error) {
    return { ok: false, message: (error as NodeJS.ErrnoException).code === 'EEXIST' ? '该文件已存在，请选择新的文件名；原文件未改动。' : `保存失败：${error instanceof Error ? error.message : '未知错误'}` };
  }
}
