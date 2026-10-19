import type {
  FfmpegStatus,
  FsListing,
  HealthResponse,
  Media,
  ProjectResponse,
  ProjectSettings,
  RecentProject,
  ScanReport,
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
  cancelJob: (id: string) => request<{ canceled: boolean }>('POST', `/api/jobs/${id}/cancel`),
};

export type MediaFileKind = 'original' | 'proxy' | 'poster';
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
