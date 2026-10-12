import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.resolve(
  process.env.WORLDPAINTER_SR_RUNTIME ?? path.join(repositoryRoot, '.tmp', 'sr-runtime'),
);
const scratchBase = path.resolve(repositoryRoot, '.tmp');
const scratchRoot = path.resolve(
  process.env.WORLDPAINTER_SR_TEMP ?? path.join(repositoryRoot, '.tmp', 'sr-probe'),
);
const width = 64;
const height = 64;
const deviceId = process.env.WORLDPAINTER_SR_DEVICE_ID;
if (deviceId != null && !/^\d+$/.test(deviceId)) {
  throw new Error('Vulkan device ID must be a non-negative integer.');
}

if (!isWithin(scratchBase, scratchRoot)) {
  throw new Error('Probe scratch must stay inside the project .tmp directory.');
}

mkdirSync(scratchRoot, { recursive: true });
const jobDirectory = mkdtempSync(path.join(scratchRoot, 'synthetic-sr-'));
try {
  const inputPath = path.join(jobDirectory, 'source.png');
  writeFileSync(inputPath, makeSyntheticPng(width, height));

  const presets = [
    {
      key: 'realesrganAnime4x',
      executable: path.join(runtimeRoot, 'realesrgan', 'realesrgan-ncnn-vulkan.exe'),
      workingDirectory: path.join(runtimeRoot, 'realesrgan'),
      modelDirectory: path.join(runtimeRoot, 'realesrgan', 'models'),
      scale: 4,
      args: (outputPath, modelDirectory) => [
        '-i', inputPath,
        '-o', outputPath,
        '-n', 'realesrgan-x4plus-anime',
        '-s', '4',
        '-t', '0',
        '-m', modelDirectory,
        '-f', 'png',
        '-j', '2:1:2',
        '-v',
      ],
    },
    {
      key: 'realcuganConservative2x',
      executable: path.join(runtimeRoot, 'realcugan', 'realcugan-ncnn-vulkan.exe'),
      workingDirectory: path.join(runtimeRoot, 'realcugan'),
      modelDirectory: path.join(runtimeRoot, 'realcugan', 'models-se'),
      scale: 2,
      args: (outputPath, modelDirectory) => [
        '-i', inputPath,
        '-o', outputPath,
        '-n', '-1',
        '-s', '2',
        '-t', '0',
        '-c', '0',
        '-m', modelDirectory,
        '-f', 'png',
        '-j', '2:1:2',
        '-v',
      ],
    },
    {
      key: 'realcuganConservative4x',
      executable: path.join(runtimeRoot, 'realcugan', 'realcugan-ncnn-vulkan.exe'),
      workingDirectory: path.join(runtimeRoot, 'realcugan'),
      modelDirectory: path.join(runtimeRoot, 'realcugan', 'models-se'),
      scale: 4,
      args: (outputPath, modelDirectory) => [
        '-i', inputPath,
        '-o', outputPath,
        '-n', '-1',
        '-s', '4',
        '-t', '0',
        '-c', '0',
        '-m', modelDirectory,
        '-f', 'png',
        '-j', '2:1:2',
        '-v',
      ],
    },
  ];

  for (const preset of presets) {
    const outputPath = path.join(jobDirectory, preset.key + '.png');
    const args = preset.args(outputPath, preset.modelDirectory);
    if (deviceId != null) args.push('-g', deviceId);
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const env = {
      TEMP: jobDirectory,
      TMP: jobDirectory,
      ...(systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {}),
    };
    const result = spawnSync(preset.executable, args, {
      cwd: preset.workingDirectory,
      env,
      encoding: 'buffer',
      maxBuffer: 1024 * 1024,
      timeout: 20 * 60 * 1000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error('CLI probe failed for ' + preset.key + '.');
    }
    const output = readFileSync(outputPath);
    const dimensions = readPngDimensions(output);
    if (
      !dimensions ||
      dimensions.width !== width * preset.scale ||
      dimensions.height !== height * preset.scale
    ) {
      throw new Error('CLI output dimensions were invalid for ' + preset.key + '.');
    }
    console.log(
      preset.key + ': ' + output.length + ' bytes, ' +
        dimensions.width + 'x' + dimensions.height,
    );
    const cliOutput = Buffer.concat([
      result.stdout ?? Buffer.alloc(0),
      result.stderr ?? Buffer.alloc(0),
    ]).toString('utf8');
    const gpu = cliOutput.match(
      /(?:NVIDIA GeForce[^\r\n]*|Intel(?:\(R\))? Graphics[^\r\n]*|AMD Radeon[^\r\n]*)/i,
    )?.[0]?.slice(0, 100);
    if (gpu) console.log(preset.key + ' device: ' + gpu);
  }
  console.log('All three local SR CLI presets passed the synthetic PNG probe.');
} finally {
  rmSync(jobDirectory, { recursive: true, force: true });
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
      relative !== '..' &&
      !path.isAbsolute(relative));
}

function makeSyntheticPng(imageWidth, imageHeight) {
  const rows = Buffer.alloc((imageWidth * 4 + 1) * imageHeight);
  for (let y = 0; y < imageHeight; y += 1) {
    const rowOffset = y * (imageWidth * 4 + 1);
    rows[rowOffset] = 0;
    for (let x = 0; x < imageWidth; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      const checker = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) === 0;
      rows[offset] = checker ? 220 : 25;
      rows[offset + 1] = (x * 4) & 0xff;
      rows[offset + 2] = (y * 4) & 0xff;
      rows[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(imageWidth, 0);
  header.writeUInt32BE(imageHeight, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  let offset = 8;
  let hasImageData = false;
  let hasEnd = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (size > bytes.length - offset - 12) return null;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') hasImageData = true;
    offset += size + 12;
    if (type === 'IEND') {
      hasEnd = size === 0;
      break;
    }
  }
  return hasImageData && hasEnd ? { width, height } : null;
}
