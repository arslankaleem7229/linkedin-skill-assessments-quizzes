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
  const tildePath = `/Users/arslankaleem/Workspace/Junk/linkedin-skill-assessments-quizzes/${relPath.split(path.sep).join('/')}`;

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
          'Bearer eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..5whTfLS_ktyWpp7I.9vyqtBAA_kCWfeObiZZHyanX-05zUNNDcW5JrrEVtn1_IEM9nPc-5G8DhAQN3bRX1mMXcNCfPyqvaH_J4t7MoWJtJync1wVm2cgQ9vwxRuy17hCo-1XrRk1_xbuIQ8imWASgkkgrOh0AezadTCbXJ8HCQN7kU6r0oWMRHZWR2E3xU4URgde_2Ge9nqpJqvuZMFU5V-_tP-2eUjjgcQ8rX0XMV6YaTTw8QDeoEI-jx0V2cF140GSs.fGPnYSl4aeXMz0WRZhkZBg',
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
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
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
  const questions = payload?.quizz?.questions;
  if (!Array.isArray(questions)) return 0;

  const baseDir = path.dirname(filePath);
  const relDir = path.relative(root, baseDir);
  const relParts = relDir ? relDir.split(path.sep).filter(Boolean) : [];
  let changes = 0;

  for (const question of questions) {
    if (!question || !Array.isArray(question.attachments)) continue;

    question.attachments = question.attachments.map((attachment: any) => {
      if (!attachment || typeof attachment.url !== 'string') return attachment;

      const trimmed = attachment.url.trim();
      if (!trimmed) return attachment;

      const isAbsolute =
        /^https?:\/\//i.test(trimmed) ||
        trimmed.startsWith('/Users/arslankaleem/Workspace/Junk/linkedin-skill-assessments-quizzes');
      if (isAbsolute) {
        return trimmed === attachment.url ? attachment : { ...attachment, url: trimmed };
      }

      const clean = trimmed.replace(/^\.?\//, '');
      const normalized = path.posix.join(
        '/Users/arslankaleem/Workspace/Junk/linkedin-skill-assessments-quizzes',
        ...relParts,
        clean,
      );

      if (normalized !== attachment.url) {
        changes += 1;
        return { ...attachment, url: normalized };
      }

      return attachment;
    });
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
