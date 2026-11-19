"""Verify and reproduce a source bundle in a new directory without model calls."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path


def extract(archive_path, destination):
    if destination.exists():
        raise ValueError('Reproduction destination must be new')
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive member')
        manifest = json.loads(archive.read('RELEASE_MANIFEST.json'))
        expected = {row['path'] for row in manifest['files']}
        if set(names) != expected | {'RELEASE_MANIFEST.json'}:
            raise ValueError('Manifest member mismatch')
        for row in manifest['files']:
            path = Path(row['path'])
            if path.is_absolute() or not (destination / path).resolve().is_relative_to(destination.resolve()):
                raise ValueError('Unsafe archive path')
            content = archive.read(row['path'])
            if len(content) != row['bytes'] or hashlib.sha256(content).hexdigest() != row['sha256']:
                raise ValueError('Manifest hash mismatch')
        destination.mkdir(parents=True)
        archive.extractall(destination)
    return manifest


def reproduce(archive, destination):
    manifest = extract(archive, destination)
    out = destination / 'artifacts/clean-repro'
    out.mkdir(parents=True)
    env = {key: value for key, value in os.environ.items() if not key.startswith('LYAGENT_') and key not in {'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'PYTHONPATH', 'VIRTUAL_ENV'}}
    env['PYTHONNOUSERSITE'] = '1'
    steps = [
        ('setup', ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/setup.ps1', '-Python', sys.executable]),
        ('tests', [str(destination / '.venv/Scripts/python.exe'), '-m', 'pytest', '-q', 'tests', '--junitxml=artifacts/clean-repro/tests.xml']),
        ('browser', [str(destination / '.venv/Scripts/python.exe'), 'scripts/control_ui_server.py']),
        ('surface', [str(destination / '.venv/Scripts/python.exe'), 'scripts/release_surface_server.py']),
    ]
    report = {'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'files_verified': len(manifest['files']), 'mode': 'clean-same-machine-deterministic-no-model', 'steps': [], 'passed': False}
    for name, command in steps:
        with (out / (name + '.log')).open('w', encoding='utf-8') as log:
            try:
                result = subprocess.run(command, cwd=destination, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = 'timeout'
        report['steps'].append({'name': name, 'exit_code': code})
        (out / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        if code != 0:
            return report
    report['passed'] = True
    (out / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    report = reproduce(args.archive.resolve(), args.destination.resolve())
    print(json.dumps(report))
    raise SystemExit(0 if report['passed'] else 1)
