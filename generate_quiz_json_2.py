#!/usr/bin/env python3
"""
Quiz JSON generator (v2) for the new Quizz -> QuizzSet -> Question schema.

Walks the repository, finds markdown files with "quiz" in the name, and writes
JSON siblings shaped for the updated Prisma schema (quizz with sets).

Usage examples:
  python3 generate_quiz_json_2.py
  python3 generate_quiz_json_2.py --root . --output . --overwrite
  python3 generate_quiz_json_2.py --dry-run --match python
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    output_root = Path(args.output or root).resolve()
    created_by_id = args.created_by or os.getenv(
        "SEED_USER_ID", "cmiz68drf00004eqsc3izonqy")

    quiz_files = find_quiz_files(root, args.match)
    if not quiz_files:
        print("No quiz markdown files found.")
        return

    summary = {"files": len(quiz_files), "written": 0,
               "skipped": 0, "warnings": 0}
    for quiz_file in quiz_files:
        rel_path = quiz_file.relative_to(root)
        try:
            content = quiz_file.read_text(encoding="utf-8")
            parsed = parse_quiz_markdown(
                content=content,
                source_path=str(rel_path),
                created_by_id=created_by_id,
                root=root,
            )
            output_file = build_output_path(
                root=root, output_root=output_root, source_path=str(rel_path)
            )

            if not args.overwrite and not args.dry_run and output_file.exists():
                summary["skipped"] += 1
                print(f"Skipping existing file: {output_file}")
                continue

            if args.dry_run:
                print(f"Would write: {output_file}")
            else:
                output_file.parent.mkdir(parents=True, exist_ok=True)
                output_file.write_text(json.dumps(
                    parsed, indent=2), encoding="utf-8")
                set_count = len(parsed["quizz"]["sets"])
                question_count = sum(len(s["questions"])
                                     for s in parsed["quizz"]["sets"])
                print(
                    f"Wrote {output_file} ({set_count} set(s), {question_count} question(s))")

            summary["written"] += 0 if args.dry_run else 1
            summary["warnings"] += len(parsed["meta"]["warnings"])
            for warn in parsed["meta"]["warnings"]:
                print(f"[{rel_path}] {warn}")
        except Exception as exc:  # pylint: disable=broad-except
            summary["warnings"] += 1
            print(f"Failed to parse {rel_path}: {exc}")

    print("-----")
    print(
        f"Processed {summary['files']} files | "
        f"Written: {summary['written']} | "
        f"Skipped: {summary['skipped']} | "
        f"Warnings: {summary['warnings']}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate JSON quiz payloads (Quizz -> QuizzSet -> Question) from markdown files."
    )
    parser.add_argument("--root", default=".", help="Root folder to scan.")
    parser.add_argument(
        "--output",
        default=None,
        help="Output folder base (defaults to the same as --root).",
    )
    parser.add_argument("--overwrite", action="store_true",
                        help="Rewrite existing JSON files.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Do not write files.")
    parser.add_argument(
        "--match",
        default=None,
        help="Only process files whose path contains this substring.",
    )
    parser.add_argument(
        "--created-by",
        dest="created_by",
        default=None,
        help="createdById to set on quizzes (default: SEED_USER_ID or 'cmiz68drf00004eqsc3izonqy').",
    )
    return parser.parse_args()


def find_quiz_files(root: Path, keyword: str | None) -> list[Path]:
    results: list[Path] = []
    skip_dirs = {".git", "node_modules", ".next", ".turbo"}
    for path in root.rglob("*quiz*.md"):
        if any(part in skip_dirs for part in path.parts):
            continue
        if keyword and keyword not in str(path):
            continue
        results.append(path)
    return sorted(results)


def parse_quiz_markdown(
    content: str, source_path: str, created_by_id: str, root: Path
) -> Dict[str, Any]:
    lines = content.splitlines()
    title = None
    intro_lines: list[str] = []
    question_blocks: list[dict] = []
    current_block: dict | None = None
    in_questions = False

    for line in lines:
        if title is None and line.startswith("## "):
            title = line.replace("##", "", 1).strip()
            continue

        if line.startswith("#### "):
            in_questions = True
            if current_block:
                question_blocks.append(current_block)
            current_block = {"heading": line.replace(
                "####", "", 1).strip(), "body": []}
            continue

        if not in_questions:
            intro_lines.append(line)
        elif current_block is not None:
            current_block["body"].append(line)

    if current_block:
        question_blocks.append(current_block)

    description = " ".join(intro_lines).strip() or f"Seeded from {source_path}"
    quizz_id = stable_id("quiz", source_path)
    language = derive_language_from_filename(source_path)
    set_id = stable_id("set", source_path, language)
    slug = slugify(title or build_title_from_path(source_path))

    questions = []
    warnings: list[str] = []
    rel_dir = Path(source_path).parent.as_posix()

    for idx, block in enumerate(question_blocks):
        parsed = parse_question_block(block, quizz_id, set_id, idx, rel_dir)
        if not parsed["correctAnswer"]:
            warnings.append(
                f"Question {idx + 1} has no marked correct answers")
        if not parsed["options"]:
            warnings.append(f"Question {idx + 1} has no options")
        questions.append(parsed)

    return {
        "quizz": {
            "id": quizz_id,
            "slug": slug,
            "createdById": created_by_id,
            "sets": [
                {
                    "id": set_id,
                    "language": language,
                    "title": title or build_title_from_path(source_path),
                    "description": description,
                    "questions": questions,
                }
            ],
        },
        "meta": {
            "source": source_path,
            "languages": [language],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "warnings": warnings,
        },
    }


def parse_question_block(
    block: dict, quizz_id: str, set_id: str, question_index: int, rel_dir: str
) -> dict:
    option_re = re.compile(r"^\s*[-*+]\s*\[( |x|X)\]\s*(.+)$")
    question_lines: list[str] = []
    trailing_lines: list[str] = []
    options: list[str] = []
    correct: list[str] = []
    attachments: list[dict] = []
    inside_options = False
    inside_code = False

    heading_text = strip_question_number(block["heading"])

    for line in block["body"]:
        if line.strip().startswith("```"):
            inside_code = not inside_code

        for match in re.finditer(r"!\[[^\]]*]\(([^)]+)\)", line):
            attachments.append(
                {
                    "id": stable_id("attachment", quizz_id, question_index, match.group(1)),
                    "url": normalize_attachment_url(match.group(1), rel_dir),
                    "type": "question",
                }
            )

        option_match = None if inside_code else option_re.match(line)
        if option_match:
            inside_options = True
            text = option_match.group(2).strip()
            options.append(text)
            if option_match.group(1).lower() == "x":
                correct.append(text)
            continue

        if not inside_options:
            question_lines.append(line)
        else:
            trailing_lines.append(line)

    hint_lines: list[str] = []
    explanation_lines: list[str] = []
    for line in trailing_lines:
        trimmed = line.strip()
        if not trimmed:
            continue
        if re.match(r"^hint[:\-]?\s*", trimmed, re.IGNORECASE):
            hint_lines.append(
                re.sub(r"^hint[:\-]?\s*", "", trimmed, flags=re.IGNORECASE))
        else:
            explanation_lines.append(trimmed)

    extra_question = "\n".join(q for q in question_lines if q.strip()).strip()
    question_text_parts = [heading_text]
    if extra_question:
        question_text_parts.append(extra_question)

    nature = "ChooseMany" if len(correct) > 1 else "ChooseOne"
    answer_text = "; ".join(correct) if correct else None

    return {
        "id": stable_id("question", quizz_id, question_index, heading_text),
        "question": "\n".join(question_text_parts).strip(),
        "answer": answer_text,
        "explanation": "\n".join(explanation_lines).strip() or None,
        "hint": "\n".join(hint_lines).strip() or None,
        "correctAnswer": correct,
        "options": options,
        "nature": nature,
        "attachments": attachments,
        "setId": set_id,
        "quizzId": quizz_id,
    }


def normalize_attachment_url(url: str, rel_dir: str) -> str:
    trimmed = url.strip()
    if not trimmed:
        return url
    if trimmed.startswith(("http://", "https://", "~", "/")):
        return trimmed
    clean = trimmed.lstrip("./").lstrip("/")
    prefix = f"~/{rel_dir}/" if rel_dir else "~/"
    return (prefix + clean).replace("//", "/")


def strip_question_number(text: str) -> str:
    match = re.match(r"^(?:[A-Za-zÀ-ÿ?¿¡']*\s*)?\d+\.?\s*(.*)$", text.strip())
    return match.group(1).strip() if match and match.group(1) else text.strip()


def derive_language_from_filename(file_path: str) -> str:
    base = Path(file_path).name
    match = re.search(
        r"-quiz[-.]([a-z]{2}(?:-[A-Za-z]{2})?)", base, re.IGNORECASE)
    return match.group(1).lower() if match else "en"


def build_title_from_path(source_path: str) -> str:
    folder = source_path.split(os.sep)[0]
    return " ".join(part.capitalize() for part in re.split(r"[-_]", folder))


def build_output_path(root: Path, output_root: Path, source_path: str) -> Path:
    rel_dir = Path(source_path).parent
    base_name = Path(source_path).stem
    target_dir = output_root / rel_dir
    return target_dir / f"{base_name}.json"


def slugify(text: str) -> str:
    slug = re.sub(r"\+", " plus ", text.lower())
    slug = re.sub(r"#", " sharp ", slug)
    slug = re.sub(r"&", " and ", slug)
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return re.sub(r"-{2,}", "-", slug)


def stable_id(*parts: object) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(str(part or "").encode("utf-8"))
        h.update(b"|")
    return h.hexdigest()[:24]


if __name__ == "__main__":
    main()
