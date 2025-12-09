#!/usr/bin/env node
/**
 * Quiz JSON generator for Prisma seeding
 *
 * This script walks the repository, finds every quiz markdown file
 * (anything with "quiz" in the filename), and produces a JSON payload
 * that mirrors the Prisma schema shared in the request:
 *   - Quizz -> Question -> Attachment
 *   - Stores one .json file next to each .md file so existing image
 *     folders continue to work without moving assets around.
 *
 * Usage examples:
 *   node scripts/generate-quiz-json.js
 *   node scripts/generate-quiz-json.js --root . --output . --overwrite
 *   node scripts/generate-quiz-json.js --dry-run --match python
 *
 * Flags:
 *   --root <dir>       : folder to scan (default: cwd)
 *   --output <dir>     : base output folder (default: same as --root)
 *   --overwrite        : rewrite existing .json files instead of skipping
 *   --dry-run          : parse and report without writing files
 *   --match <keyword>  : only process files whose path includes the keyword
 *   --created-by <id>  : seed user id (default: SEED_USER_ID env or "seed-user")
 *
 * The JSON file shape is intentionally close to the Prisma models so it
 * can be consumed by a later Prisma seed script without further parsing:
 * {
 *   "quizz": {
 *     "id": "...",
 *     "title": "...",
 *     "description": "...",
 *     "createdById": "...",
 *     "questions": [
 *       {
 *         "id": "...",
 *         "question": "...",
 *         "options": ["..."],
 *         "correctAnswer": ["..."],
 *         "nature": "ChooseOne" | "ChooseMany",
 *         "answer": "...",
 *         "hint": "...",
 *         "explanation": "...",
 *         "attachments": [
 *           { "id": "...", "url": "...", "type": "question" }
 *         ]
 *       }
 *     ]
 *   },
 *   "meta": {
 *     "source": "python/python-quiz.md",
 *     "language": "fr",
 *     "generatedAt": "2024-01-01T00:00:00.000Z"
 *   }
 * }
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const root = path.resolve(config.root ?? process.cwd());
  const outputRoot = path.resolve(config.output ?? root);

  const quizFiles = await findQuizFiles(root, config.match);
  if (!quizFiles.length) {
    console.warn('No quiz markdown files found.');
    return;
  }

  const summary = { written: 0, skipped: 0, warnings: 0, files: quizFiles.length };
  for (const filePath of quizFiles) {
    const relPath = path.relative(root, filePath);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const parsed = parseQuizMarkdown({
        content,
        sourcePath: relPath,
        createdById: config.createdById,
      });

      const outputFile = buildOutputPath({ root, outputRoot, sourcePath: relPath });
      if (!config.overwrite && !(config.dryRun)) {
        const exists = await fileExists(outputFile);
        if (exists) {
          summary.skipped += 1;
          console.info(`Skipping existing file: ${outputFile}`);
          continue;
        }
      }

      const serialized = JSON.stringify(parsed, null, 2);
      if (config.dryRun) {
        console.info(`Would write: ${outputFile}`);
      } else {
        await fs.mkdir(path.dirname(outputFile), { recursive: true });
        await fs.writeFile(outputFile, serialized, 'utf8');
        console.info(`Wrote ${outputFile} (${parsed.quizz.questions.length} questions)`);
      }

      summary.written += config.dryRun ? 0 : 1;
      summary.warnings += parsed.meta.warnings.length;
      for (const warn of parsed.meta.warnings) {
        console.warn(`[${relPath}] ${warn}`);
      }
    } catch (error) {
      summary.warnings += 1;
      console.error(`Failed to parse ${relPath}:`, error.message);
    }
  }

  console.info('-----');
  console.info(`Processed ${summary.files} files`);
  console.info(`Written: ${summary.written} | Skipped: ${summary.skipped} | Warnings: ${summary.warnings}`);
}

/**
 * Parse CLI arguments without external dependencies.
 */
function parseArgs(argv) {
  const config = {
    root: process.cwd(),
    output: null,
    overwrite: false,
    dryRun: false,
    match: null,
    createdById: process.env.SEED_USER_ID || 'seed-user',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        config.root = argv[++i];
        break;
      case '--output':
        config.output = argv[++i];
        break;
      case '--overwrite':
        config.overwrite = true;
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--match':
        config.match = argv[++i];
        break;
      case '--created-by':
        config.createdById = argv[++i];
        break;
      default:
        console.warn(`Unknown argument ignored: ${arg}`);
    }
  }

  return config;
}

/**
 * Recursively walk the repository to find quiz markdown files.
 * A quiz file is any .md with "quiz" in the filename.
 */
async function findQuizFiles(root, keyword) {
  const results = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.git')) continue;
      if (entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase().includes('quiz')) {
        if (keyword && !fullPath.includes(keyword)) continue;
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results.sort();
}

/**
 * Parse a quiz markdown file into a JSON shape that mirrors the Prisma schema.
 */
function parseQuizMarkdown({ content, sourcePath, createdById }) {
  const warnings = [];
  const lines = content.split(/\r?\n/);

  let title = null;
  const introLines = [];
  const questionBlocks = [];
  let currentQuestion = null;
  let inQuestions = false;

  for (const line of lines) {
    if (!title && line.startsWith('## ')) {
      title = line.replace(/^##\s*/, '').trim();
      continue;
    }

    if (line.startsWith('#### ')) {
      inQuestions = true;
      if (currentQuestion) {
        questionBlocks.push(currentQuestion);
      }
      currentQuestion = {
        heading: line.replace(/^####\s*/, '').trim(),
        body: [],
      };
      continue;
    }

    if (!inQuestions) {
      introLines.push(line);
    } else if (currentQuestion) {
      currentQuestion.body.push(line);
    }
  }

  if (currentQuestion) {
    questionBlocks.push(currentQuestion);
  }

  const description = introLines.join(' ').replace(/\s+/g, ' ').trim() || `Seeded from ${sourcePath}`;
  const quizId = stableId('quiz', sourcePath);

  const questions = questionBlocks.map((block, index) => {
    const parsedQuestion = parseQuestionBlock({
      block,
      quizId,
      questionIndex: index,
    });

    if (!parsedQuestion.correctAnswer.length) {
      warnings.push(`Question ${index + 1} has no marked correct answers`);
    }
    if (!parsedQuestion.options.length) {
      warnings.push(`Question ${index + 1} has no options`);
    }
    return parsedQuestion;
  });

  return {
    quizz: {
      id: quizId,
      title: title || buildTitleFromPath(sourcePath),
      description,
      createdById,
      questions,
    },
    meta: {
      source: sourcePath,
      language: deriveLanguageFromFilename(sourcePath),
      generatedAt: new Date().toISOString(),
      warnings,
    },
  };
}

/**
 * Parse a single question block into a structured object.
 */
function parseQuestionBlock({ block, quizId, questionIndex }) {
  const optionPattern = /^\s*[-*+]\s*\[( |x|X)\]\s*(.+)$/;
  const questionLines = [];
  const trailingLines = [];
  const options = [];
  const correctAnswer = [];
  const attachments = [];
  let insideOptions = false;
  let insideCode = false;

  const baseQuestion = stripQuestionNumber(block.heading);

  for (const line of block.body) {
    if (line.trim().startsWith('```')) {
      insideCode = !insideCode;
    }

    // Collect attachments from inline markdown images.
    for (const match of line.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
      attachments.push({
        id: stableId('attachment', quizId, questionIndex, match[1]),
        url: match[1],
        type: 'question',
      });
    }

    const optionMatch = line.match(optionPattern);
    if (optionMatch && !insideCode) {
      insideOptions = true;
      const text = optionMatch[2].trim();
      options.push(text);
      if (optionMatch[1].toLowerCase() === 'x') {
        correctAnswer.push(text);
      }
      continue;
    }

    if (!insideOptions) {
      questionLines.push(line);
    } else {
      trailingLines.push(line);
    }
  }

  const hintLines = [];
  const explanationLines = [];
  for (const line of trailingLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^hint[:\-]?\s*/i.test(trimmed)) {
      hintLines.push(trimmed.replace(/^hint[:\-]?\s*/i, ''));
    } else {
      explanationLines.push(trimmed);
    }
  }

  const questionTextParts = [baseQuestion];
  const extraQuestionText = questionLines.join('\n').trim();
  if (extraQuestionText) {
    questionTextParts.push(extraQuestionText);
  }

  return {
    id: stableId('question', quizId, questionIndex, block.heading),
    question: questionTextParts.join('\n').trim(),
    answer: correctAnswer.join('; ') || null,
    explanation: explanationLines.join('\n').trim() || null,
    hint: hintLines.join('\n').trim() || null,
    correctAnswer,
    options,
    nature: correctAnswer.length > 1 ? 'ChooseMany' : 'ChooseOne',
    attachments,
  };
}

function stripQuestionNumber(text) {
  // Remove leading tokens like "Q1.", "P2.", "Pregunta 3.", etc.
  const match = text.match(/^(?:[A-Za-zÀ-ÿ?¿¡']*\s*)?\d+\.?\s*(.*)$/);
  if (match && match[1]) {
    return match[1].trim();
  }
  return text.trim();
}

function deriveLanguageFromFilename(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/-quiz[-.]([a-z]{2}(?:-[A-Za-z]{2})?)/i);
  if (match) return match[1];
  return 'en';
}

function buildTitleFromPath(sourcePath) {
  const segments = sourcePath.split(path.sep);
  const folder = segments.length ? segments[0] : 'Quiz';
  return folder
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildOutputPath({ root, outputRoot, sourcePath }) {
  const baseDir = path.dirname(sourcePath);
  const baseName = path.basename(sourcePath, '.md');
  const targetDir = path.join(outputRoot, baseDir);
  return path.join(targetDir, `${baseName}.json`);
}

function stableId(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(String(part || ''));
    hash.update('|');
  }
  return hash.digest('hex').slice(0, 24);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
