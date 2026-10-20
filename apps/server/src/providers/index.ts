import { type ChatEvent, type ChatRequest, type ChatResult, type ModelInfo, type ProviderTestResult } from '@cutroom/core';
import type { AppDb } from '../db';
import { type Conn, LlmError, chat, chatStream, listModels } from './llm';
import { redact, SecretBox } from './secrets';
import { ProviderError, ProviderStore } from './store';

export { LlmError, ProviderError, SecretBox, ProviderStore, redact };

const MODELS_TTL_MS = 10 * 60_000;

/** Providers + the model calls made through them. The agent runtime (step 6) talks to this, never to a key. */
export class ProviderService {
  readonly store: ProviderStore;
  private readonly cache = new Map<string, { at: number; models: ModelInfo[] }>();

  constructor(db: AppDb, keyFile: string) {
    this.store = new ProviderStore(db, new SecretBox(keyFile));
  }

  private conn(id: string): Conn {
    const p = this.store.get(id);
    if (!p) throw new ProviderError('no_such_provider', 'No such provider.', 404);
    return { kind: p.kind, baseUrl: p.baseUrl, key: this.store.keyOf(id) };
  }

  /** Models the provider offers (cached for ten minutes; `refresh` forces a new request). */
  async models(id: string, refresh = false, signal?: AbortSignal): Promise<ModelInfo[]> {
    const hit = this.cache.get(id);
    if (hit && !refresh && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
    const models = (await listModels(this.conn(id), signal)).sort((a, b) => a.id.localeCompare(b.id));
    this.cache.set(id, { at: Date.now(), models });
    return models;
  }

  async test(id: string): Promise<ProviderTestResult> {
    const p = this.store.get(id);
    if (!p) throw new ProviderError('no_such_provider', 'No such provider.', 404);
    if (p.kind !== 'custom' && !p.hasKey) return { ok: false, models: 0, error: 'Add an API key first.' };
    try {
      const models = await this.models(id, true, AbortSignal.timeout(15_000));
      return { ok: true, models: models.length };
    } catch (e) {
      return { ok: false, models: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  forget(id: string): void {
    this.cache.delete(id);
  }

  chat(id: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    return chat(this.conn(id), req, signal);
  }

  stream(id: string, req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    return chatStream(this.conn(id), req, signal);
  }
}
