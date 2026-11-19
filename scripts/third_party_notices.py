"""Generate third-party notices from the installed, locked build environment."""
import argparse
import importlib.metadata
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def is_notice(member):
    path = Path(member)
    return path.suffix.lower() in {'', '.txt', '.md', '.rst'} and path.name.lower().split('.')[0] in {'license', 'licence', 'copying', 'notice', 'authors'} and '__pycache__' not in path.parts


def collect():
    packages = []
    for line in (ROOT / 'requirements-lock.txt').read_text(encoding='utf-8').splitlines():
        if '==' not in line:
            continue
        name, version = line.split('==', 1)
        dist = importlib.metadata.distribution(name)
        if dist.version != version:
            raise ValueError('Installed Python version differs from lock: ' + name)
        texts = []
        for member in dist.files or []:
            if is_notice(member):
                path = dist.locate_file(member)
                if path.is_file():
                    texts.append({'path': str(member), 'text': path.read_text(encoding='utf-8', errors='replace')})
        packages.append({'ecosystem': 'python', 'name': name, 'version': version, 'license': dist.metadata.get('License-Expression') or dist.metadata.get('License') or 'See project metadata', 'home': dist.metadata.get_all('Project-URL') or [], 'notices': texts})
    web = ROOT / 'apps/web'
    lock = json.loads((web / 'package-lock.json').read_text(encoding='utf-8'))
    for relative, entry in lock['packages'].items():
        if not relative:
            continue
        directory = web / relative
        if not directory.exists() and entry.get('optional'):
            continue
        metadata = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
        if metadata['version'] != entry['version']:
            raise ValueError('Installed npm version differs from lock: ' + relative)
        texts = [{'path': path.name, 'text': path.read_text(encoding='utf-8', errors='replace')} for path in sorted(directory.iterdir()) if path.is_file() and path.name.lower().split('.')[0] in {'license', 'licence', 'copying', 'notice'}]
        packages.append({'ecosystem': 'npm', 'name': metadata['name'], 'version': metadata['version'], 'license': metadata.get('license', entry.get('license', 'See project metadata')), 'notices': texts})
    return {'format': 1, 'scope': 'Installed locked Python and npm dependencies, including build/test tools; absent optional platform binaries are not distributed', 'original_code': 'No open-source license grant selected by the project owner. Third-party licenses remain applicable.', 'packages': packages}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = collect()
    with args.output.open('w', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'packages': len(result['packages']), 'output': str(args.output)}))
