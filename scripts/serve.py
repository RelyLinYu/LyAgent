"""Serve the built workbench and API on one loopback origin."""
import argparse
import os
import sys
from pathlib import Path

import uvicorn
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8777)
    parser.add_argument('--data-dir', type=Path)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    if args.data_dir:
        os.environ['LYAGENT_DATA_DIR'] = str(args.data_dir.resolve())
    dist = ROOT / 'apps' / 'web' / 'dist'
    if not (dist / 'index.html').is_file():
        parser.error('frontend build missing; run npm ci and npm run build in apps/web')
    from apps.api.main import app
    app.mount('/', StaticFiles(directory=dist, html=True), name='workbench')
    uvicorn.run(app, host='127.0.0.1', port=args.port)


if __name__ == '__main__':
    main()
