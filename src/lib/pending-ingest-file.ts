/**
 * Ephemeral, client-only handoff of a picked file from the dashboard "Choose a
 * file" hero to the dedicated `/ingest` workspace.
 *
 * A `File` can't be serialized into a URL or a persisted store, so we stash it
 * in a module variable that survives SPA navigation (`router.push` doesn't
 * reload the page) and is consumed exactly once by the workbench on mount.
 */
let pendingFile: File | null = null;

export function setPendingIngestFile(file: File): void {
  pendingFile = file;
}

/** Returns the stashed file (if any) and clears it, so it's consumed once. */
export function takePendingIngestFile(): File | null {
  const file = pendingFile;
  pendingFile = null;
  return file;
}
