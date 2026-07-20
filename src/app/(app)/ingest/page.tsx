import type { Metadata } from 'next';
import { IngestWorkbench } from '../_components/ingest-workbench';
import { getServerI18n } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return { title: t('ingest.title') };
}

export default function IngestPage() {
  return <IngestWorkbench />;
}
