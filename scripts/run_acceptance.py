"""Run the current offline matrix and bind evidence to exact source hashes."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GROUPS = {
    'A01': ['foundation', 'attachment_api'],
    'A02': ['provider', 'sse_reconnect', 'usage_validation'],
    'A03': ['tools', 'writes', 'write_safety', 'test_runner', 'workflow_verification'],
    'A04': ['tool_allowlist', 'low_trust_boundaries', 'writes'],
    'A05': ['capabilities', 'mcp_api', 'mcp_http', 'mcp_revocation', 'low_trust_boundaries'],
    'A06': ['foundation', 'corrections', 'clarifications', 'approval_api', 'parallel_approval'],
    'A07': ['recovery', 'unknown_effects', 'write_safety', 'workflows', 'workers'],
    'A08': ['tools', 'junction_scope', 'low_trust_boundaries', 'run_revocation', 'mcp_revocation'],
    'A09': ['run_budgets', 'budget_shares', 'model_admission', 'joint_admission', 'task_budgets', 'tool_budget', 'live_batch_budget'],
    'A10': ['workers', 'worker_knowledge', 'workflow_api', 'worker_proposal_prompt'],
    'A11': ['definitions', 'definition_api', 'scheduler', 'scheduler_wait', 'scheduler_permission_wait', 'workflow_planning'],
    'A12': ['workflows', 'workflow_preflight', 'graph_environment'],
    'A13': ['joint_admission', 'model_admission', 'write_safety', 'test_runner', 'scheduler'],
    'A14': ['knowledge', 'knowledge_api', 'knowledge_integrity', 'worker_knowledge', 'attachment_api'],
    'A15': ['runs', 'source_checks', 'source_check_execution', 'workflow_verification', 'worker_input_versions'],
    'A16': ['workflow_repair', 'workflow_repair_api', 'workflow_sources', 'dependency_versions', 'workflow_refresh'],
    'A17': ['scenarios', 'scenario_workflow'],
    'A18': [],
    'A19': ['run_export', 'model_configuration', 'capability_management', 'workspace_configuration'],
    'A20': ['production_serve', 'background_service', 'release_package', 'release_reproduction', 'database_backup', 'third_party_notices'],
    'A21': ['production_serve', 'background_service', 'release_package', 'release_reproduction'],
}


def source_manifest():
    files = []
    for directory in ['apps/api', 'apps/web/src', 'scripts', 'tests', 'skills', 'examples']:
        for path in sorted((ROOT / directory).rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
                files.append({'path': path.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    return files


def run():
    out = ROOT / 'artifacts/acceptance' / datetime.now().strftime('%Y%m%d-%H%M%S-offline')
    out.mkdir(parents=True, exist_ok=False)
    env = {key: value for key, value in os.environ.items() if not key.startswith('LYAGENT_') and key not in {'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'}}
    steps = [
        ('pytest', [sys.executable, '-m', 'pytest', '-q', 'tests', '--junitxml=' + str(out / 'tests.xml')]),
        ('pip', [sys.executable, '-m', 'pip', 'check']),
    ]
    if (ROOT.parent / 'DEVELOPMENT_PLAN.md').is_file() and (ROOT.parent / 'artifacts/rewrite-baseline').is_dir():
        steps.append(('legacy-isolation', [sys.executable, 'scripts/check_baseline.py']))
    executions = []
    for name, command in steps:
        with (out / (name + '.log')).open('w', encoding='utf-8') as log:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=600, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        executions.append({'step': name, 'exit_code': result.returncode})
    cases = ET.parse(out / 'tests.xml').getroot().findall('.//testcase')
    matrix = []
    for identity, modules in GROUPS.items():
        selected = [case for case in cases if any(case.attrib.get('classname', '').endswith('.test_' + module) for module in modules)]
        failed = [case.attrib['name'] for case in selected if case.find('failure') is not None or case.find('error') is not None]
        skipped = [case.attrib['name'] for case in selected if case.find('skipped') is not None]
        matrix.append({'id': identity, 'offline_status': 'failed' if failed else 'partial-skipped' if skipped else 'passed-scope-only' if selected else 'not_run', 'test_count': len(selected), 'failures': failed, 'skipped': skipped, 'modules': modules, 'gate_passed': False})
    report = {'mode': 'offline-no-model-credentials', 'source_files': source_manifest(), 'steps': executions, 'matrix': matrix, 'limits': 'Only listed deterministic tests; no whole A-group/gate passes inferred. Live, UI, native IME and public-content review are separate evidence.', 'passed': all(step['exit_code'] == 0 for step in executions)}
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(out / 'report.json'), 'passed': report['passed'], 'tests': len(cases)}))
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['deterministic'], required=True)
    parser.parse_args()
    raise SystemExit(0 if run() else 1)
