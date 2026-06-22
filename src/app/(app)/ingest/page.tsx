import type { Metadata } from 'next';
import { IngestWorkbench } from '../_components/ingest-workbench';

export const metadata: Metadata = {
  title: 'Ingest a source · Agentic Wiki',
};

export default function IngestPage() {
  return <IngestWorkbench />;
}
