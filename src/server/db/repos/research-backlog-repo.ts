import { randomUUID } from 'crypto';
import { getRawDb } from '../client';
import { normalizeResearchQuestion } from '@/lib/research-question';
import type { ResearchBacklogEntry } from '@/lib/contracts';

interface RawRow {
  id: string;
  subject_id: string;
  question: string;
  source: string;
  status: string;
  research_job_id: string | null;
  created_at: string;
}

function toDomain(r: RawRow): ResearchBacklogEntry {
  return {
    id: r.id,
    subjectId: r.subject_id,
    question: r.question,
    source: r.source as ResearchBacklogEntry['source'],
    status: r.status as ResearchBacklogEntry['status'],
    researchJobId: r.research_job_id,
    createdAt: r.created_at,
  };
}

/**
 * 创建一条待研究问题；同 subject 内已存在归一化后相同问题的 open 项则不重复插入（返回已存在项）。
 */
export function create(
  subjectId: string,
  question: string,
  source: ResearchBacklogEntry['source'],
): ResearchBacklogEntry {
  const sqlite = getRawDb();
  const normalized = normalizeResearchQuestion(question);

  const rows = sqlite
    .prepare(`SELECT * FROM research_backlog WHERE subject_id = ? AND status = 'open'`)
    .all(subjectId) as RawRow[];
  const existing = rows.find((r) => normalizeResearchQuestion(r.question) === normalized);
  if (existing) return toDomain(existing);

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO research_backlog (id, subject_id, question, source, status, research_job_id, created_at)
       VALUES (?, ?, ?, ?, 'open', NULL, ?)`,
    )
    .run(id, subjectId, question, source, createdAt);
  return { id, subjectId, question, source, status: 'open', researchJobId: null, createdAt };
}

export function listForSubject(
  subjectId: string,
  status?: ResearchBacklogEntry['status'],
): ResearchBacklogEntry[] {
  const sqlite = getRawDb();
  const rows = status
    ? (sqlite
        .prepare(`SELECT * FROM research_backlog WHERE subject_id = ? AND status = ? ORDER BY created_at DESC`)
        .all(subjectId, status) as RawRow[])
    : (sqlite
        .prepare(`SELECT * FROM research_backlog WHERE subject_id = ? ORDER BY created_at DESC`)
        .all(subjectId) as RawRow[]);
  return rows.map(toDomain);
}

export function getById(id: string): ResearchBacklogEntry | null {
  const row = getRawDb().prepare(`SELECT * FROM research_backlog WHERE id = ?`).get(id) as RawRow | undefined;
  return row ? toDomain(row) : null;
}

export function updateStatus(
  id: string,
  status: ResearchBacklogEntry['status'],
  researchJobId?: string,
): ResearchBacklogEntry | null {
  const sqlite = getRawDb();
  if (researchJobId !== undefined) {
    sqlite
      .prepare(`UPDATE research_backlog SET status = ?, research_job_id = ? WHERE id = ?`)
      .run(status, researchJobId, id);
  } else {
    sqlite.prepare(`UPDATE research_backlog SET status = ? WHERE id = ?`).run(status, id);
  }
  return getById(id);
}
