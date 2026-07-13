import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { fetchUrlSource } from '@/server/sources/url-fetcher';
import { validateUrlList, ingestUrlBatch } from '@/server/sources/url-ingest';
import {
  acquireSubjectWriteLease,
  persistSourceAndEnqueueIngest,
  SubjectWriteLeaseError,
} from '@/server/sources/source-ingest-transaction';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  try {
    const contentType = request.headers.get('content-type') ?? '';

    let filename: string;
    let content: Buffer | string;
    let bodyForSubject: unknown = null;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;

      if (!file) {
        return NextResponse.json(
          { error: 'No file provided in form data' },
          { status: 400 }
        );
      }

      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.` },
          { status: 413 }
        );
      }

      filename = (formData.get('filename') as string | null) ?? file.name;
      if (!filename) {
        return NextResponse.json(
          { error: 'No filename provided' },
          { status: 400 }
        );
      }

      const arrayBuffer = await file.arrayBuffer();
      content = Buffer.from(arrayBuffer);

      // Subject can be supplied via form fields too
      const formSubjectId = formData.get('subjectId');
      const formSubjectSlug = formData.get('subjectSlug');
      if (typeof formSubjectId === 'string' || typeof formSubjectSlug === 'string') {
        bodyForSubject = {
          subjectId: typeof formSubjectId === 'string' ? formSubjectId : undefined,
          subjectSlug: typeof formSubjectSlug === 'string' ? formSubjectSlug : undefined,
        };
      }
    } else {
      const body = await request.json() as {
        text?: string;
        filename?: string;
        urls?: unknown;
        subjectId?: string;
        subjectSlug?: string;
      };

      // ── URL 批量分支：与 text 互斥 ──────────────────────────────
      if (body.urls !== undefined) {
        if (body.text !== undefined) {
          return NextResponse.json(
            { error: 'Provide either "urls" or "text", not both' },
            { status: 400 },
          );
        }
        const validated = validateUrlList(body.urls);
        if ('error' in validated) {
          return NextResponse.json({ error: validated.error }, { status: 400 });
        }
        const resolution = resolveSubjectFromRequest(request, { body });
        if (resolution.error) return resolution.error;
        const { subject } = resolution;
        const lease = acquireSubjectWriteLease(subject.id);

        const results = await ingestUrlBatch(validated.urls, {
          fetchSource: (url) => fetchUrlSource(url),
          persist: (filename, content, url) => {
            const result = persistSourceAndEnqueueIngest({
              subject,
              lease,
              filename,
              content,
              originUrl: url,
            });
            return { sourceId: result.sourceId, jobId: result.job.id };
          },
        });

        const anySuccess = results.some((r) => r.jobId);
        return NextResponse.json(
          anySuccess
            ? { results, subjectId: subject.id, subjectSlug: subject.slug }
            : { error: 'All URLs failed', results },
          { status: anySuccess ? 202 : 422 },
        );
      }

      const { text, filename: jsonFilename } = body;

      if (!text || typeof text !== 'string') {
        return NextResponse.json(
          { error: 'Missing or invalid "text" field in JSON body' },
          { status: 400 }
        );
      }
      if (!jsonFilename || typeof jsonFilename !== 'string') {
        return NextResponse.json(
          { error: 'Missing or invalid "filename" field in JSON body' },
          { status: 400 }
        );
      }

      filename = jsonFilename;
      content = text;
      bodyForSubject = body;
    }

    const resolution = resolveSubjectFromRequest(request, { body: bodyForSubject });
    if (resolution.error) return resolution.error;
    const { subject } = resolution;

    const lease = acquireSubjectWriteLease(subject.id);
    const { sourceId, job } = persistSourceAndEnqueueIngest({
      subject,
      lease,
      filename,
      content,
    });

    return NextResponse.json(
      { jobId: job.id, sourceId, subjectId: subject.id, subjectSlug: subject.slug },
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SubjectWriteLeaseError) {
      return NextResponse.json(
        { error: `Ingest conflict: ${message}`, code: error.code },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: `Ingest failed: ${message}` },
      { status: 500 }
    );
  }
}
