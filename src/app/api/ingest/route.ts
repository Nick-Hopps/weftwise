import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { saveRawSource } from '@/server/sources/source-store';
import { requireAuth } from '@/server/middleware/auth';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  // C2 fix: check authentication on mutation endpoint
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const contentType = request.headers.get('content-type') ?? '';

    let filename: string;
    let content: Buffer | string;

    if (contentType.includes('multipart/form-data')) {
      // Handle file upload via multipart/form-data
      const formData = await request.formData();
      const file = formData.get('file') as File | null;

      if (!file) {
        return NextResponse.json(
          { error: 'No file provided in form data' },
          { status: 400 }
        );
      }

      // H5 fix: reject files larger than 50MB
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
    } else {
      // Handle JSON body: { text: string, filename: string }
      const body = await request.json() as { text?: string; filename?: string };
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
    }

    // Save raw source to vault
    const { id: sourceId } = saveRawSource(filename, content);

    // Enqueue ingest job
    const job = queue.enqueue('ingest', { sourceId, filename });

    return NextResponse.json(
      { jobId: job.id, sourceId },
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `Ingest failed: ${message}` },
      { status: 500 }
    );
  }
}
