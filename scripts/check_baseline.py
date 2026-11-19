"""Verify preserved legacy sources and new-root isolation, without importing legacy code."""
from pathlib import Path
import hashlib
import json
import ast

ROOT = Path(__file__).resolve().parents[1]
LEGACY = ROOT.parent
snapshots = sorted((LEGACY / 'artifacts' / 'rewrite-baseline').glob('*/manifest.json'))
manifest_path = snapshots[-1]
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
changed = []
for entry in manifest['source_files']:
    original = LEGACY / entry['path']
    backup = manifest_path.parent / 'source' / entry['path']
    if hashlib.sha256(original.read_bytes()).hexdigest() != entry['sha256'] or hashlib.sha256(backup.read_bytes()).hexdigest() != entry['sha256']:
        changed.append(entry['path'])
invalid_backups = [entry['path'] for entry in manifest['databases'] if hashlib.sha256((manifest_path.parent / 'databases' / entry['path']).read_bytes()).hexdigest() != entry['backup_sha256']]
imports = []
reviewed_test_loader = []
for path in (ROOT / 'apps').rglob('*.py'):
    text = path.read_text(encoding='utf-8')
    if 'sys.path' in text:
        mutations = [node for node in ast.walk(ast.parse(text)) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Attribute) and isinstance(node.func.value.value, ast.Name) and node.func.value.value.id == 'sys' and node.func.value.attr == 'path']
        approved = path.relative_to(ROOT).as_posix() == 'apps/api/unittest_child.py' and len(mutations) == 1 and ast.unparse(mutations[0]) == 'sys.path.insert(0, str(workspace))' and 'workspace, evaluation, report = map(Path, sys.argv[1:])' in text
        if approved:
            reviewed_test_loader.append({'path': path.relative_to(ROOT).as_posix(), 'reason': 'Isolated fixed unittest child imports explicitly authorized workspace; no parent project path is injected.'})
        else:
            imports.append(path.relative_to(ROOT).as_posix())
    if any((isinstance(node, ast.ImportFrom) and any(part in {'legacy', 'agentmade'} for part in (node.module or '').lower().split('.'))) or (isinstance(node, ast.Import) and any(part in {'legacy', 'agentmade'} for alias in node.names for part in alias.name.lower().split('.'))) for node in ast.walk(ast.parse(text))):
        imports.append(path.relative_to(ROOT).as_posix())
report = {'source_files': len(manifest['source_files']), 'database_backups': len(manifest['databases']), 'changed_legacy_sources': changed, 'corrupt_backups': invalid_backups, 'suspicious_runtime_imports': imports}
report['reviewed_test_loader'] = reviewed_test_loader
output = ROOT / 'artifacts' / 'r00'
output.mkdir(parents=True, exist_ok=True)
(output / 'isolation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
assert not changed and not invalid_backups and not imports
