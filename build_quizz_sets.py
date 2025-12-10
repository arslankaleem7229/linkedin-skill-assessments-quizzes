#!/usr/bin/env python3
"""
Consolidate per-language quiz JSON files into a single file per quiz that
matches the Quizz -> QuizzSet -> Question schema.

Inputs:
  - Existing "*quiz*.json" files generated from the markdown quizzes.
  - Ignores any existing "quizz.json" so it can be re-run safely.

Outputs:
  - One "quizz.json" per quiz directory, with:
      quizz: { id, slug, createdById, sets: [ { id, language, title,
             description, questions: [...] } ] }
      meta: { languages, sources, generatedAt, warnings }

Usage examples:
  python build_quizz_sets.py
  python build_quizz_sets.py --match python
  python build_quizz_sets.py --overwrite
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

KNOWN_LANGS = ["en", "fr", "es", "it", "ch", "de", "ua", "hi",
               "ptbr", "tr", "pt", "ja", "vi"]
LANG_SUFFIX = re.compile(rf"-({'|'.join(KNOWN_LANGS)})$", re.IGNORECASE)


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    output_root = Path(args.output or root).resolve()
    fallback_created_by = args.created_by or "cmiz68drf00004eqsc3izonqy"

    quiz_files = find_quiz_json_files(root, args.match)
    if not quiz_files:
        print("No quiz JSON files found.")
        return

    grouped = group_by_directory(quiz_files)
    written = 0

    for directory, files in grouped.items():
        rel_dir = directory.relative_to(root)
        output_file = (output_root / rel_dir / "quizz.json")

        if output_file.exists() and not args.overwrite:
            print(f"[skip] {rel_dir}/quizz.json (exists)")
            continue

        try:
            payload = build_payload(
                directory, files, root, fallback_created_by)
            if args.dry_run:
                print(
                    f"[dry] Would write {output_file} ({len(payload['quizz']['sets'])} set(s))")
            else:
                output_file.parent.mkdir(parents=True, exist_ok=True)
                output_file.write_text(json.dumps(
                    payload, indent=2), encoding="utf-8")
                print(
                    f"[ok] {rel_dir}/quizz.json ({len(payload['quizz']['sets'])} set(s))")
            written += 0 if args.dry_run else 1
        except Exception as exc:  # pylint: disable=broad-except
            print(f"[fail] {rel_dir}: {exc}")

    print(f"Done. Wrote {written} file(s).")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build combined quizz.json files per quiz folder.")
    parser.add_argument("--root", default=".", help="Root folder to scan.")
    parser.add_argument("--output", default=None,
                        help="Output root (defaults to --root).")
    parser.add_argument("--match", default=None,
                        help="Only include paths containing this substring.")
    parser.add_argument("--overwrite", action="store_true",
                        help="Rewrite existing quizz.json files.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview without writing.")
    parser.add_argument("--created-by", dest="created_by",
                        default=None,
                        help="Fallback createdById if missing (default: cmiz68drf00004eqsc3izonqy).")
    return parser.parse_args()


def find_quiz_json_files(root: Path, keyword: str | None) -> List[Path]:
    results: List[Path] = []
    skip_dirs = {".git", "node_modules", ".next", ".turbo"}
    for path in root.rglob("*quiz*.json"):
        if path.name == "quizz.json":
            continue
        if any(part in skip_dirs for part in path.parts):
            continue
        if keyword and keyword not in str(path):
            continue
        results.append(path)
    return sorted(results)


def group_by_directory(files: List[Path]) -> Dict[Path, List[Path]]:
    grouped: Dict[Path, List[Path]] = {}
    for file in files:
        directory = file.parent
        grouped.setdefault(directory, []).append(file)
    return grouped


def build_payload(directory: Path, files: List[Path], root: Path, fallback_created_by: str) -> Dict[str, Any]:
    parsed_files: List[Dict[str, Any]] = []
    for file in sorted(files):
        data = json.loads(file.read_text(encoding="utf-8"))
        language = infer_language(
            data.get("meta", {}).get("language"), file.name)
        parsed_files.append({"file": file, "language": language, "data": data})

    base = pick_base(parsed_files)
    quizz_id = base["data"].get("quizz", {}).get(
        "id") or stable_id("quizz", str(directory))
    slug = slugify(base["data"].get(
        "quizz", {}).get("title") or directory.name)
    created_by_id = (
        base["data"].get("quizz", {}).get("createdById")
        or fallback_created_by
    )

    rel_dir = directory.relative_to(root).as_posix()

    sets = []
    for entry in parsed_files:
        set_id = f"{quizz_id}-{entry['language']}"
        questions = []
        for q in entry["data"].get("quizz", {}).get("questions", []):
            questions.append({
                **q,
                "setId": set_id,
                "quizzId": quizz_id,
                "attachments": normalize_attachments(q.get("attachments", []), rel_dir),
                "explanation": q.get("explanation"),
                "hint": q.get("hint"),
            })

        sets.append({
            "id": set_id,
            "language": entry["language"],
            "title": entry["data"].get("quizz", {}).get("title", ""),
            "description": entry["data"].get("quizz", {}).get("description", ""),
            "questions": questions,
        })

    languages = []
    for entry in parsed_files:
        if entry["language"] not in languages:
            languages.append(entry["language"])

    sources = []
    for entry in parsed_files:
        src = entry["data"].get("meta", {}).get("source")
        if src and src not in sources:
            sources.append(src)

    warnings: List[str] = []
    for entry in parsed_files:
        warnings.extend(entry["data"].get("meta", {}).get("warnings", []))

    return {
        "quizz": {
            "id": quizz_id,
            "slug": slug,
            "createdById": created_by_id,
            "sets": sets,
        },
        "meta": {
            "languages": languages,
            "sources": sources,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "warnings": warnings,
        },
    }


def infer_language(meta_language: Any, filename: str) -> str:
    if isinstance(meta_language, str):
        normalized = meta_language.strip().lower()
        if normalized in KNOWN_LANGS:
            return normalized
    match = LANG_SUFFIX.search(filename)
    if match:
        return match.group(1).lower()
    return "en"


def normalize_attachments(attachments: List[Dict[str, Any]], rel_dir: str) -> List[Dict[str, Any]]:
    rel_parts = [p for p in rel_dir.split("/") if p]
    normalized: List[Dict[str, Any]] = []
    for att in attachments:
        if not isinstance(att, dict):
            normalized.append(att)
            continue

        url = att.get("url")
        if not isinstance(url, str):
            normalized.append(att)
            continue

        trimmed = url.strip()
        if not trimmed:
            normalized.append(att)
            continue

        if trimmed.startswith(("http://", "https://", "~", "/")):
            normalized.append({**att, "url": trimmed})
            continue

        clean = trimmed.lstrip("./").lstrip("/")
        parts = ["~"] + rel_parts + [clean]
        normalized.append({**att, "url": "/".join(parts)})

    return normalized


def slugify(text: str) -> str:
    slug = re.sub(r"\+", " plus ", text.lower())
    slug = re.sub(r"#", " sharp ", slug)
    slug = re.sub(r"&", " and ", slug)
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return re.sub(r"-{2,}", "-", slug)


def stable_id(*parts: str) -> str:
    digest = hashlib.sha1("::".join(parts).encode("utf-8")).hexdigest()
    return digest[:24]


if __name__ == "__main__":
    main()
