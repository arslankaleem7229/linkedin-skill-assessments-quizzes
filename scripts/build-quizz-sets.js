#!/usr/bin/env node
/**
 * Consolidate per-language quiz JSON files into a single file per quiz
 * that matches the new Quizz/QuizzSet schema.
 *
 * - Groups files by their top-level directory (one quiz per folder).
 * - Picks the English file (or the first) as the base quizz id/slug/author.
 * - Emits `quizz.json` next to the assets so relative attachment paths remain valid.
 *
 * Usage:
 *   node scripts/build-quizz-sets.js           # writes ./<quiz>/quizz.json
 *   node scripts/build-quizz-sets.js --root .  # optional root override
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const KNOWN_LANGS = [
  'en',
  'fr',
  'es',
  'it',
  'ch',
  'de',
  'ua',
  'hi',
  'ptbr',
  'tr',
  'pt',
  'ja',
  'vi',
];
const LANG_SUFFIX = new RegExp(`-(${KNOWN_LANGS.join('|')})$`, 'i');

async function main() {
  const rootArgIndex = process.argv.indexOf('--root');
  const root = rootArgIndex > -1 ? path.resolve(process.argv[rootArgIndex + 1]) : process.cwd();

  const quizFiles = await collectQuizFiles(root);
  const grouped = groupByDirectory(quizFiles);

  let written = 0;
  for (const [dir, files] of grouped.entries()) {
    const relDir = path.relative(root, dir) || '.';
    try {
      const payload = await buildCombinedPayload({ dir, files, root });
      const outFile = path.join(dir, 'quizz.json');
      await fs.writeFile(outFile, JSON.stringify(payload, null, 2), 'utf8');
      written += 1;
      console.info(`[ok] ${relDir}/quizz.json (${payload.quizz.sets.length} set(s))`);
    } catch (error) {
      console.error(`[fail] ${relDir}:`, error.message);
    }
  }

  console.info(`Done. Wrote ${written} combined file(s).`);
}

async function collectQuizFiles(root) {
  const results = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.git')) continue;
      if (entry.name === 'node_modules') continue;
      if (entry.isFile() && entry.name === 'quizz.json') continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.includes('quiz') && entry.name.endsWith('.json')) {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results;
}

function groupByDirectory(files) {
  const grouped = new Map();
  for (const file of files) {
    const dir = path.dirname(file);
    const list = grouped.get(dir) || [];
    list.push(file);
    grouped.set(dir, list);
  }
  return grouped;
}

async function buildCombinedPayload({ dir, files, root }) {
  const parsedFiles = await Promise.all(
    files.map(async (file) => {
      const raw = await fs.readFile(file, 'utf8');
      const json = JSON.parse(raw);
      const language = inferLanguage(json?.meta?.language, file);
      return { file, language, data: json };
    }),
  );

  parsedFiles.sort((a, b) => a.language.localeCompare(b.language));

  const base = pickBase(parsedFiles);
  const quizzId = base?.data?.quizz?.id || crypto.randomUUID();
  const slug = slugify(base?.data?.quizz?.title) || path.basename(dir);
  const createdById = base?.data?.quizz?.createdById || 'cmiz68drf00004eqsc3izonqy';

  const relDir = path.relative(root, dir);
  const sets = parsedFiles.map((entry) => {
    const setId = `${quizzId}-${entry.language}`;
    const questions = (entry.data?.quizz?.questions || []).map((q) => ({
      ...q,
      setId,
      quizzId,
      attachments: normalizeAttachments(q.attachments || [], relDir, root),
      explanation: q.explanation ?? null,
      hint: q.hint ?? null,
    }));

    return {
      id: setId,
      language: entry.language,
      title: entry.data?.quizz?.title ?? '',
      description: entry.data?.quizz?.description ?? '',
      questions,
    };
  });

  const metaSources = parsedFiles
    .map((p) => p.data?.meta?.source)
    .filter(Boolean)
    .map((src) => src.toString());

  const metaWarnings = parsedFiles
    .flatMap((p) => (Array.isArray(p.data?.meta?.warnings) ? p.data.meta.warnings : []))
    .filter(Boolean);

  return {
    quizz: {
      id: quizzId,
      slug,
      createdById,
      sets,
    },
    meta: {
      languages: parsedFiles.map((p) => p.language),
      sources: metaSources,
      generatedAt: new Date().toISOString(),
      warnings: metaWarnings,
    },
  };
}

function pickBase(parsedFiles) {
  const en = parsedFiles.find((p) => p.language === 'en');
  return en || parsedFiles[0];
}

function inferLanguage(metaLanguage, filePath) {
  if (metaLanguage && typeof metaLanguage === 'string') {
    const normalized = metaLanguage.trim().toLowerCase();
    if (KNOWN_LANGS.includes(normalized)) return normalized;
  }

  const base = path.basename(filePath, '.json');
  const match = base.match(LANG_SUFFIX);
  if (match) return match[1].toLowerCase();

  return 'en';
}

function slugify(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

function normalizeAttachments(attachments, relDir, root) {
  const relParts = relDir ? relDir.split(path.sep).filter(Boolean) : [];
  const basePrefix = path.resolve(root).split(path.sep).join('/');

  return attachments.map((att) => {
    if (!att || typeof att.url !== 'string') return att;
    const trimmed = att.url.trim();
    const isAbsolute =
      /^https?:\/\//i.test(trimmed) ||
      trimmed.startsWith('~') ||
      trimmed.startsWith('/') ||
      trimmed.startsWith(basePrefix);
    if (isAbsolute) return trimmed === att.url ? att : { ...att, url: trimmed };

    const clean = trimmed.replace(/^\.\//, '').replace(/^\//, '');
    const normalized = path.posix.join(basePrefix, ...relParts, clean);
    if (normalized === att.url) return att;
    return { ...att, url: normalized };
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
