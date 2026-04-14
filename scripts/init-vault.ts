/**
 * Vault initialization script.
 *
 * Usage: npx tsx scripts/init-vault.ts
 *
 * Creates the vault directory structure, seeds initial markdown files,
 * initializes a git repository inside the vault, and makes an initial commit.
 *
 * Idempotent — existing files and directories are never overwritten.
 * The git repository is only initialized when it does not already exist.
 */

import fs from 'fs';
import path from 'path';
import simpleGit from 'simple-git';

// ---------------------------------------------------------------------------
// Resolve vault path
// ---------------------------------------------------------------------------

const vaultPath = path.resolve(process.env.VAULT_PATH || './data/vault');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`  Created directory: ${path.relative(process.cwd(), dirPath)}/`);
  }
}

function writeFileIfAbsent(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`  Created file:      ${path.relative(process.cwd(), filePath)}`);
  } else {
    console.log(`  Skipped (exists):  ${path.relative(process.cwd(), filePath)}`);
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Directory structure
// ---------------------------------------------------------------------------

const dirs = [
  vaultPath,
  path.join(vaultPath, 'raw'),
  path.join(vaultPath, 'wiki'),
  path.join(vaultPath, 'schema'),
  path.join(vaultPath, '.llm-wiki', 'sources'),
];

// ---------------------------------------------------------------------------
// File contents
// ---------------------------------------------------------------------------

const now = isoNow();

const indexMd = `---
title: Index
created: ${now}
updated: ${now}
tags: [meta]
sources: []
---

# Wiki Index

Welcome to your LLM Wiki. Start by ingesting a source document.
`;

const logMd = `---
title: Change Log
created: ${now}
updated: ${now}
tags: [meta]
sources: []
---

# Change Log

All wiki changes are recorded here.
`;

const wikiRulesMd = `---
title: Wiki Rules
created: ${now}
updated: ${now}
tags: [meta]
---

# Wiki Conventions

## Page Format

Every wiki page is a Markdown file with YAML frontmatter.

## Frontmatter Requirements

All pages must include the following frontmatter fields:

| Field     | Type            | Description                                      |
|-----------|-----------------|--------------------------------------------------|
| \`title\`   | string          | Human-readable page title                        |
| \`created\` | ISO 8601 string | Date the page was first created                  |
| \`updated\` | ISO 8601 string | Date the page was last modified                  |
| \`tags\`    | string[]        | Topic labels (lowercase, hyphen-separated)       |
| \`sources\` | string[]        | List of source document IDs that informed this page |

Example:

\`\`\`yaml
---
title: My Topic
created: 2024-01-01T00:00:00.000Z
updated: 2024-01-02T00:00:00.000Z
tags: [overview, architecture]
sources: [doc-abc123, doc-def456]
---
\`\`\`

## Wikilink Syntax

Use double-bracket wikilinks to cross-reference pages:

\`\`\`
[[page-slug]]
[[page-slug|Display Text]]
\`\`\`

Page slugs are lowercase, hyphen-separated versions of the page title.

## Section Guidelines

- Use ATX-style headings (\`#\`, \`##\`, \`###\`).
- Top-level heading (\`#\`) must match the \`title\` frontmatter field.
- Keep sections focused; prefer multiple short pages over one long page.
- Include a brief introductory paragraph before the first sub-heading.

## Source Attribution

When information comes from a specific source document, cite it inline:

\`\`\`
This concept originates from the design specification (see [[source:doc-abc123]]).
\`\`\`
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\nInitializing wiki vault at: ${vaultPath}\n`);

  // 1. Create directory structure
  console.log('Creating directory structure...');
  for (const dir of dirs) {
    ensureDir(dir);
  }

  // 2. Seed initial files
  console.log('\nCreating initial files...');
  writeFileIfAbsent(path.join(vaultPath, 'wiki', 'index.md'), indexMd);
  writeFileIfAbsent(path.join(vaultPath, 'wiki', 'log.md'), logMd);
  writeFileIfAbsent(path.join(vaultPath, 'schema', 'wiki-rules.md'), wikiRulesMd);

  // 3. Initialize git repo in vault (never touches parent repo)
  const gitDir = path.join(vaultPath, '.git');
  const git = simpleGit({ baseDir: vaultPath });

  if (!fs.existsSync(gitDir)) {
    console.log('\nInitializing git repository inside vault...');
    await git.init();
  } else {
    console.log('\nGit repository already initialized — skipping init.');
  }

  // Set local user config so commits have an author
  await git.addConfig('user.name', 'LLM Wiki', false, 'local');
  await git.addConfig('user.email', 'wiki@llm-wiki.local', false, 'local');

  // 4. Stage and commit (only if there are changes)
  await git.add('.');
  const status = await git.status();

  if (status.staged.length > 0) {
    const result = await git.commit('Initialize wiki vault');
    const sha = result.commit || '';
    console.log(`\nInitial commit created: ${sha}`);
  } else {
    console.log('\nNothing to commit — vault already up to date.');
  }

  // 5. Summary
  console.log('\nVault structure:');
  console.log(`  ${path.relative(process.cwd(), vaultPath)}/`);
  console.log('  ├── raw/                    # immutable source documents');
  console.log('  ├── wiki/');
  console.log('  │   ├── index.md            # wiki index page');
  console.log('  │   └── log.md              # change log');
  console.log('  ├── schema/');
  console.log('  │   └── wiki-rules.md       # conventions for the LLM');
  console.log('  └── .llm-wiki/');
  console.log('      └── sources/            # source metadata JSON files');
  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Vault initialization failed:', err);
  process.exit(1);
});
