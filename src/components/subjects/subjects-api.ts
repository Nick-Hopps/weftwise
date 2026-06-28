import { apiFetch } from '@/lib/api-fetch';
import {
  DEFAULT_AUGMENTATION_LEVEL,
  type AugmentationLevel,
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

export async function deleteSubject(id: string): Promise<void> {
  const res = await apiFetch(`/api/subjects/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res));
}
