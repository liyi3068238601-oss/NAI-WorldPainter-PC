import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)('ends mobile frame and brush gestures before hovering or editing another panel', () => {
  const electron = createRequire(import.meta.url)('electron') as string;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-inpaint-pointer-test-'));
  const env: NodeJS.ProcessEnv = { ...process.env, POINTER_SOURCE: process.cwd(), POINTER_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [path.resolve('scripts/check-mobile-inpaint-pointer.cjs')], { env, encoding: 'utf8', timeout: 35000, windowsHide: true });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.passed).toBe(7);
  expect(report.total).toBe(7);
  expect(report.physicalPointerTested).toBe(false);
}, 35000);
