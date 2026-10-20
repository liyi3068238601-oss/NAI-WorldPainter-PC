// Audit-only launcher. No renderer state, navigation, or IPC is simulated.
const path = require('node:path');
const fs = require('node:fs');
const { app, session } = require('electron');
const root = path.resolve(__dirname, '..');
// Match normal `electron .` resource resolution despite the audit entry file.
app.setAppPath(root);
const auditRoot = process.env.UIUX_AUDIT_ROOT;
if (!auditRoot || !path.resolve(auditRoot).startsWith(path.join(root, '.tmp') + path.sep)) throw Error('Audit root must be inside desktop/.tmp');
const blocked = [];
function allow(value) { try { const u = new URL(typeof value === 'string' ? value : value?.href || `${value?.protocol || 'https:'}//${value?.hostname || value?.host || ''}`); return ['file:', 'data:', 'blob:', 'nai-local:'].includes(u.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; } }
function deny(value) { blocked.push({at: new Date().toISOString(), target: String(value?.hostname || value?.host || value).slice(0, 160)}); fs.writeFileSync(path.join(auditRoot, 'blocked-network.json'), JSON.stringify(blocked, null, 2)); throw Error('UIUX_OFFLINE: external network disabled'); }
for (const protocol of ['http', 'https']) { const mod = require(`node:${protocol}`); for (const method of ['request', 'get']) { const original = mod[method]; mod[method] = function(value, ...args) { if (!allow(value)) return deny(value); return original.call(this, value, ...args); }; } }
const originalFetch = global.fetch;
global.fetch = function(value, ...args) { if (!allow(value?.url || value)) return Promise.reject(new Error('UIUX_OFFLINE: external fetch disabled')); return originalFetch.call(this, value, ...args); };
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({cancel: !allow(details.url)})));
require(path.join(root, 'dist-electron/electron/bootstrap.js'));
