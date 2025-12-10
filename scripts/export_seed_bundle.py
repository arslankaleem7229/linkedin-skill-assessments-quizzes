#!/usr/bin/env python3
"""
Prepare a seed bundle for Quizzy Prisma seed data.

Copies quiz markdown, JSON (prefers combined quizz.json), and images folders
from this repo into a seed folder, plus seeder.ts and generate_quiz_json_2.py.

Defaults:
  Source: current repository
  Destination: /Users/arslankaleem/Workspace/Portfolio-Projects/quizzy/prisma/seed

Usage:
  python3 scripts/export_seed_bundle.py
  python3 scripts/export_seed_bundle.py --dest /path/to/prisma/seed --match python
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

DEFAULT_DEST = Path("/Users/arslankaleem/Workspace/Portfolio-Projects/quizzy/prisma/seed")
SKIP_DIRS = {".git", ".github", "node_modules", ".vscode", ".next", ".turbo", "scripts", "assets"}


def main() -> None:
    args = parse_args()
    source_root = Path(args.source).resolve()
    dest_root = Path(args.dest).expanduser().resolve()

    dest_root.mkdir(parents=True, exist_ok=True)

    copy_tooling(source_root, dest_root)

    for entry in sorted(source_root.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name in SKIP_DIRS or entry.name.startswith("."):
            continue
        if args.match and args.match not in str(entry):
            continue

        quiz_md = sorted(entry.glob("*quiz*.md"))
        if not quiz_md:
            continue

        copy_quiz_folder(entry, dest_root / entry.name)

    print(f"Seed bundle ready at: {dest_root}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export quiz seed bundle to target prisma/seed folder.")
    parser.add_argument("--source", default=".", help="Source repo root (default: current directory).")
    parser.add_argument("--dest", default=str(DEFAULT_DEST), help="Destination seed folder.")
    parser.add_argument("--match", default=None, help="Only copy quiz folders whose path contains this substring.")
    return parser.parse_args()


def copy_quiz_folder(src_dir: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Markdown files
    for md_file in sorted(src_dir.glob("*quiz*.md")):
        shutil.copy2(md_file, dest_dir / md_file.name)

    # JSON files (prefer combined quizz.json)
    combined = src_dir / "quizz.json"
    if combined.exists():
        shutil.copy2(combined, dest_dir / combined.name)
    else:
        for json_file in sorted(src_dir.glob("*quiz*.json")):
            shutil.copy2(json_file, dest_dir / json_file.name)

    # Images folder (if present)
    images_src = src_dir / "images"
    if images_src.is_dir():
        images_dest = dest_dir / "images"
        if images_dest.exists():
            shutil.rmtree(images_dest)
        shutil.copytree(images_src, images_dest)

    # Optional init folder/file if present
    init_src = src_dir / "init"
    if init_src.exists():
        init_dest = dest_dir / "init"
        if init_dest.exists():
            shutil.rmtree(init_dest)
        if init_src.is_dir():
            shutil.copytree(init_src, init_dest)
        else:
            shutil.copy2(init_src, init_dest)


def copy_tooling(source_root: Path, dest_root: Path) -> None:
    for name in ["seeder.ts", "generate_quiz_json_2.py"]:
        src = source_root / name
        if src.exists():
            shutil.copy2(src, dest_root / src.name)


if __name__ == "__main__":
    main()
