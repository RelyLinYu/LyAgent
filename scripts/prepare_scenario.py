"""Prepare a new isolated scenario; never call a model or start a server."""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from apps.api.store import Repository
from apps.api.definitions import DefinitionStore
GOALS = {
    'materials': 'Read all authorized fictional materials. Check required deliverables, owner/date conflicts, deadline and budget. Do not invent resolutions. Create report.md and findings.json; preserve conflicts as pending_confirmation with exact source path/line/quote. findings.json must have required_deliverables, missing_deliverables and issues (code, status, details, sources). Issue codes: owner_conflict, date_conflict, deadline_exceeded, budget_exceeded. Run the fixed tests. Do not change input files.',
    'python-maintenance': 'Update calculator.py so total(values) ignores None, retains ordinary numeric summation and returns zero for an empty iterable. Run the fixed external unittest suite. Do not change any other input file.'
}


def prepare(name, destination):
    source = ROOT / 'examples' / name
    if destination.exists():
        raise ValueError('Scenario destination must be new')
    destination.mkdir(parents=True)
    workspace, evaluation = destination / 'workspace', destination / 'evaluation'
    if name == 'materials':
        shutil.copytree(source / 'workspace', workspace)
        shutil.copytree(source / 'evaluation', evaluation, ignore=shutil.ignore_patterns('__pycache__'))
        required = ['report.md', 'findings.json']
    else:
        workspace.mkdir()
        evaluation.mkdir()
        shutil.copy2(source / 'calculator.py', workspace / 'calculator.py')
        shutil.copy2(source / 'calculator.py', workspace / 'input-calculator.txt')
        shutil.copy2(source / 'test_calculator.py', evaluation / 'test_calculator.py')
        required = ['calculator.py']
    files = {path.relative_to(destination).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(destination.rglob('*')) if path.is_file()}
    goal = GOALS[name]
    if name == 'materials':
        goal += ' JSON schema: required_deliverables and missing_deliverables are arrays of filename strings, not objects. issues is an array of objects; sources entries have path string, line integer (1-based), quote string copied exactly from that line. Keep findings concise and do not cite a line without reading it. Label report.md with the exact word Fictional. Keep the readable report consistent with findings.json, including the required-deliverable list.'
    repo = Repository(destination / 'data/lyagent.sqlite3')
    try:
        definitions = DefinitionStore(repo)
        definitions.save('profile', 'scenario-reviewer', {'role': 'Scoped analyst and patch proposer', 'model_ref': 'configured', 'tools': ['read_file'], 'capacity': 2}, 0)
        definitions.save('team', 'scenario-team', {'profiles': ['scenario-reviewer@1']}, 0)
        inputs = sorted(path.relative_to(workspace).as_posix() for path in workspace.rglob('*') if path.is_file())
        analysis_inputs = [path for path in inputs if path not in required]
        requirement_inputs = [path for path in analysis_inputs if path in {'rules.md', 'proposal.md', 'timeline.csv'}] if name == 'materials' else analysis_inputs
        risk_inputs = [path for path in analysis_inputs if path in {'rules.md', 'meeting.md', 'handoff.md'}] if name == 'materials' else analysis_inputs
        def order(identity, goal, patches=False):
            return {'id': identity, 'goal': goal, 'role': 'Scoped reviewer', 'tools': ['read_file'], 'paths': sorted(set(inputs + required if patches else analysis_inputs)), 'max_calls': 8, 'max_tokens': 200000, 'output_format': 'patches' if patches else 'text'}
        analysis_contract = ' Parent task context only (file creation and fixed tests belong to the parent workflow, not this analysis): ' + goal
        scope_rule = ' Analyze only the projected evidence; other analysts have additional sources. Do not infer global absence or absence of conflicts from your restricted paths. Return concise evidence with exact path, 1-based line and quote, not draft output files. Read each needed source once unless the read was truncated or failed. Do not request write or test authority.'
        writer = order('writer', goal + ' Read existing target bytes for SHA256 before replacing. For absent targets use base_sha256 null. Return only approved-scope patch proposals, never write directly.', True)
        definitions.save('workflow', 'scenario-repair', {'nodes': [{'id': 'repair', 'work_order': writer}], 'outputs': ['repair']}, 0)
        definitions.save('workflow', 'scenario-main', {'nodes': [
            {'id': 'requirements', 'work_order': {**order('requirements', 'Extract required behavior and deliverable evidence for the parent writer.' + scope_rule + analysis_contract), 'paths': requirement_inputs}},
            {'id': 'risks', 'work_order': {**order('risks', 'Independently inspect conflicts and edge cases for the parent writer.' + scope_rule + analysis_contract), 'paths': risk_inputs}},
            {'id': 'writer', 'dependencies': ['requirements', 'risks'], 'work_order': writer},
            {'id': 'verify', 'kind': 'verification', 'dependencies': ['writer'], 'repair_ref': 'scenario-repair@1', 'max_repairs': 2},
        ], 'outputs': ['verify']}, 0)
    finally:
        repo.close()
    manifest = {'format': 1, 'scenario': name, 'fictional': True, 'input_hashes': files, 'task': {'goal': GOALS[name], 'required_artifacts': required, 'require_tests': True}, 'comparison_budget': {'model_calls': 8, 'tokens': 200000, 'tool_attempts': 16}, 'model_called': False}
    manifest['workflow'] = {'name': 'scenario-main', 'version': 1, 'team': 'scenario-team', 'team_version': 1}
    manifest['task']['goal'] = goal
    manifest['task']['budget'] = {'max_calls': 8, 'max_tokens': 200000, 'max_tools': 16}
    manifest['comparison_tasks'] = {
        'B0': dict(manifest['task']),
        'B2': {**manifest['task'], 'workflow': manifest['workflow']},
    }
    (destination / 'SCENARIO.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('scenario', choices=list(GOALS))
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    result = prepare(args.scenario, args.destination.resolve())
    print(json.dumps({'destination': str(args.destination.resolve()), **result}))
