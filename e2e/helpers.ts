import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';

/**
 * Start a test from a pristine project: close whatever the server has open and delete the footage folder's
 * `.cutroom` (the sequence persists there — that is the feature, so tests must reset it explicitly).
 */
export async function resetProject(request: APIRequestContext): Promise<void> {
  await request.post('/api/project/close');
  await fs.rm(path.join(process.env.E2E_FOOTAGE!, '.cutroom'), { recursive: true, force: true });
  await fs.rm(path.join(process.env.E2E_FOOTAGE!, 'uploads'), { recursive: true, force: true });
}
