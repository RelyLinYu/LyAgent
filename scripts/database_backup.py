"""Consistent SQLite snapshots and offline restore; never overwrite a database."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def snapshot(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_file() or source == destination or destination.exists():
        raise ValueError('Require an existing source and a new, distinct destination')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents accidental overwrite even with concurrent commands.
    with destination.open('xb'):
        pass
    try:
        with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original:
            with sqlite3.connect(destination) as target:
                original.backup(target)
                if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Snapshot integrity check failed')
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return {'source': str(source), 'destination': str(destination), 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'integrity': 'ok'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Backup a live SQLite database, or restore its snapshot into a new offline database path. Never overwrite the original. Stop the server before restoring or switching its data directory.')
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(snapshot(args.source, args.destination)))
