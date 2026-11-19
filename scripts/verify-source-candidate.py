#!/usr/bin/env python3
"""Verify a LyAgent source candidate: archive bodies, manifest, live tree, and unsafe layouts.

Usage:
  python rewrite/scripts/verify-source-candidate.py --zip <zip> [--extract <dir>]
  python rewrite/scripts/verify-source-candidate.py --self-test

Checks, all of which must pass:
  * every member body matches the sha256 the manifest declares (the archive itself is rehashed);
  * no duplicate member path, no unsafe member path (absolute, drive, `..`, backslash);
  * every member except `manifest.json` is listed in the manifest, and every manifest entry has a member;
  * only the documented extras are tolerated;
  * the live tree matches: every source file present with the same digest, no unlisted leftovers;
  * the self-authored packages are present.
`--self-test` builds tampered archives in a temporary directory and requires every one to be rejected.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
DSH = ROOT / "dsh"
SCRIPTS = ROOT / "scripts"

# Files an archive may carry without a manifest entry. Anything else is unexpected.
EXTRA_WHITELIST = frozenset({"manifest.json"})
# Members that document the package itself and therefore have no file in the source tree.
ARCHIVE_ONLY = frozenset({"README.md"})

# Self-authored packages that must ship even though git does not track them yet.
REQUIRED_PREFIXES = (
    "dsh/packages/workflow/lyagent-workflow-library/",
    "dsh/packages/context/lyagent-knowledge/",
    "dsh/packages/guard/lyagent-budget/",
    "dsh/packages/client/ui-lyagent-workflows/",
    "dsh/packages/client/ui-lyagent-knowledge/",
    "dsh/packages/client/ui-agent-team/",
    "dsh/packages/client/ui-brand-lyagent/",
    "dsh/packages/client/ui-lyagent-tasks/",
)


def load_packer():
    spec = importlib.util.spec_from_file_location("packer", ROOT / "scripts" / "pack-source-candidate.py")
    module = importlib.util.module_from_spec(spec)
    if spec.loader is None:
        raise SystemExit("packer module unavailable")
    spec.loader.exec_module(module)
    return module


def unsafe_member(name: str) -> str | None:
    """Return a reason when one archive member path is unacceptable."""
    if not name or name.endswith("/"):
        return "empty or directory-only member"
    if "\\" in name:
        return "backslash separator"
    path = PurePosixPath(name)
    if path.is_absolute() or (len(name) > 1 and name[1] == ":"):
        return "absolute path"
    if any(part in ("..", "") for part in path.parts):
        return "escaping path segment"
    return None


def inspect_archive(archive_path: Path, packer) -> dict:
    """Compare archive bodies, manifest entries and the live tree."""
    failures: list[str] = []
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        bodies = {}
        for info in infos:
            bodies.setdefault(info.filename, []).append(hashlib.sha256(archive.read(info)).hexdigest())
        manifest = json.loads(archive.read("manifest.json").decode("utf-8")) if "manifest.json" in names else None

    duplicates = sorted({name for name, digests in bodies.items() if len(digests) > 1})
    if duplicates:
        failures.append(f"duplicate members: {duplicates[:5]}")
    for name in names:
        reason = unsafe_member(name)
        if reason is not None:
            failures.append(f"unsafe member {name!r}: {reason}")
    if manifest is None:
        return {"failures": [*failures, "missing manifest.json"], "entries": len(names)}

    listed = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    unlisted = sorted(set(names) - set(listed) - EXTRA_WHITELIST)
    if unlisted:
        failures.append(f"members missing from the manifest: {unlisted[:5]}")
    absent = sorted(set(listed) - set(names))
    if absent:
        failures.append(f"manifest entries without a member: {absent[:5]}")
    mismatched = []
    for name, declared in listed.items():
        digests = bodies.get(name)
        if digests is None:
            continue
        if len(digests) == 1 and digests[0] != declared:
            mismatched.append(name)
    if mismatched:
        failures.append(f"member bodies that differ from the manifest: {mismatched[:5]}")
    absent_packages = [prefix for prefix in REQUIRED_PREFIXES
                       if not any(name.startswith(prefix) for name in names)]

    # Live-tree comparison: the archive must describe the working tree the packer would produce now.
    live: dict[str, str] = {}
    for path in packer.walk(DSH):
        live[f"dsh/{path.relative_to(DSH).as_posix()}"] = packer.sha256(path)
    for path in packer.walk(SCRIPTS):
        live[f"scripts/{path.relative_to(SCRIPTS).as_posix()}"] = packer.sha256(path)
    live_missing = sorted(set(live) - set(listed))
    live_extra = sorted(set(listed) - set(live) - ARCHIVE_ONLY)
    live_mismatched = sorted(name for name, digest in live.items() if name in listed and listed[name] != digest)
    if live_missing:
        failures.append(f"live files absent from the archive: {live_missing[:5]}")
    if live_mismatched:
        failures.append(f"live files differing from the archive: {live_mismatched[:5]}")
    if absent_packages:
        failures.append(f"self-authored packages absent: {absent_packages}")
    if live_extra:
        failures.append(f"archive entries with no live file: {live_extra[:5]}")

    return {
        "zip": str(archive_path),
        "entries": len(names),
        "liveFiles": len(live),
        "bodyMatches": len(listed) - len(mismatched) - len(absent),
        "failures": failures,
        "upstreamCommit": manifest.get("upstreamCommit"),
        "created": manifest.get("created"),
    }


def self_test() -> int:
    """Reject five archive tamper cases and refuse extraction of invalid content."""
    packer = load_packer()
    work = Path(tempfile.mkdtemp(prefix="lyagent-verify-selftest-"))
    try:
        readme = work / "README.md"
        readme.write_text("# rehearsal\n", encoding="utf-8")
        good = work / "good.zip"
        subprocess.run([sys.executable, str(ROOT / "scripts" / "pack-source-candidate.py"),
                        "--output", str(good), "--readme", str(readme)], check=True, capture_output=True)
        baseline = inspect_archive(good, packer)
        if baseline["failures"]:
            print(json.dumps({"selfTest": "baseline archive failed", "failures": baseline["failures"]}, indent=1))
            return 1

        cases: dict[str, Path] = {}
        # 1. A member body edited while the manifest keeps the old digest.
        tampered = work / "tampered.zip"
        with zipfile.ZipFile(good) as source, zipfile.ZipFile(tampered, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                data = source.read(info)
                if info.filename == "dsh/package.json":
                    data = data + b"\n"
                target.writestr(info, data)
        cases["tampered-body"] = tampered

        # 2. A manifest entry removed while its member stays.
        missing = work / "missing-entry.zip"
        with zipfile.ZipFile(good) as source, zipfile.ZipFile(missing, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                data = source.read(info)
                if info.filename == "manifest.json":
                    document = json.loads(data.decode("utf-8"))
                    document["files"] = [entry for entry in document["files"] if entry["path"] != "dsh/package.json"]
                    data = json.dumps(document).encode("utf-8")
                target.writestr(info, data)
        cases["manifest-lacks-member"] = missing

        # 3. An extra member the manifest does not describe.
        extra = work / "extra.zip"
        with zipfile.ZipFile(good) as source, zipfile.ZipFile(extra, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                target.writestr(info, source.read(info))
            target.writestr("dsh/unlisted.txt", b"smuggled\n")
        cases["unlisted-member"] = extra

        # 4. The same path twice.
        duplicate = work / "duplicate.zip"
        with zipfile.ZipFile(good) as source, zipfile.ZipFile(duplicate, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                target.writestr(info, source.read(info))
            target.writestr("dsh/package.json", b"{}\n")
        cases["duplicate-member"] = duplicate

        # 5. An unsafe member path.
        unsafe = work / "unsafe.zip"
        with zipfile.ZipFile(good) as source, zipfile.ZipFile(unsafe, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                target.writestr(info, source.read(info))
            target.writestr("../escape.txt", b"escape\n")
        cases["unsafe-path"] = unsafe

        results = {name: inspect_archive(path, packer)["failures"] for name, path in cases.items()}
        unrejected = [name for name, failures in results.items() if not failures]
        refused_target = work / "refused-extraction"
        extraction = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--zip", str(unsafe),
             "--extract", str(refused_target)], capture_output=True, text=True)
        refused_extraction = extraction.returncode == 1 and not refused_target.exists()
        if not refused_extraction:
            unrejected.append("invalid-extraction")
        print(json.dumps({"selfTest": "passed" if not unrejected else "failed",
                          "invalidExtractionRefused": refused_extraction,
                          "rejected": {name: failures[:1] for name, failures in results.items()},
                          "unrejected": unrejected}, indent=1, ensure_ascii=False))
        return 0 if not unrejected else 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip")
    parser.add_argument("--extract")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if args.zip is None:
        parser.error("--zip is required")
    packer = load_packer()
    archive_path = Path(args.zip).resolve()
    report = inspect_archive(archive_path, packer)
    if report["failures"]:
        print(json.dumps(report, indent=1, ensure_ascii=False))
        return 1
    if args.extract:
        target = Path(args.extract).resolve()
        target.mkdir(parents=True, exist_ok=False)
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(target)
        report["extractedTo"] = str(target)
    print(json.dumps(report, indent=1, ensure_ascii=False))
    return 0 if not report["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
