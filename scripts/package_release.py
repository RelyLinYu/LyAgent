"""Build a source/reproducible bundle without local data or credentials."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'.git', '.venv', 'node_modules', 'data', 'artifacts', '__pycache__', '.pytest_cache', '.impeccable', 'test-results', 'playwright-report'}
SOURCE_SUFFIXES = {'.py', '.ps1', '.mjs', '.js', '.json', '.md', '.txt', '.csv', '.ts', '.tsx', '.css', '.html', '.svg'}
SENSITIVE_NAMES = {'credentials.json', 'secrets.json', 'service-account.json', 'id_rsa', 'id_ed25519'}


def permitted(relative):
    return (not any(part in EXCLUDED for part in relative.parts)
            and relative.suffix.lower() in SOURCE_SUFFIXES
            and not relative.name.lower().startswith('.env')
            and relative.name.lower() not in SENSITIVE_NAMES)


def package(output):
    files = []
    for directory in ['apps', 'scripts', 'skills', 'examples', 'tests']:
        for path in (ROOT / directory).rglob('*'):
            relative = path.relative_to(ROOT)
            if path.is_file() and permitted(relative):
                files.append(path)
    for name in ['README.md', 'REMEDIATION_PLAN.md', 'DSH_COMPARISON.md', 'CONTRACTS.md', 'DESIGN.md', 'THIRD_PARTY_NOTICES.json', 'RELEASE_POLICY.md', 'requirements.txt', 'requirements-lock.txt', 'pytest.ini']:
        files.append(ROOT / name)
    files = sorted(set(files))
    manifest = {'format': 1, 'credential_files_excluded': True, 'local_data_included': False, 'requires_final_content_review': True, 'files': []}
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            if path.is_symlink() or not path.resolve().is_relative_to(ROOT.resolve()):
                raise ValueError('Release member escapes source root')
            content = path.read_bytes()
            name = path.relative_to(ROOT).as_posix()
            manifest['files'].append({'path': name, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
            archive.writestr(name, content)
        archive.writestr('RELEASE_MANIFEST.json', json.dumps(manifest, indent=2))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = package(args.output.resolve())
    print(json.dumps({'archive': str(args.output.resolve()), 'files': len(result['files'])}))
