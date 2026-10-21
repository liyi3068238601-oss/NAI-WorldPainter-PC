// Offline, synthetic-only GUI regression for the packaged mobile inpaint renderer.
// Usage: node scripts/check-mobile-inpaint-integration.cjs [desktop-dir]
// All account, quote, generation, picker, and gateway IPC below is explicitly mocked.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const desktopArg = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const desktop = path.resolve(desktopArg || process.env.INPAINT_APP_DESKTOP || path.resolve(__dirname, '..'));
const repo = path.dirname(desktop);
const runId = `mobile-inpaint-integration-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const run = path.join(desktop, '.tmp', runId);
const evidence = path.resolve(process.env.INPAINT_EVIDENCE_DIR || path.join(repo, 'docs', 'evidence', 'mobile-inpaint-merge-20261021', runId));
const playwrightCandidates = [process.env.INPAINT_PLAYWRIGHT_PATH,
  path.join(desktop, '.tmp', 'uiux-tools', 'node_modules', 'playwright-core'),
  path.join(path.dirname(repo), 'dot-uiux', 'desktop', '.tmp', 'uiux-tools', 'node_modules', 'playwright-core')].filter(Boolean);
const playwrightPath = playwrightCandidates.find(candidate => fs.existsSync(candidate));
const { _electron } = require(playwrightPath || require.resolve('playwright-core', { paths: [desktop] }));
const { PNG } = require(path.join(desktop, 'node_modules', 'pngjs'));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const hashBytes = bytes => { let h = 0x811c9dc5; for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const results = [];
const errors = [];
const screenshots = [];
const generationDiagnostics = [];
const mockCounts = { official: 0, quote: 0, picker: 0, prepare: 0, gatewayGenerate: 0, cancel: 0 };
let app;
let windowHandle;
let page;
let failureScreenshot = null;

function pass(name, details = {}) { results.push({ name, ok: true, ...details }); }
async function capture(name) {
  await page.waitForTimeout(400);
  const frame = await windowHandle.evaluate(async win => {
    const png = await win.webContents.capturePage();
    return { data: png.toPNG().toString('base64'), size: png.getSize(), bounds: win.getBounds() };
  });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    theme: document.documentElement.classList.contains('theme-dark') ? 'dark' : 'light', themeClass: document.documentElement.className }));
  const file = `${String(screenshots.length + 1).padStart(2, '0')}-${name}.png`;
  fs.writeFileSync(path.join(evidence, file), Buffer.from(frame.data, 'base64'));
  screenshots.push({ file, size: frame.size, bounds: frame.bounds, viewport });
}
async function diagnoseGenerationClick(stage) {
  try {
    const ui = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent?.includes('生成重绘候选'));
      const worker = window.__mobileWorkerTrace;
      return {
        activeTab: document.querySelector('.tab-bar [aria-current="page"]')?.getAttribute('data-tab') || null,
        generateButton: button ? { disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled'), text: button.textContent?.trim().slice(0, 100) } : null,
        notices: [...document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="status"], .mobile-inpaint-error, .toast, .status-bar')]
          .map(node => ({ role: node.getAttribute('role'), className: typeof node.className === 'string' ? node.className : '', text: node.textContent?.trim().slice(0, 240) }))
          .filter(item => item.text),
        worker: worker ? { created: worker.created, posts: worker.posts, preparePosts: worker.preparePosts,
          prepareReplies: worker.replies.filter(reply => reply.kind === 'prepare').length } : null,
      };
    });
    const counts = await mockState();
    generationDiagnostics.push({ stage, at: new Date().toISOString(), ...ui, mockCounts: counts });
  } catch (error) {
    generationDiagnostics.push({ stage, at: new Date().toISOString(), diagnosticError: String(error) });
  }
}
async function dismissNotices() {
  const onboarding = page.locator('.onboarding');
  if (await onboarding.count()) await onboarding.getByRole('button').first().click({ timeout: 5000 });
  const v5 = page.locator('.v5-migration-notice');
  if (await v5.count()) await v5.getByRole('button').first().click({ timeout: 5000 });
  const migration = page.locator('.update-banner');
  if (await migration.count()) await migration.getByRole('button').last().click({ timeout: 3000 }).catch(() => {});
}
async function installMocks() {
  await app.evaluate(({ ipcMain }, input) => {
    const req = process.getBuiltinModule('node:module').createRequire(input.desktop + '/package.json');
    const fs = req('node:fs');
    const path = req('node:path');
    const crypto = req('node:crypto');
    const { PNG } = req(path.join(input.desktop, 'node_modules/pngjs'));
    const hashBytes = bytes => { let h = 0x811c9dc5; for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
    globalThis.integrationFixture = input.fixture;
    globalThis.integrationEvidence = input.evidence;
    globalThis.integrationCounts = { official: 0, quote: 0, picker: 0, prepare: 0, gatewayGenerate: 0, cancel: 0, active: 0, maxActive: 0 };
    globalThis.integrationPickerFailure = false;
    const handlers = [
      'nai:hasToken', 'nai:accountCached', 'nai:quoteAnlas', 'nai:mobileInpaint',
      'mobile-inpaint:pick-source', 'gatewayWorkbench:listProfiles', 'gatewayWorkbench:selectProfile',
      'gatewayWorkbench:prepareMobileInpaint', 'gatewayWorkbench:generate', 'gatewayWorkbench:cancel',
    ];
    for (const channel of handlers) ipcMain.removeHandler(channel);
    const account = { hasToken: true, anlasBalance: 100000, hasActiveSubscription: true, accountId: 'synthetic-account', revision: 'synthetic-revision' };
    ipcMain.handle('nai:hasToken', () => account);
    ipcMain.handle('nai:accountCached', () => account);
    ipcMain.handle('nai:quoteAnlas', () => { globalThis.integrationCounts.quote++; return { ok: true, amount: 0, source: 'local-estimate', balance: 100000, insufficient: false, message: 'SYNTHETIC QUOTE: no service request' }; });
    ipcMain.handle('mobile-inpaint:pick-source', () => {
      globalThis.integrationCounts.picker++;
      if (globalThis.integrationPickerFailure) return { ok: false, message: 'SYNTHETIC PICKER FAILURE' };
      return { ok: true, image: { filePath: 'synthetic-mobile-inpaint.png', fileUrl: 'data:image/png;base64,' + globalThis.integrationFixture, width: 128, height: 128 } };
    });
    ipcMain.handle('nai:mobileInpaint', async (_event, request) => {
      const number = ++globalThis.integrationCounts.official;
      globalThis.integrationCounts.active++;
      globalThis.integrationCounts.maxActive = Math.max(globalThis.integrationCounts.maxActive, globalThis.integrationCounts.active);
      const image = Buffer.from(request.imageBase64, 'base64');
      const maskBytes = Buffer.from(request.maskBase64, 'base64');
      const mask = PNG.sync.read(maskBytes);
      let nonempty = 0, aligned8 = true;
      for (let i = 0; i < mask.data.length; i += 4) if (mask.data[i] >= 128) nonempty++;
      for (let y = 0; y < mask.height; y += 8) for (let x = 0; x < mask.width; x += 8) {
        const v = mask.data[(y * mask.width + x) * 4] >= 128;
        for (let yy = y; yy < Math.min(y + 8, mask.height); yy++) for (let xx = x; xx < Math.min(x + 8, mask.width); xx++) if ((mask.data[(yy * mask.width + xx) * 4] >= 128) !== v) aligned8 = false;
      }
      const logPath = path.join(globalThis.integrationEvidence, 'synthetic-generation-requests.json');
      const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
      log.push({ number, width: mask.width, height: mask.height, nonemptyMaskPixels: nonempty,
        maskAlignedTo8x8: aligned8, maskRgbaHash: hashBytes(mask.data), maskPngSha256: crypto.createHash('sha256').update(maskBytes).digest('hex'),
        positive: request.params.positivePrompt, negative: request.params.negativePrompt, imageSha256: crypto.createHash('sha256').update(image).digest('hex'),
        note: 'explicit IPC mock; synthetic source only; no provider/API/token/network request' });
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
      const generated = PNG.sync.read(image);
      for (let y = 0; y < generated.height; y++) for (let x = 0; x < generated.width; x++) {
        const i = (y * generated.width + x) * 4;
        generated.data[i] = 40 + number * 35; generated.data[i + 1] = 80 + Math.floor(x / generated.width * 90); generated.data[i + 2] = 230; generated.data[i + 3] = 255;
      }
      const out = PNG.sync.write(generated);
      const filePath = path.join(globalThis.integrationEvidence, `synthetic-candidate-${number}.png`);
      fs.writeFileSync(filePath, out);
      await new Promise(resolve => setTimeout(resolve, 35));
      globalThis.integrationCounts.active--;
      return { ok: true, message: 'Synthetic candidate; no remote generation', items: [{ id: `synthetic-${number}`, filePath, fileUrl: 'data:image/png;base64,' + out.toString('base64'), date: '2026-10-21', actualSeed: 8000 + number, model: request.model, width: generated.width, height: generated.height, params: request.params }] };
    });
    const profile = { id: 'synthetic-gateway', name: 'SYNTHETIC gateway', protocol: 'gateway7877', baseUrl: 'http://127.0.0.1:18777', selected: true };
    ipcMain.handle('gatewayWorkbench:listProfiles', () => [profile]);
    ipcMain.handle('gatewayWorkbench:selectProfile', () => [profile]);
    ipcMain.handle('gatewayWorkbench:prepareMobileInpaint', (_event, input) => {
      globalThis.integrationCounts.prepare++;
      globalThis.integrationPlanRequest = input;
      return { planId: 'synthetic-plan', profileRevision: '00000000-0000-4000-8000-000000000001', expiresAt: new Date(Date.now() + 60000).toISOString(), profileId: profile.id, profileName: profile.name,
        protocol: profile.protocol, endpoint: profile.baseUrl, model: input.request.model, prompt: input.request.params.positivePrompt,
        negativePrompt: input.request.params.negativePrompt, width: input.request.params.width, height: input.request.params.height,
        steps: input.request.params.steps, scale: input.request.params.cfgScale, cfgRescale: input.request.params.cfgRescale,
        sampler: input.request.sampling.sampler, noiseSchedule: input.request.sampling.noiseSchedule, seed: 0,
        operation: 'mobileInpaint', requestPayload: { synthetic: true } };
    });
    ipcMain.handle('gatewayWorkbench:generate', () => { globalThis.integrationCounts.gatewayGenerate++; return { status: 'succeeded', message: 'Synthetic only', items: [] }; });
    ipcMain.handle('gatewayWorkbench:cancel', () => { globalThis.integrationCounts.cancel++; return { accepted: true, message: 'Synthetic cancellation' }; });
  }, { desktop, evidence, fixture: fs.readFileSync(path.join(run, 'synthetic-mobile-inpaint.png')).toString('base64') });
}
async function mockState() { return app.evaluate(() => ({ ...globalThis.integrationCounts, pickerFailure: globalThis.integrationPickerFailure })); }
async function exerciseR4Entries() {
  await page.locator('.tab-bar [data-tab="agent"]').click();
  const agentRoot = page.locator('.pi-agent:visible').last();
  await agentRoot.waitFor({ state: 'visible', timeout: 15000 });
  const r4Topbar = agentRoot.locator('.r4-topbar');
  await r4Topbar.waitFor({ state: 'visible', timeout: 15000 });
  const creationSelect = r4Topbar.locator('select[aria-label="当前创作"], select[aria-label="Current creation"]');
  await creationSelect.waitFor({ state: 'visible', timeout: 10000 });
  check(await creationSelect.count() === 1, 'R4 current-creation selector is not unique');
  const resourcesPane = agentRoot.locator('#pi-creative-resources-pane');
  await resourcesPane.waitFor({ state: 'attached', timeout: 10000 });
  let rightPaneExpanded = await resourcesPane.isVisible();
  if (!rightPaneExpanded) {
    const rightToggle = r4Topbar.locator('.r4-topbar-right .r4-topbar-drawer:visible').last();
    await rightToggle.waitFor({ state: 'visible', timeout: 10000 });
    await rightToggle.click();
  }
  await resourcesPane.waitFor({ state: 'visible', timeout: 10000 });
  rightPaneExpanded = await resourcesPane.isVisible();
  const resourcesTab = resourcesPane.getByRole('tab', { name: '资源', exact: true });
  await resourcesTab.click();
  const presetPanel = resourcesPane.locator('.pi-assistant-presets');
  await presetPanel.waitFor({ state: 'visible', timeout: 10000 });
  const defaultButton = presetPanel.locator('.r4-preset-control > button');
  await defaultButton.waitFor({ state: 'visible', timeout: 10000 });
  check(await defaultButton.count() === 1, 'R4 new-chat default button is not unique');
  check(await resourcesTab.getAttribute('aria-selected') === 'true', 'R4 Resources tab did not become active');
  await capture('r4-resource-presets');
  pass('R4 Agent 创作顶栏与资源预设面板可达', {
    currentCreation: { visible: await creationSelect.isVisible(), value: await creationSelect.inputValue(), disabled: await creationSelect.isDisabled() },
    resourcesPaneExpanded: rightPaneExpanded,
    resourcesTabSelected: true,
    presetPanelVisible: await presetPanel.isVisible(),
    defaultButton: { visible: await defaultButton.isVisible(), disabled: await defaultButton.isDisabled(), text: (await defaultButton.innerText()).trim() },
    screenshot: screenshots.at(-1)?.file,
  });
}

(async () => {
  fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
  check(fs.existsSync(path.join(desktop, 'dist', 'index.html')), `No packaged renderer at ${desktop}/dist/index.html`);
  check(fs.existsSync(path.join(desktop, 'dist-electron', 'electron', 'bootstrap.js')), `No packaged Electron bootstrap at ${desktop}/dist-electron/electron/bootstrap.js`);
  const source = new PNG({ width: 128, height: 128 });
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const i = (y * source.width + x) * 4; source.data[i] = x * 2; source.data[i + 1] = y * 2; source.data[i + 2] = 120; source.data[i + 3] = 255;
  }
  fs.writeFileSync(path.join(run, 'synthetic-mobile-inpaint.png'), PNG.sync.write(source));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|API.?KEY|SECRET|CREDENTIAL|PORTABLE_EXECUTABLE|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL|NAI_UI_CAPTURE_PATH/i.test(key)) delete env[key];
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'HOME']) { env[key] = path.join(run, key.toLowerCase()); fs.mkdirSync(env[key], { recursive: true }); }
  env.WORLDPAINTER_DATA_DIR = path.join(run, 'profile'); env.UIUX_AUDIT_ROOT = run;
  env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = 'http://127.0.0.1:9'; env.NO_PROXY = 'localhost,127.0.0.1';
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  try {
    app = await _electron.launch({ executablePath: require(path.join(desktop, 'node_modules', 'electron')), args: [path.join(desktop, 'scripts', 'uiux-offline-entry.cjs'), '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'], cwd: desktop, env, timeout: 45000 });
    page = await app.firstWindow(); windowHandle = await app.browserWindow(page);
    page.setDefaultTimeout(9000);
    const rendererErrors = [];
    page.on('pageerror', error => rendererErrors.push(error.stack || String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 500)); });
    await windowHandle.evaluate(win => { win.webContents.setBackgroundThrottling(false); win.show(); win.focus(); if (win.isMaximized()) win.unmaximize(); win.setContentSize(1440, 950); });
    await installMocks();
    await page.addInitScript(() => {
      const navTrace = window.__mobileInpaintNavTrace = [];
      const activeTab = () => document.querySelector('.tab-bar [aria-current="page"]')?.getAttribute('data-tab') || null;
      document.addEventListener('pointerdown', event => {
        const tab = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
        if (tab) navTrace.push({ type: 'pointerdown-tab', target: tab.getAttribute('data-tab'), active: activeTab(), x: event.clientX, y: event.clientY });
      }, true);
      document.addEventListener('click', event => {
        const tab = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
        if (tab) navTrace.push({ type: 'click-tab', target: tab.getAttribute('data-tab'), active: activeTab(), x: event.clientX, y: event.clientY });
      }, true);
      document.addEventListener('keydown', event => {
        if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') {
          navTrace.push({ type: 'key', key: event.key, active: activeTab(), focus: event.target instanceof Element ? event.target.outerHTML.slice(0, 100) : '' });
        }
      }, true);
      const trace = window.__mobileWorkerTrace = { created: 0, posts: 0, preparePosts: 0, postKinds: [], replies: [] };
      const observeTab = () => navTrace.push({ type: 'active-tab-mutation', active: activeTab() });
      if (document.documentElement) new MutationObserver(observeTab).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['aria-current'] });
      const NativeWorker = window.Worker;
      window.Worker = new Proxy(NativeWorker, { construct(Target, args) {
        const url = String(args[0]); const worker = new Target(...args);
        if (url.includes('mobile-inpaint-worker')) {
          trace.created++;
          let kind = 'unknown';
          const post = worker.postMessage.bind(worker);
          worker.postMessage = (...values) => {
            trace.posts++; kind = values[0]?.kind || 'unknown'; trace.postKinds.push(kind);
            if (kind === 'prepare') trace.preparePosts++;
            return post(...values);
          };
          worker.addEventListener('message', event => {
            const result = event.data && event.data.result;
            const pixels = kind === 'prepare' ? result?.mask : result;
            if (pixels && pixels.data && pixels.width && pixels.height) {
              let h = 0x811c9dc5; for (const b of pixels.data) { h ^= b; h = Math.imul(h, 0x01000193); }
              trace.replies.push({ kind, width: pixels.width, height: pixels.height, rgbaHash: (h >>> 0).toString(16).padStart(8, '0') });
            } else if (kind === 'layer' && result?.image?.width && result?.image?.height) {
              trace.replies.push({ kind, completed: true, width: result.image.width, height: result.image.height,
                comparisonWidth: result.comparison?.width, comparisonHeight: result.comparison?.height });
            } else trace.replies.push({ kind, error: event.data && event.data.error || 'worker response has no mask pixels' });
          });
        }
        return worker;
      } });
    });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (/^(file:|data:|blob:|nai-local:)/i.test(url) || /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) return route.continue();
      return route.abort('blockedbyclient');
    });
    await page.reload(); await page.waitForTimeout(2500); await dismissNotices();
    if (process.argv.includes('--r4-only')) {
      await exerciseR4Entries();
    } else {
    await page.locator('[data-tab="inpaint"]').click();
    await page.getByRole('button', { name: '新模式 · 手机端', exact: true }).click();
    await page.getByRole('main', { name: '新版局部重绘工作区' }).waitFor();
    await page.getByRole('button', { name: '导入图片', exact: true }).click();
    await page.getByText('底图 128 × 128', { exact: true }).waitFor();
    pass('真实打包界面启动、合成源图导入', { rendererUrl: await page.url(), syntheticSource: '128x128 RGBA PNG', actualModuleWorkerBundle: fs.readdirSync(path.join(desktop, 'dist', 'assets')).filter(name => /^mobile-inpaint-worker-.*\.js$/.test(name)) });
    await capture('imported-new-workspace');

    // Exercise invalid-input feedback, then apply one legal custom output size.
    const widthField = page.getByLabel('新版处理宽度', { exact: true }); const heightField = page.getByLabel('新版处理高度', { exact: true });
    await widthField.fill('1000'); await widthField.press('Tab');
    await page.locator('.mobile-inpaint-error').filter({ hasText: '64' }).waitFor();
    check(await widthField.inputValue() === '832', `Invalid width draft was not normalized; got ${await widthField.inputValue()}`);
    await widthField.fill('256'); await widthField.press('Tab'); await heightField.fill('256'); await heightField.press('Tab');
    await page.waitForFunction(() => document.querySelector('.mobile-output-size select')?.value === '256x256');
    check(await page.locator('.mobile-inpaint-error').count() === 0, 'Legal 256x256 size did not clear validation error');
    pass('非法尺寸反馈、合法自定义尺寸保持', { rejected: '1000', accepted: '256x256' });

    // Explicitly exercise picker error reporting then restore the successful synthetic picker.
    await app.evaluate(() => { globalThis.integrationPickerFailure = true; });
    await page.getByRole('button', { name: '导入图片', exact: true }).click();
    await page.locator('.mobile-inpaint-error').filter({ hasText: 'SYNTHETIC PICKER FAILURE' }).waitFor();
    await app.evaluate(() => { globalThis.integrationPickerFailure = false; });
    await page.getByRole('button', { name: '导入图片', exact: true }).click(); await page.getByText('底图 128 × 128', { exact: true }).waitFor();
    pass('文件选择器错误可见且可恢复', { pickerMock: true });

    const brushButton = page.getByRole('button', { name: '画笔', exact: true });
    await brushButton.click();
    const stage = page.getByLabel('新版重绘画布', { exact: true }); const box = await stage.boundingBox();
    check(box && box.width > 100 && box.height > 100, `Canvas stage has unexpected bounds: ${JSON.stringify(box)}`);
    const workerBeforeFirstStroke = await page.evaluate(() => window.__mobileWorkerTrace.replies.length);
    await page.mouse.move(box.x + box.width * 0.46, box.y + box.height * 0.48);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.54, box.y + box.height * 0.52, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: '撤销', exact: true }).waitFor();
    check(await page.locator('.mobile-inpaint-actions button').filter({ hasText: '隐藏蒙版' }).count() === 1, 'Choosing brush did not automatically show the mask');
    await page.waitForFunction(before => {
      const replies = window.__mobileWorkerTrace?.replies || [];
      return replies.length > before && replies.some(r => r.kind === 'mask-preview' && r.width === 256 && r.height === 256);
    }, workerBeforeFirstStroke, { timeout: 15000 });
    const previewTrace = await page.evaluate(() => window.__mobileWorkerTrace);
    check(previewTrace.created > 0 && previewTrace.posts > 0 && previewTrace.replies.some(r => r.width === 256 && r.height === 256), `Packaged module worker preview missing: ${JSON.stringify(previewTrace)}`);
    pass('真实 Vite module Worker 完成 8×8 对齐最终蒙版预览', { workerCreated: previewTrace.created, workerPosts: previewTrace.posts, workerReplies: previewTrace.replies.length, lastPreview: previewTrace.replies.at(-1) });
    const activeSurface = await page.locator('.tab-bar [aria-current="page"]').getAttribute('data-tab');
    const navBeforeModeSwitch = await page.evaluate(() => window.__mobileInpaintNavTrace);
    if (activeSurface !== 'inpaint') await page.locator('[data-tab="inpaint"]').click();
    await capture('brush-preview');

    // The new and legacy modes share the mounted workspace; image and strokes should survive toggling.
    await page.getByRole('button', { name: '旧模式', exact: true }).click();
    await page.getByRole('button', { name: '新模式 · 手机端', exact: true }).click();
    await page.getByText('底图 128 × 128', { exact: true }).waitFor();
    check(!(await page.getByRole('button', { name: '撤销', exact: true }).isDisabled()), 'Stroke history disappeared after switching inpaint modes');
    pass('旧/新模式往返保留当前画布笔迹', { activeSurfaceAfterStroke: activeSurface, navigationTraceBeforeModeSwitch: navBeforeModeSwitch });

    // Independent prompt drafts and output size survive a true renderer restart.
    const pos = 'synthetic cold-start positive'; const neg = 'synthetic cold-start negative';
    await page.getByLabel('新版正向提示词', { exact: true }).fill(pos);
    await page.getByLabel('新版负向提示词', { exact: true }).fill(neg);
    await page.reload(); await page.waitForTimeout(2200); await dismissNotices();
    await page.locator('[data-tab="inpaint"]').click(); await page.getByRole('button', { name: '新模式 · 手机端', exact: true }).click();
    check(await page.getByLabel('新版正向提示词', { exact: true }).inputValue() === pos, 'Positive draft did not survive renderer cold start');
    check(await page.getByLabel('新版负向提示词', { exact: true }).inputValue() === neg, 'Negative draft did not survive renderer cold start');
    check(await page.locator('.mobile-output-size select').inputValue() === '256x256', 'Custom output did not survive renderer cold start');
    pass('独立正负提示词和自定义尺寸冷启动持久化');

    // Re-import after restart, draw again, then compare preview bytes with the actual IPC mask.
    await page.getByRole('button', { name: '导入图片', exact: true }).click(); await page.getByText('底图 128 × 128', { exact: true }).waitFor();
    await page.getByRole('button', { name: '画笔', exact: true }).click();
    const box2 = await stage.boundingBox();
    const workerBeforeSecondStroke = await page.evaluate(() => window.__mobileWorkerTrace.replies.length);
    await page.mouse.move(box2.x + box2.width * 0.46, box2.y + box2.height * 0.48);
    await page.mouse.down(); await page.mouse.move(box2.x + box2.width * 0.54, box2.y + box2.height * 0.52, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(600);
    await page.waitForFunction(before => {
      const replies = window.__mobileWorkerTrace?.replies || [];
      return replies.length > before && replies.some(r => r.kind === 'mask-preview' && r.width === 256 && r.height === 256);
    }, workerBeforeSecondStroke, { timeout: 15000 });
    const lastPreviewBeforeBatch = await page.evaluate(() => [...window.__mobileWorkerTrace.replies].reverse().find(reply => reply.kind === 'mask-preview' && reply.width === 256 && reply.height === 256));
    await page.getByLabel('新版候选数量', { exact: true }).fill('2');
    const mockStart = await mockState();
    await page.getByRole('button', { name: '生成重绘候选', exact: true }).click();
    await diagnoseGenerationClick('official-batch-after-click');
    await page.getByRole('dialog', { name: '重绘候选对比', exact: true }).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.mobile-inpaint-candidate-list button').length === 2, { timeout: 30000 });
    const afterBatch = await mockState(); check(afterBatch.official - mockStart.official === 2, `Expected exactly two explicit generation mocks; counts ${JSON.stringify(afterBatch)}`);
    const reqs = JSON.parse(fs.readFileSync(path.join(evidence, 'synthetic-generation-requests.json'), 'utf8'));
    const currentWorker = await page.evaluate(() => window.__mobileWorkerTrace);
    const lastPreview = lastPreviewBeforeBatch;
    check(reqs.length >= 2 && reqs.slice(-2).every(req => req.width === 256 && req.height === 256 && req.nonemptyMaskPixels > 0 && req.maskAlignedTo8x8), `Final request masks were not valid 256x256 8x8 masks: ${JSON.stringify(reqs.slice(-2))}`);
    check(lastPreview && reqs.at(-2).maskRgbaHash === lastPreview.rgbaHash, `Preview and final IPC mask differ: preview=${JSON.stringify(lastPreview)} request=${reqs.at(-2).maskRgbaHash}`);
    check(afterBatch.maxActive === 1 && afterBatch.active === 0, `Candidate IPC was not serial: ${JSON.stringify(afterBatch)}`);
    pass('串行 mock 双候选与最终请求蒙版一致', { requests: reqs.slice(-2).map(({ number, width, height, nonemptyMaskPixels, maskAlignedTo8x8, maskRgbaHash }) => ({ number, width, height, nonemptyMaskPixels, maskAlignedTo8x8, maskRgbaHash })), previewRgbaHash: lastPreview.rgbaHash });
    await capture('two-candidates-compare');
    check(await page.locator('.mobile-inpaint-review-after').count() === 1, 'Before/after compare overlay did not render');
    const compare = page.getByLabel('候选前后对比位置', { exact: true });
    await compare.fill('72'); check(await compare.inputValue() === '72', 'Compare divider range did not accept pointer-equivalent input');
    const compareBox = await page.locator('.mobile-inpaint-review-image').boundingBox();
    await page.mouse.move(compareBox.x + compareBox.width * 0.3, compareBox.y + compareBox.height * 0.5); await page.mouse.down();
    await page.mouse.move(compareBox.x + compareBox.width * 0.7, compareBox.y + compareBox.height * 0.5, { steps: 6 }); await page.mouse.up();
    check(Number(await compare.inputValue()) >= 65, `Dragging compare split did not update it: ${await compare.inputValue()}`);
    const toast = page.locator('.toast'); if (await toast.count()) await toast.locator('button').click().catch(() => {});
    await page.getByRole('button', { name: '应用到画布', exact: true }).click();
    await page.getByRole('dialog', { name: '重绘候选对比', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '画笔', exact: true }).click();
    check(await page.locator('.mobile-inpaint-actions button').filter({ hasText: '隐藏蒙版' }).count() === 1, 'Mask was not restored when switching to brush after candidate application');
    check(await page.locator('.mobile-inpaint-layer').count() === 1, 'Applying a candidate did not create a result layer');
    pass('前后对比拖界、应用候选后切画笔恢复蒙版');

    // A gateway batch is prepared for review, then cancelled; no generation request is sent.
    await page.getByLabel('新版重绘生成渠道', { exact: true }).selectOption('synthetic-gateway');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: '生成重绘候选', exact: true }).click();
    await diagnoseGenerationClick('gateway-batch-after-click');
    const confirm = page.getByRole('alertdialog'); await confirm.waitFor({ timeout: 15000 });
    check((await mockState()).gatewayGenerate === 0, 'Gateway generate IPC fired before batch confirmation');
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await page.waitForTimeout(250);
    const gatewayCounts = await mockState();
    check(gatewayCounts.prepare === 1 && gatewayCounts.gatewayGenerate === 0 && gatewayCounts.cancel === 1, `Gateway cancel did not stop before generate: ${JSON.stringify(gatewayCounts)}`);
    pass('网关整批确认后取消：generate 请求数为 0', gatewayCounts);
    await capture('gateway-batch-cancelled');

    // Capture the requested 1280/dark and 1440/light composition through real settings UI.
    await windowHandle.evaluate(win => { if (win.isMaximized()) win.unmaximize(); win.setContentSize(1280, 900); });
    await page.waitForFunction(() => Math.abs(innerWidth - 1280) <= 2 && Math.abs(innerHeight - 900) <= 2, undefined, { timeout: 8000 });
    await page.getByRole('button', { name: '管理渠道', exact: true }).click();
    await page.locator('.settings-modal').waitFor();
    await page.locator('.settings-nav button').filter({ hasText: '外观' }).click();
    const themeTrigger = page.locator('.settings-form').first().locator('button.select-menu-trigger').first();
    await themeTrigger.click(); await page.getByRole('option', { name: '深色', exact: true }).click();
    await page.locator('html.theme-dark').waitFor({ state: 'attached', timeout: 5000 });
    await page.locator('.settings-modal header button').click(); await page.locator('.settings-modal').waitFor({ state: 'detached' });
    await capture('1280-dark');
    await windowHandle.evaluate(win => win.setContentSize(1440, 950));
    await page.waitForFunction(() => Math.abs(innerWidth - 1440) <= 2 && Math.abs(innerHeight - 950) <= 2, undefined, { timeout: 8000 });
    await page.getByRole('button', { name: '管理渠道', exact: true }).click(); await page.locator('.settings-modal').waitFor();
    await page.locator('.settings-nav button').filter({ hasText: '外观' }).click();
    const themeTrigger2 = page.locator('.settings-form').first().locator('button.select-menu-trigger').first();
    await themeTrigger2.click(); await page.getByRole('option', { name: '浅色', exact: true }).click();
    // Light mode is represented by the absence of .theme-dark in App.tsx.
    await page.waitForFunction(() => !document.documentElement.classList.contains('theme-dark'), undefined, { timeout: 5000 });
    await page.locator('.settings-modal header button').click(); await page.locator('.settings-modal').waitFor({ state: 'detached' });
    await capture('1440-light');
    const finalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, theme: document.documentElement.classList.contains('theme-dark') ? 'dark' : 'light', themeClass: document.documentElement.className }));
    check(screenshots.some(item => item.file === '05-1280-dark.png' && Math.abs(item.viewport.width - 1280) <= 2 && Math.abs(item.viewport.height - 900) <= 2 && item.viewport.theme === 'dark'), '1280x900 dark screenshot was captured at another viewport or theme');
    check(screenshots.some(item => item.file === '06-1440-light.png' && Math.abs(item.viewport.width - 1440) <= 2 && Math.abs(item.viewport.height - 950) <= 2 && item.viewport.theme === 'light'), '1440x950 light screenshot was captured at another viewport or theme');
    pass('1280 深色 / 1440 浅色布局截图', { viewport: finalViewport });

    if (process.argv.includes('--r4-entries')) {
      await exerciseR4Entries();
    }
    }
    check(rendererErrors.length === 0, `Renderer page errors: ${rendererErrors.join('\n')}`);
  } catch (error) {
    errors.push(error.stack || String(error));
    console.error(error.stack || error);
    await diagnoseGenerationClick('failure-catch');
    try {
      if (page && windowHandle) {
        const frame = await windowHandle.evaluate(async win => {
          const png = await win.webContents.capturePage();
          return { data: png.toPNG().toString('base64'), size: png.getSize(), bounds: win.getBounds() };
        });
        const file = 'failure.png';
        fs.writeFileSync(path.join(evidence, file), Buffer.from(frame.data, 'base64'));
        failureScreenshot = { file, size: frame.size, bounds: frame.bounds };
      }
    } catch (captureError) {
      failureScreenshot = { error: String(captureError) };
    }
  } finally {
    let worker = null;
    let navigationTrace = null;
    let runtime = null;
    if (app) {
      try { worker = await page.evaluate(() => window.__mobileWorkerTrace || null); } catch {}
      try { navigationTrace = await page.evaluate(() => window.__mobileInpaintNavTrace || null); } catch {}
      try { runtime = await app.evaluate(({ app, screen }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch, userData: app.getPath('userData'), display: screen.getPrimaryDisplay() })); } catch {}
      try { Object.assign(mockCounts, await mockState()); } catch {}
      try { await app.close(); } catch {}
    }
    const blockedFile = path.join(run, 'blocked-network.json');
    const report = { generatedAt: new Date().toISOString(), desktop, run, evidence, syntheticEvidence: true, noRealAPIOrPayment: true,
      runtime, checks: results, errors, browserConsoleErrors: [...new Set(errors.filter(e => !e.includes('Error:')))], screenshots, failureScreenshot, generationDiagnostics, worker, navigationTrace, mockCounts,
      blockedNetwork: fs.existsSync(blockedFile) ? JSON.parse(fs.readFileSync(blockedFile, 'utf8')) : [],
      limits: ['All provider account, quote, generation, picker, and gateway IPC was explicitly mocked.', 'The renderer was the existing packaged Vite dist; this was not a real NovelAI or gateway backend acceptance test.', 'Source image and candidate pixels were synthetic; no user files or secrets were read.', 'Physical touch, long-running performance, and release-installed packaging were not tested.'] };
    fs.writeFileSync(path.join(evidence, 'gui-integration-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: errors.length === 0, report: path.join(evidence, 'gui-integration-report.json'), passed: results.length, failed: errors.length, worker, mockCounts, screenshots }, null, 2));
    if (errors.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
