import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as conversationsRepo from '@/server/db/repos/conversations-repo';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  const { id } = await params;
  const conversation = conversationsRepo.getConversation(id);
  if (!conversation || conversation.subjectId !== subject!.id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  return NextResponse.json({
    conversation,
    messages: conversationsRepo.listMessages(id),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { subject, error } = resolveSubjectFromRequest(request, { required: true, body });
  if (error) return error;

  const title =
    typeof (body as { title?: unknown }).title === 'string'
      ? (body as { title: string }).title.trim()
      : '';
  if (title.length === 0) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const { id } = await params;
  const conversation = conversationsRepo.getConversation(id);
  if (!conversation || conversation.subjectId !== subject!.id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  conversationsRepo.renameConversation(id, title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { subject, error } = resolveSubjectFromRequest(request, { required: true, body });
  if (error) return error;

  const { id } = await params;
  const conversation = conversationsRepo.getConversation(id);
  if (!conversation || conversation.subjectId !== subject!.id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  conversationsRepo.deleteConversation(id);
  return NextResponse.json({ ok: true });
}
