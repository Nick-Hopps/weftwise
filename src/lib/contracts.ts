export type SubjectId = string;

export interface Subject {
  id: SubjectId;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface WikiPage {
  slug: string;
  title: string;
  path: string;
  summary: string;
  contentHash: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  subjectId: SubjectId;
}

export interface WikiLink {
  sourceSlug: string;
  targetSlug: string;
  context: string;
  subjectId: SubjectId;
  targetSubjectId: SubjectId;
}

export interface Job {
  id: string;
  type: 'ingest' | 'lint' | 'save-to-wiki';
  status: 'pending' | 'running' | 'completed' | 'failed';
  paramsJson: string;
  resultJson: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  attemptCount: number;
  subjectId: SubjectId | null;
}

export interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  message: string;
  dataJson: string | null;
  createdAt: string;
}

export interface Source {
  id: string;
  filename: string;
  contentHash: string;
  parsedAt: string | null;
  metadataJson: string;
  subjectId: SubjectId;
}

export interface IngestResult {
  pagesCreated: string[];
  pagesUpdated: string[];
  linksAdded: number;
  commitSha: string;
}

export interface QueryResult {
  answer: string;
  citations: { pageSlug: string; excerpt: string }[];
  savedAsPage: string | null;
}

export interface LintFinding {
  type: 'broken-link' | 'orphan' | 'missing-frontmatter' | 'stale-source' | 'contradiction' | 'missing-crossref' | 'coverage-gap';
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string;
  description: string;
  suggestedFix: string | null;
}

export interface ChangesetEntry {
  action: 'create' | 'update' | 'delete';
  path: string;
  content: string | null;
}

export interface Changeset {
  id: string;
  jobId: string;
  subjectId: SubjectId;
  subjectSlug: string;
  entries: ChangesetEntry[];
  preHead: string;
  postHead: string | null;
  status: 'pending' | 'applied' | 'rolled-back';
}
