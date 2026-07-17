import { apiFetch } from '@/lib/api-fetch';
import {
  DEFAULT_AUGMENTATION_LEVEL,
  type AugmentationLevel,
  type Subject,
  type SubjectListEntry,
} from '@/lib/contracts';

export interface CreateSubjectPayload {
  slug: string;
  name: string;
  description: string;
  augmentationLevel: AugmentationLevel;
}

export interface PatchSubjectPayload {
  id: string;
  name?: string;
  description?: string;
  augmentationLevel?: AugmentationLevel;
}

export async function fetchSubjects(): Promise<SubjectListEntry[]> {
  const res = await apiFetch('/api/subjects');
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/** 统一解析后端 `{ error }`，回落到 HTTP 状态码。*/
async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${res.status}`;
}

export async function patchSubject(payload: PatchSubjectPayload): Promise<SubjectListEntry> {
  const { id, ...body } = payload;
  const res = await apiFetch(`/api/subjects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function createSubject(payload: CreateSubjectPayload): Promise<SubjectListEntry> {
  const res = await apiFetch('/api/subjects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // POST /api/subjects 仅接受 slug/name/description。
    body: JSON.stringify({
      slug: payload.slug,
      name: payload.name,
      description: payload.description,
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const subject = (await res.json()) as SubjectListEntry;
  // 非默认增益强度：补一次 PATCH（避免改后端 POST schema）。
  if (payload.augmentationLevel !== DEFAULT_AUGMENTATION_LEVEL) {
    return patchSubject({ id: subject.id, augmentationLevel: payload.augmentationLevel });
  }
  return subject;
}

/** 导出下载 URL（浏览器直接导航触发下载，走 cookie 鉴权）。 */
export function subjectExportUrl(id: string): string {
  return `/api/subjects/${id}/export`;
}

export class ImportSubjectError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'ImportSubjectError';
  }
}

export interface ImportSubjectResult {
  subject: Subject;
  stats: { pages: number; sources: number; assets: number };
}

/** 导入归档 zip；slug 冲突时抛 code='slug-conflict'，可换 slug 重试。 */
export async function importSubject(file: File, slug?: string): Promise<ImportSubjectResult> {
  const form = new FormData();
  form.append('file', file);
  if (slug) form.append('slug', slug);
  const res = await apiFetch('/api/subjects/import', { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ImportSubjectError(body.error ?? `HTTP ${res.status}`, body.code);
  }
  return res.json();
}

export async function deleteSubject(id: string): Promise<void> {
  const res = await apiFetch(`/api/subjects/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res));
}
