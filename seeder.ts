import path from 'path';
import { promises as fs } from 'fs';

type SeedConfig = {
  root: string;
  endpoint: string;
  match?: string | null;
  dryRun: boolean;
};

type SeedResult = {
  file: string;
  status: 'ok' | 'failed' | 'dry-run';
  detail?: string;
};

/**
 * Upload quiz JSON files as multipart/form-data to the seed API.
 * - Finds every "*quiz*.json" (optionally filtered with --match).
 * - Normalizes attachment URLs so they are rooted from "~/" for the API.
 * - Sends each file as the "file" field to the configured endpoint.
 *
 * Examples:
 *   npx ts-node seeder.ts
 *   npx ts-node seeder.ts --match python --endpoint http://localhost/api/seed
 *   npx ts-node seeder.ts --dry-run
 */
async function main() {
  ensureRuntimeSupport();
  const config = parseArgs(process.argv.slice(2));

  const files = await findQuizJsonFiles(config.root, config.match ?? undefined);
  if (!files.length) {
    console.warn('No quiz JSON files found.');
    return;
  }

  console.info(`Found ${files.length} file(s). Posting to ${config.endpoint}`);
  const results: SeedResult[] = [];

  for (const filePath of files) {
    const result = await seedFile(filePath, config);
    results.push(result);

    const prefix =
      result.status === 'ok' ? '[ok]' : result.status === 'dry-run' ? '[dry]' : '[fail]';
    const suffix = result.detail ? ` - ${result.detail}` : '';
    console.log(`${prefix} ${result.file}${suffix}`);
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  console.info(
    `Done. Uploaded: ${ok} | Failed: ${failed} | Dry-run: ${config.dryRun ? 'yes' : 'no'}`,
  );

  if (failed > 0 && !config.dryRun) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): SeedConfig {
  const config: SeedConfig = {
    root: process.cwd(),
    endpoint: 'http://localhost:3000/api/seed',
    match: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        config.root = path.resolve(argv[++i]);
        break;
      case '--endpoint':
        config.endpoint = argv[++i];
        break;
      case '--match':
        config.match = argv[++i];
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      default:
        console.warn(`Unknown argument ignored: ${arg}`);
    }
  }

  return config;
}

async function seedFile(filePath: string, config: SeedConfig): Promise<SeedResult> {
  const relPath = path.relative(config.root, filePath);
  const absRoot = path.resolve(config.root).split(path.sep).join('/');
  const tildePath = path.posix.join(absRoot, relPath.split(path.sep).join('/'));

  try {
    // const raw = await fs.readFile(filePath, { encoding: 'utf8' });
    const raw = await fs.readFile(filePath, { encoding: 'utf-8' });
    const parsed = JSON.parse(raw);
    const attachmentUpdates = normalizeAttachmentUrls(parsed, filePath, config.root);
    const serialized = JSON.stringify(parsed, null, 2);

    if (config.dryRun) {
      return {
        file: tildePath,
        status: 'dry-run',
        detail: attachmentUpdates
          ? `attachment urls normalized: ${attachmentUpdates}`
          : 'no attachment changes',
      };
    }

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([serialized], { type: 'application/json' }),
      path.basename(filePath),
    );
    formData.append('path', tildePath);

    const response = await fetch(config.endpoint, {
      method: 'POST',
      body: formData,
      headers: [
        [
          'Authorization',
          'Bearer eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..LSG8wt3C-7YGI3b6.3V7cCFa9A_1OLp59ee_a6U1IhXC36But15SqUkjBk6HV1gyKyweMezC8H-5CSNPI713cXmRA1_aNcCP0K_H7sV5wNKoEEUhdo16_aw3APLh2SJLs79MksNhnBNxYa9zqpKvB1RLDT3Ove6Y5UTB_mBGcLFy4Y8nnE68hdjjXZ6h0zSyeQLw2nweoBXM3HImju9x6ze67A6kuNZZwwxbUvPKHD5iR967MT82XjJO-AiYk6l0Y.QTZl_s-thuhiEs-dNGzD6A',
        ],
      ],
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${response.statusText} ${bodyText}`.trim());
    }

    return {
      file: tildePath,
      status: 'ok',
      detail: attachmentUpdates ? `attachment urls normalized: ${attachmentUpdates}` : undefined,
    };
  } catch (error) {
    return {
      file: tildePath,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function findQuizJsonFiles(root: string, keyword?: string): Promise<string[]> {
  const results: string[] = [];
  const skip = new Set(['.git', '.github', '.vscode', 'node_modules']);

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const hasCombined = entries.some((entry) => entry.isFile() && entry.name === 'quizz.json');

    for (const entry of entries) {
      if (skip.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (hasCombined && lower !== 'quizz.json') continue;
        if (lower.endsWith('.json') && lower.includes('quiz')) {
          if (keyword && !fullPath.includes(keyword)) continue;
          results.push(fullPath);
        }
      }
    }
  }

  await walk(path.resolve(root));
  return results.sort((a, b) => a.localeCompare(b));
}

function normalizeAttachmentUrls(payload: any, filePath: string, root: string): number {
  if (!payload || typeof payload !== 'object') return 0;
  const baseDir = path.dirname(filePath);
  const relDir = path.relative(root, baseDir);
  const relParts = relDir ? relDir.split(path.sep).filter(Boolean) : [];
  const absRoot = path.resolve(root).split(path.sep).join('/');

  const normalizeList = (questions: any[]): number => {
    if (!Array.isArray(questions)) return 0;
    let localChanges = 0;
    for (const question of questions) {
      if (!question || !Array.isArray(question.attachments)) continue;

      question.attachments = question.attachments.map((attachment: any) => {
        if (!attachment || typeof attachment.url !== 'string') return attachment;

        const trimmed = attachment.url.trim();
        if (!trimmed) return attachment;

        const isAbsolute =
          /^https?:\/\//i.test(trimmed) ||
          trimmed.startsWith('~') ||
          trimmed.startsWith('/') ||
          trimmed.startsWith(absRoot);

        if (isAbsolute) {
          return trimmed === attachment.url ? attachment : { ...attachment, url: trimmed };
        }

        const clean = trimmed.replace(/^\.?\//, '');
        const normalized = path.posix.join(absRoot, ...relParts, clean);

        if (normalized !== attachment.url) {
          localChanges += 1;
          return { ...attachment, url: normalized };
        }

        return attachment;
      });
    }
    return localChanges;
  };

  let changes = 0;
  if (Array.isArray(payload?.quizz?.sets)) {
    for (const set of payload.quizz.sets) {
      changes += normalizeList(set?.questions);
    }
  } else {
    changes += normalizeList(payload?.quizz?.questions);
  }

  return changes;
}

function ensureRuntimeSupport() {
  const missing = [];
  if (typeof fetch !== 'function') missing.push('fetch');
  if (typeof FormData === 'undefined') missing.push('FormData');
  if (missing.length) {
    throw new Error(
      `This script requires Node 18+ with ${missing.join(' and ')} available globally.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
