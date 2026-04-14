export interface WikiPage {
  slug: string;
  title: string;
  path: string;
  summary: string;
  contentHash: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WikiLink {
  sourceSlug: string;
  targetSlug: string;
  context: string;
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
  entries: ChangesetEntry[];
  preHead: string;
  postHead: string | null;
  status: 'pending' | 'applied' | 'rolled-back';
}

