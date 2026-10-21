import { createHash, randomUUID } from 'node:crypto';
import type { GatewayProfile, GatewayProfileInput, GatewayProtocol } from '../../src/gateway-workbench';

interface Cipher {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface StoredProfile {
  id: string;
  name: string;
  protocol: GatewayProtocol;
  baseUrl: string;
  encryptedToken: string;
  secretRevision: string;
}
interface GatewayTokenEnvelope {
  kind: 'worldpainter.gateway-token';
  version: 1;
  profileId: string;
  protocol: GatewayProtocol;
  baseUrl: string;
  secretRevision: string;
  token: string;
}
const TOKEN_ENVELOPE_KIND = 'worldpainter.gateway-token';
export interface GatewayVaultDocument {
  version: 1;
  selectedId?: string;
  profiles: StoredProfile[];
}

export function gatewayCipherAvailable(cipher: Cipher): boolean {
  try {
    return cipher.isEncryptionAvailable() && cipher.getSelectedStorageBackend?.() !== 'basic_text';
  } catch { return false; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Gateways always receive a fixed absolute request path; profiles store only a service origin. */
export function normalizeGatewayBaseUrl(protocol: unknown, raw: unknown): { protocol: GatewayProtocol; baseUrl: string } {
  if (protocol !== 'gateway7877' && protocol !== 'ikun') throw new Error('请选择 7877 或 ikun 网关。');
  if (typeof raw !== 'string' || raw.trim().length < 8 || raw.length > 2048 || raw.includes('\\')) {
    throw new Error('请输入 HTTP(S) 网关根地址。');
  }
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('网关地址格式无效。'); }
  if (!url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:')) {
    throw new Error('请填写不含路径、账号、查询参数的 HTTP(S) 网关根地址。');
  }
  return { protocol, baseUrl: url.origin };
}

function profileId(protocol: GatewayProtocol, baseUrl: string) {
  return `gateway_${createHash('sha256').update(`${protocol}\n${baseUrl}`).digest('hex').slice(0, 24)}`;
}

function validateDocument(value: unknown): GatewayVaultDocument {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 100 ||
      Object.keys(value).some((key) => !['version', 'selectedId', 'profiles'].includes(key))) {
    throw new Error('网关凭据库格式无效；原文件已保留。');
  }
  const ids = new Set<string>();
  const profiles: StoredProfile[] = value.profiles.map((raw) => {
    if (!isObject(raw) || Object.keys(raw).some((key) => !['id', 'name', 'protocol', 'baseUrl', 'encryptedToken', 'secretRevision'].includes(key)) ||
        typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.baseUrl !== 'string' ||
        typeof raw.encryptedToken !== 'string' || typeof raw.secretRevision !== 'string' ||
        (raw.protocol !== 'gateway7877' && raw.protocol !== 'ikun')) {
      throw new Error('网关凭据库记录无效；原文件已保留。');
    }
    const normalized = normalizeGatewayBaseUrl(raw.protocol, raw.baseUrl);
    if (raw.id !== profileId(normalized.protocol, normalized.baseUrl) || ids.has(raw.id) ||
        raw.name.trim().length < 1 || raw.name.length > 120 || raw.encryptedToken.length > 100_000 ||
        raw.secretRevision.length > 80) throw new Error('网关凭据库记录无效；原文件已保留。');
    ids.add(raw.id);
    return { id: raw.id, name: raw.name.trim(), protocol: normalized.protocol, baseUrl: normalized.baseUrl,
      encryptedToken: raw.encryptedToken, secretRevision: raw.secretRevision };
  });
  if (value.selectedId !== undefined && (typeof value.selectedId !== 'string' || !ids.has(value.selectedId))) {
    throw new Error('网关凭据库选择项无效；原文件已保留。');
  }
  return { version: 1, ...(value.selectedId ? { selectedId: value.selectedId } : {}), profiles };
}

/** Gateway credentials have their own encrypted file and key namespace, separate from NovelAI accounts. */
export class GatewayWorkbenchVault {
  private document: GatewayVaultDocument;
  constructor(document: GatewayVaultDocument, private readonly cipher: Cipher,
    private readonly persist: (document: GatewayVaultDocument) => void) {
    this.document = validateDocument(document);
  }

  private encryptToken(profile: Pick<StoredProfile, 'id' | 'protocol' | 'baseUrl' | 'secretRevision'>, token: string) {
    const envelope: GatewayTokenEnvelope = {
      kind: TOKEN_ENVELOPE_KIND,
      version: 1,
      profileId: profile.id,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      secretRevision: profile.secretRevision,
      token,
    };
    return this.cipher.encryptString(JSON.stringify(envelope)).toString('base64');
  }

  list(): GatewayProfile[] {
    return this.document.profiles.map(({ id, name, protocol, baseUrl }) => ({
      id, name, protocol, baseUrl, selected: this.document.selectedId === id,
    }));
  }

  add(raw: GatewayProfileInput): GatewayProfile[] {
    if (!isObject(raw) || typeof raw.name !== 'string' || raw.name.trim().length < 1 || raw.name.length > 120 ||
        /[\r\n\u0000-\u001f]/.test(raw.name) || typeof raw.token !== 'string' || !raw.token.trim() ||
        raw.token.length > 16_384 || /[\r\n]/.test(raw.token)) throw new Error('请填写网关名称和有效令牌。');
    if (!gatewayCipherAvailable(this.cipher)) throw new Error('系统凭据加密不可用，未保存网关令牌。');
    const normalized = normalizeGatewayBaseUrl(raw.protocol, raw.baseUrl);
    const id = profileId(normalized.protocol, normalized.baseUrl);
    const secretRevision = randomUUID();
    const nextProfile: StoredProfile = {
      id,
      name: raw.name.trim(),
      ...normalized,
      secretRevision,
      encryptedToken: this.encryptToken({ id, ...normalized, secretRevision }, raw.token.trim()),
    };
    const profiles = this.document.profiles.filter((profile) => profile.id !== id);
    profiles.push(nextProfile);
    const next = { version: 1 as const, selectedId: id, profiles };
    this.persist(next);
    this.document = next;
    return this.list();
  }

  select(id: unknown): GatewayProfile[] {
    if (typeof id !== 'string' || !this.document.profiles.some((profile) => profile.id === id)) {
      throw new Error('请先添加该网关凭据。');
    }
    const next = { ...this.document, selectedId: id };
    this.persist(next);
    this.document = next;
    return this.list();
  }

  remove(id: unknown): GatewayProfile[] {
    if (typeof id !== 'string') throw new Error('网关档案无效。');
    const profiles = this.document.profiles.filter((profile) => profile.id !== id);
    if (profiles.length === this.document.profiles.length) throw new Error('网关档案不存在。');
    const next: GatewayVaultDocument = { version: 1, profiles,
      ...(this.document.selectedId === id ? {} : this.document.selectedId ? { selectedId: this.document.selectedId } : {}) };
    this.persist(next);
    this.document = next;
    return this.list();
  }

  bind(id: string) {
    const profile = this.document.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error('网关档案已删除，请重新选择。');
    if (!gatewayCipherAvailable(this.cipher)) throw new Error('系统凭据解密不可用。');
    let plaintext = '';
    try { plaintext = this.cipher.decryptString(Buffer.from(profile.encryptedToken, 'base64')); }
    catch { throw new Error('网关令牌无法解密；原凭据文件已保留。'); }
    let envelope: unknown;
    try { envelope = JSON.parse(plaintext); } catch { /* schema-1 stored the token directly */ }
    let token: string;
    if (isObject(envelope) && envelope.kind === TOKEN_ENVELOPE_KIND) {
      if (envelope.version !== 1 || envelope.profileId !== profile.id || envelope.protocol !== profile.protocol ||
          envelope.baseUrl !== profile.baseUrl || envelope.secretRevision !== profile.secretRevision || typeof envelope.token !== 'string') {
        throw new Error('网关令牌与当前协议或服务根地址不匹配；原凭据文件已保留。');
      }
      token = envelope.token;
    } else {
      // Upgrade legacy encrypted tokens before use. If persistence fails, fail
      // closed instead of making an unbound credential request.
      token = plaintext;
      if (!token.trim() || /[\r\n]/.test(token)) throw new Error('网关令牌无效。');
      const next: GatewayVaultDocument = {
        ...this.document,
        profiles: this.document.profiles.map((item) => item.id === profile.id
          ? { ...item, encryptedToken: this.encryptToken(item, token.trim()) }
          : item),
      };
      this.persist(next);
      this.document = next;
    }
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('网关令牌无效。');
    return { profile: { id: profile.id, name: profile.name, protocol: profile.protocol,
      baseUrl: profile.baseUrl, selected: this.document.selectedId === profile.id }, token, secretRevision: profile.secretRevision };
  }
}
