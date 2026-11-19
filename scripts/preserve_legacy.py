"""Create non-destructive, local-only evidence of the pre-rewrite project."""
from pathlib import Path
import hashlib
import json
import sqlite3
import shutil
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts" / "rewrite-baseline" / datetime.now().strftime("%Y%m%d-%H%M%S")
OUT.mkdir(parents=True, exist_ok=False)
records = []
for name in ("apps", "tests", "scripts", "skills", "examples"):
    for source in (ROOT / name).rglob("*"):
        if not source.is_file() or any(part in {"node_modules", "dist", "__pycache__"} for part in source.parts):
            continue
        relative = source.relative_to(ROOT)
        destination = OUT / "source" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        records.append({"path": relative.as_posix(), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
databases = []
for source in (ROOT / "data").rglob("*.sqlite3"):
    relative = source.relative_to(ROOT)
    destination = OUT / "databases" / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as original:
        with sqlite3.connect(destination) as backup:
            original.backup(backup)
            integrity = backup.execute("PRAGMA integrity_check").fetchone()[0]
            tables = backup.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            counts = {name: backup.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for (name,) in tables}
    databases.append({"path": relative.as_posix(), "integrity": integrity, "tables": counts, "backup_sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
manifest = {"created_at": datetime.now(timezone.utc).isoformat(), "source_files": records, "databases": databases, "secrets_copied": False}
(OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
assert all(item["integrity"] == "ok" for item in databases)
print(json.dumps({"output": str(OUT), "source_files": len(records), "databases": len(databases), "integrity": "ok"}))
