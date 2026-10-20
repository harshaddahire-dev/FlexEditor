import { randomUUID } from 'node:crypto';
import { type AgentSettings, DEFAULT_AGENT_SETTINGS, PROVIDER_PRESETS, type ProviderInfo, type ProviderInput, type ProviderKind } from '@cutroom/core';
import type { AppDb } from '../db';
import type { SecretBox } from './secrets';

interface Stored {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  sealedKey?: string;
  keyHint?: string;
  defaultModel?: string;
  createdAt: number;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

function normaliseUrl(kind: ProviderKind, raw: string | undefined): string {
  const preset = PROVIDER_PRESETS[kind];
  const url = (raw?.trim() || preset.baseUrl).replace(/\/+$/, '');
  if (!preset.editableUrl && raw && url !== preset.baseUrl) throw new ProviderError('bad_request', `${preset.label} always uses ${preset.baseUrl}.`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError('bad_request', 'The base URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ProviderError('bad_request', 'The base URL must start with http:// or https://.');
  return url;
}

/** Providers (keys sealed) and the agent's chosen model/effort/mode, persisted in the app database. */
export class ProviderStore {
  constructor(
    private readonly db: AppDb,
    private readonly box: SecretBox,
  ) {}

  private all(): Stored[] {
    return this.db.getSetting<Stored[]>('providers') ?? [];
  }
  private save(list: Stored[]): void {
    this.db.setSetting('providers', list);
  }

  private info(s: Stored): ProviderInfo {
    return { id: s.id, kind: s.kind, name: s.name, baseUrl: s.baseUrl, hasKey: !!s.sealedKey, keyHint: s.keyHint, defaultModel: s.defaultModel, createdAt: s.createdAt };
  }

  list(): ProviderInfo[] {
    return this.all().map((s) => this.info(s));
  }

  get(id: string): ProviderInfo | undefined {
    const s = this.all().find((x) => x.id === id);
    return s ? this.info(s) : undefined;
  }

  /** The decrypted key — for server-side calls only; never put this in a response. */
  keyOf(id: string): string | undefined {
    const s = this.all().find((x) => x.id === id);
    return s?.sealedKey ? (this.box.open(s.sealedKey) ?? undefined) : undefined;
  }

  add(input: ProviderInput): ProviderInfo {
    if (!(input.kind in PROVIDER_PRESETS)) throw new ProviderError('bad_request', `Unknown provider kind "${input.kind}".`);
    const key = input.apiKey?.trim();
    const s: Stored = {
      id: `prov_${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      name: input.name?.trim() || PROVIDER_PRESETS[input.kind].label,
      baseUrl: normaliseUrl(input.kind, input.baseUrl),
      defaultModel: input.defaultModel?.trim() || undefined,
      createdAt: Date.now(),
    };
    if (key) {
      s.sealedKey = this.box.seal(key);
      s.keyHint = key.slice(-4);
    }
    this.save([...this.all(), s]);
    return this.info(s);
  }

  update(id: string, input: Partial<ProviderInput>): ProviderInfo {
    const list = this.all();
    const s = list.find((x) => x.id === id);
    if (!s) throw new ProviderError('no_such_provider', 'No such provider.', 404);
    if (input.name !== undefined) s.name = input.name.trim() || PROVIDER_PRESETS[s.kind].label;
    if (input.baseUrl !== undefined) s.baseUrl = normaliseUrl(s.kind, input.baseUrl);
    if (input.defaultModel !== undefined) s.defaultModel = input.defaultModel.trim() || undefined;
    if (input.apiKey !== undefined) {
      const key = input.apiKey.trim();
      if (key) {
        s.sealedKey = this.box.seal(key);
        s.keyHint = key.slice(-4);
      } else {
        delete s.sealedKey;
        delete s.keyHint;
      }
    }
    this.save(list);
    return this.info(s);
  }

  remove(id: string): void {
    const list = this.all();
    if (!list.some((x) => x.id === id)) throw new ProviderError('no_such_provider', 'No such provider.', 404);
    this.save(list.filter((x) => x.id !== id));
    const a = this.agent();
    if (a.providerId === id) this.setAgent({ ...a, providerId: undefined, model: undefined });
  }

  agent(): AgentSettings {
    return { ...DEFAULT_AGENT_SETTINGS, ...(this.db.getSetting<Partial<AgentSettings>>('agentSettings') ?? {}) };
  }

  setAgent(next: AgentSettings): AgentSettings {
    if (next.providerId && !this.get(next.providerId)) throw new ProviderError('no_such_provider', 'No such provider.', 404);
    this.db.setSetting('agentSettings', next);
    return this.agent();
  }
}
