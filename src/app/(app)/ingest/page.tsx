'use client';

import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import { useJobStream } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import Link from 'next/link';

export default function IngestPage() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [createdPages, setCreatedPages] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [filenameInput, setFilenameInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const { events, status } = useJobStream(jobId);

  async function handleFileUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Please select a file');
      return;
    }
    uploadFile(file);
  }

  async function handleTextSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreatedPages([]);

    if (!textInput.trim()) {
      setError('Please enter some text');
      return;
    }

    setUploading(true);
    try {
      const filename = filenameInput.trim() || `note-${Date.now()}.md`;
      const res = await apiFetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textInput, filename }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Submit failed (${res.status})`);
      }
      const data = await res.json();
      setJobId(data.jobId);
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  const uploadFile = useCallback(async (file: File) => {
    setError(null);
    setCreatedPages([]);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch('/api/ingest', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Upload failed (${res.status})`);
      }
      const data = await res.json();
      setJobId(data.jobId);
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }, [uploadFile]);

  const isProcessing = jobId && status === 'streaming';
  const isDone = status === 'completed';
  const isFailed = status === 'failed';

  // Capture created page slugs from ingest:complete event
  useEffect(() => {
    if (!isDone) return;
    const doneEvent = events.find((e) => e.type === 'ingest:complete');
    const data = doneEvent?.data as { result?: { pagesCreated?: string[] } } | undefined;
    if (data?.result?.pagesCreated) {
      setCreatedPages(data.result.pagesCreated);
    }
  }, [isDone, events]);

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
      <div>
        <Link href="/" className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
          ← Dashboard
        </Link>
        <h1 className="text-3xl font-bold text-zinc-900 dark:text-slate-50 mt-2">
          Ingest Source
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mt-1">
          Upload a file or paste text to add to your wiki.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => setTextMode(false)}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            !textMode
              ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium'
              : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          File Upload
        </button>
        <button
          onClick={() => setTextMode(true)}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            textMode
              ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium'
              : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          }`}
        >
          Paste Text
        </button>
      </div>

      {/* Upload form */}
      {!textMode ? (
        <form onSubmit={handleFileUpload} className="space-y-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
              isDragging
                ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-900/20'
                : 'border-zinc-200 dark:border-zinc-700'
            }`}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".md,.mdx,.txt,.html,.htm,.pdf"
              className="block w-full text-sm text-zinc-500 dark:text-zinc-400
                file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
                file:text-sm file:font-medium
                file:bg-indigo-50 file:text-indigo-700
                dark:file:bg-indigo-900/40 dark:file:text-indigo-300
                file:cursor-pointer hover:file:bg-indigo-100
                dark:hover:file:bg-indigo-900/60"
            />
            <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
              Supported: .md, .txt, .html, .pdf
            </p>
          </div>
          <button
            type="submit"
            disabled={uploading || !!isProcessing}
            className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {uploading ? 'Uploading...' : 'Upload & Ingest'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleTextSubmit} className="space-y-4">
          <input
            type="text"
            placeholder="Filename (optional, e.g. my-notes.md)"
            value={filenameInput}
            onChange={(e) => setFilenameInput(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-slate-50 placeholder:text-zinc-400"
          />
          <textarea
            rows={10}
            placeholder="Paste your text content here..."
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-slate-50 placeholder:text-zinc-400 resize-y"
          />
          <button
            type="submit"
            disabled={uploading || !!isProcessing}
            className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {uploading ? 'Submitting...' : 'Submit & Ingest'}
          </button>
        </form>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Progress */}
      {jobId && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {isDone ? '✅ Ingest Complete' : isFailed ? '❌ Ingest Failed' : '⏳ Processing...'}
            </span>
            <span className="text-xs text-zinc-400 font-mono">{jobId.slice(0, 8)}</span>
          </div>
          <div className="px-4 py-3 space-y-1.5 max-h-64 overflow-y-auto">
            {events.length === 0 && (
              <p className="text-sm text-zinc-400 italic">Waiting for events...</p>
            )}
            {events.map((evt, i) => (
              <div key={i} className="text-sm text-zinc-600 dark:text-zinc-400 flex gap-2">
                <span className="text-zinc-300 dark:text-zinc-600 shrink-0">›</span>
                <span>{(evt.data?.message as string) || evt.type}</span>
              </div>
            ))}
          </div>
          {isDone && (
            <div className="px-4 py-4 border-t border-zinc-100 dark:border-zinc-800 space-y-4">
              {createdPages.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Created Pages</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {createdPages.map((slug) => (
                      <Link
                        key={slug}
                        href={`/wiki/${slug}`}
                        className="flex items-center p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-indigo-600 dark:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors"
                      >
                        {slug}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              <Link href="/" className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
                ← Back to Dashboard
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
