#!/usr/bin/env python3
"""Pack the LyAgent source candidate: dsh source (no build output/deps), ops scripts, README, manifest.

Usage:
  python rewrite/scripts/pack-source-candidate.py --output <zip> [--readme <file>]

The manifest records one sha256 per packaged file so a verifier can compare the
archive against the live tree without unpacking it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # rewrite/
DSH = ROOT / "dsh"
SCRIPTS = ROOT / "scripts"

# Generated state never ships: dependencies, compiler output, caches, VCS data.
EXCLUDED_DIRS = {"node_modules", ".git", "dist", ".typecheck", "coverage", ".turbo", "__pycache__", ".artifacts"}
EXCLUDED_SUFFIXES = (".tsbuildinfo", ".pyc")
# A package's emitted lib/ sits beside src/; only these roots own build output.
BUILD_OUTPUT_PARENTS = ("packages", "apps", "vendor", "python")


def excluded(relative: Path, absolute: Path | None = None) -> bool:
    parts = relative.parts
    if parts and parts[0] == ".dsh-build":
        return True
    if len(parts) > 1 and parts[0] == "website" and parts[1] in {".dist", ".cache", ".generated"}:
        return True
    if any(part in EXCLUDED_DIRS for part in parts):
        return True
    if relative.name.endswith(EXCLUDED_SUFFIXES):
        return True
    # <group>/<pkg>/lib and <app>/lib hold tsc/bundler output, not source.
    if "lib" in parts[:-1]:
        index = parts.index("lib")
        if index >= 2 and parts[0] in BUILD_OUTPUT_PARENTS:
            return True
    # A stray .js/.d.ts/.map beside a same-named .ts/.tsx is emitted output, not source.
    if absolute is not None and generated_beside_source(absolute):
        return True
    return False


# Suffixes a compiler writes next to a source file by mistake; a real declaration
# source (css-modules.d.ts, vite-env.d.ts) has no same-named .ts/.tsx beside it.
GENERATED_SUFFIXES = (".js", ".js.map", ".d.ts", ".d.ts.map")


def generated_beside_source(path: Path) -> bool:
    name = path.name
    for suffix in GENERATED_SUFFIXES:
        if not name.endswith(suffix):
            continue
        stem = name[: -len(suffix)]
        return any((path.parent / f"{stem}{extension}").exists() for extension in (".ts", ".tsx"))
    return False


def walk(base: Path) -> list[Path]:
    files: list[Path] = []
    for directory, dirnames, filenames in os.walk(base):
        current = Path(directory)
        dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_DIRS)
        for name in sorted(filenames):
            path = current / name
            if excluded(path.relative_to(base), path):
                continue
            if path.is_symlink():
                continue
            files.append(path)
    return files


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--readme")
    parser.add_argument("--kind", default="source-candidate")
    args = parser.parse_args()

    output = Path(args.output).resolve()
    if output.exists():
        print(f"refusing to overwrite {output}", file=sys.stderr)
        return 1
    output.parent.mkdir(parents=True, exist_ok=True)

    commit = subprocess.run(["git", "-C", str(DSH), "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    readme = Path(args.readme).resolve() if args.readme else None
    if readme is not None and not readme.exists():
        print(f"missing readme {readme}", file=sys.stderr)
        return 1

    entries: list[tuple[str, Path]] = []
    for path in walk(DSH):
        entries.append((f"dsh/{path.relative_to(DSH).as_posix()}", path))
    for path in walk(SCRIPTS):
        entries.append((f"scripts/{path.relative_to(SCRIPTS).as_posix()}", path))

    manifest = {
        "upstreamCommit": commit,
        "created": created,
        "kind": args.kind,
        "files": [],
    }
    # Fixed member timestamp keeps the archive reproducible for equal inputs.
    stamp = (2026, 11, 16, 0, 0, 0)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        if readme is not None:
            archive.writestr(zipfile.ZipInfo("README.md", stamp), readme.read_bytes(), zipfile.ZIP_DEFLATED)
            manifest["files"].append({"path": "README.md", "sha256": sha256(readme)})
        for name, path in entries:
            data = path.read_bytes()
            archive.writestr(zipfile.ZipInfo(name, stamp), data, zipfile.ZIP_DEFLATED)
            manifest["files"].append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
        archive.writestr(zipfile.ZipInfo("manifest.json", stamp), json.dumps(manifest, indent=1).encode(), zipfile.ZIP_DEFLATED)

    print(json.dumps({"output": str(output), "entries": len(manifest["files"]) + 1,
                      "files": len(manifest["files"]), "upstreamCommit": commit,
                      "created": created, "bytes": output.stat().st_size}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
