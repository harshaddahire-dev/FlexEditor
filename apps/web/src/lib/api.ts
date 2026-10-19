import type {
  EditRequest,
  ExtensionsInfo,
  McpServerInfo,
  McpServerInput,
  EditResponse,
  FfmpegStatus,
  HistoryState,
  FsListing,
  HealthResponse,
  AgentSettings,
  ChatState,
  ChatTurn,
  ModelInfo,
  ProviderInfo,
  ProviderInput,
  ProviderTestResult,
  Media,
  ProjectResponse,
  ProjectSettings,
  ProxyCodec,
  ProxySettingsResponse,
  RecentProject,
  ScanReport,
  Sequence,
} from '@cutroom/core';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', 'Cannot reach the Cutroom server. Is `pnpm dev` still running?', 0);
  }
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(e.error ?? 'http_error', e.message ?? `Request failed (${res.status})`, res.status, e.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  health: () => request<HealthResponse>('GET', '/api/health'),
  recheckFfmpeg: () => request<FfmpegStatus>('POST', '/api/health/recheck'),
  listDir: (path?: string) => request<FsListing>('GET', `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  recent: () => request<RecentProject[]>('GET', '/api/recent'),
  forgetRecent: (path: string) => request<{ ok: true }>('DELETE', `/api/recent?path=${encodeURIComponent(path)}`),
  openProject: (path: string) => request<ProjectResponse>('POST', '/api/project/open', { path }),
  getProject: () => request<ProjectResponse>('GET', '/api/project'),
  closeProject: () => request<{ ok: true }>('POST', '/api/project/close'),
  rescan: (includeIgnored = false) => request<ScanReport>('POST', '/api/project/rescan', { includeIgnored }),
  updateSettings: (patch: Partial<Pick<ProjectSettings, 'width' | 'height' | 'fps'>>) =>
    request<ProjectSettings>('PATCH', '/api/project/settings', patch),
  removeMedia: (id: string) => request<{ ok: true }>('DELETE', `/api/media/${id}`),
  reproxy: (id: string) => request<Media>('POST', `/api/media/${id}/reproxy`),
  relink: (id: string, path: string, force = false) => request<Media>('POST', `/api/media/${id}/relink`, { path, force }),
  relinkCandidates: (id: string) => request<string[]>('GET', `/api/media/${id}/relink-candidates`),
  getSequence: () => request<{ revision: number; sequence: Sequence; history: HistoryState }>('GET', '/api/sequence'),
  edit: (req: EditRequest) => request<EditResponse>('POST', '/api/edit', req),
  undo: () => request<{ revision: number; label: string | null }>('POST', '/api/history/undo'),
  redo: () => request<{ revision: number; label: string | null }>('POST', '/api/history/redo'),
  setProxyCodec: (codec: ProxyCodec) => request<ProxySettingsResponse>('PUT', '/api/settings/proxy-codec', { codec }),
  analyze: (id: string) => request<Media>('POST', `/api/media/${id}/analyze`),
  extensions: () => request<ExtensionsInfo>('GET', '/api/extensions'),
  reloadExtensions: () => request<ExtensionsInfo>('POST', '/api/extensions/reload'),
  setSkillEnabled: (name: string, enabled: boolean) => request<ExtensionsInfo>('PUT', `/api/extensions/skills/${encodeURIComponent(name)}`, { enabled }),
  setPluginEnabled: (id: string, enabled: boolean) => request<ExtensionsInfo>('PUT', `/api/extensions/plugins/${encodeURIComponent(id)}`, { enabled }),
  saveMcp: (input: McpServerInput, id?: string) => request<McpServerInfo>(id ? 'PUT' : 'POST', id ? `/api/extensions/mcp/${id}` : '/api/extensions/mcp', input),
  setMcpEnabled: (id: string, enabled: boolean) => request<McpServerInfo>('POST', `/api/extensions/mcp/${id}/enabled`, { enabled }),
  testMcp: (id: string) => request<McpServerInfo>('POST', `/api/extensions/mcp/${id}/test`),
  removeMcp: (id: string) => request<{ ok: true }>('DELETE', `/api/extensions/mcp/${id}`),
  providers: () => request<{ providers: ProviderInfo[]; agent: AgentSettings }>('GET', '/api/providers'),
  addProvider: (input: ProviderInput) => request<ProviderInfo>('POST', '/api/providers', input),
  updateProvider: (id: string, input: Partial<ProviderInput>) => request<ProviderInfo>('PATCH', `/api/providers/${id}`, input),
  removeProvider: (id: string) => request<{ ok: true }>('DELETE', `/api/providers/${id}`),
  testProvider: (id: string) => request<ProviderTestResult>('POST', `/api/providers/${id}/test`),
  providerModels: (id: string, refresh = false) => request<{ models: ModelInfo[]; error?: string }>('GET', `/api/providers/${id}/models${refresh ? '?refresh=1' : ''}`),
  setAgentSettings: (s: AgentSettings) => request<AgentSettings>('PUT', '/api/agent/settings', s),
  agentChat: () => request<ChatState>('GET', '/api/agent/chat'),
  clearAgentChat: () => request<{ ok: true }>('DELETE', '/api/agent/chat'),
  startRun: (prompt: string) => request<{ runId: string }>('POST', '/api/agent/runs', { prompt }),
  approveRun: (runId: string, requestId: string, decision: 'approve' | 'deny' | 'always') => request<{ ok: true }>('POST', `/api/agent/runs/${runId}/approve`, { requestId, decision }),
  cancelRun: (runId: string) => request<{ ok: true }>('POST', `/api/agent/runs/${runId}/cancel`),
  reviewRun: (runId: string, action: 'accept' | 'undo' | 'dismiss') => request<ChatTurn>('POST', `/api/agent/runs/${runId}/${action}`),
  cancelJob: (id: string) => request<{ canceled: boolean }>('POST', `/api/jobs/${id}/cancel`),
};

export type MediaFileKind = 'original' | 'proxy' | 'audio' | 'poster';
export const mediaUrl = (id: string, kind: MediaFileKind, version?: string | number): string =>
  `/api/media/${id}/file/${kind}${version === undefined ? '' : `?v=${version}`}`;

/** PUT a file to the project's uploads folder, reporting byte progress. */
export function uploadFile(
  file: File,
  relPath: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Media> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/project/upload?path=${encodeURIComponent(relPath)}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onerror = () => reject(new ApiError('network', 'Upload failed: lost connection to the server.', 0));
    xhr.onabort = () => reject(new ApiError('aborted', 'Upload cancelled.', 0));
    xhr.onload = () => {
      const data = xhr.responseText ? safeJson(xhr.responseText) : null;
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as Media);
      const e = (data ?? {}) as { error?: string; message?: string };
      reject(new ApiError(e.error ?? 'upload_failed', e.message ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
