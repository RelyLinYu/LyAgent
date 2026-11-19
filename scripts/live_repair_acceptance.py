"""Injected-error/live-Worker finite repair check, not a natural B0/B2 retry."""
import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fastapi.testclient import TestClient
from apps.api.main import BUILD, create_app
from apps.api.provider import Provider
from live_batch_budget import wrap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--live', action='store_true', required=True)
    parser.parse_args()
    provider = Provider()
    provider.base, provider.model, provider.key = 'https://api.deepseek.com', 'deepseek-chat', os.environ.get('DEEPSEEK_API_KEY', '')
    if not provider.configured:
        raise SystemExit('Current process credential required')
    wrap(provider, 'injected-finite-repair')
    out = ROOT / 'artifacts/contest-final' / datetime.now().strftime('%Y%m%d-%H%M%S-injected-repair-live')
    workspace, evaluation = out / 'workspace', out / 'evaluation'
    workspace.mkdir(parents=True, exist_ok=False)
    evaluation.mkdir()
    (workspace / 'note.md').write_text('budget 999\n', encoding='utf-8')
    (evaluation / 'test_note.py').write_text("import unittest\nfrom pathlib import Path\nclass Note(unittest.TestCase):\n    def test_budget(self):\n        self.assertEqual(Path('note.md').read_text(encoding='utf-8'), 'budget 137\\n')\n", encoding='utf-8')
    os.environ.update(LYAGENT_WORKSPACE=str(workspace), LYAGENT_EVALUATION_ROOT=str(evaluation), LYAGENT_ENABLE_WORKFLOWS='1', LYAGENT_ALLOW_WRITES='1', LYAGENT_ALLOW_TESTS='1', LYAGENT_ENABLE_CAPABILITIES='0')
    report = {'build': BUILD, 'mode': 'injected-error-live-model-real-unittest', 'natural_quality_sample': False, 'approval_scope': 'note.md exact expected text and fixed run_tests only', 'passed': False, 'approvals': []}
    with TestClient(create_app(out / 'data', provider)) as client:
        definitions = client.app.state.definitions
        definitions.save('profile', 'reader', {'role': 'Bounded repair proposer', 'model_ref': 'configured', 'tools': ['read_file'], 'capacity': 2}, 0)
        definitions.save('team', 'team', {'profiles': ['reader@1']}, 0)
        repair = {'id': 'repair', 'role': 'Proposer', 'goal': 'Repair note.md to exactly budget 137 followed by one newline. Read existing target for exact SHA256. Return only patches JSON with path, content, base_sha256. Do not run tests or write directly.', 'paths': ['note.md'], 'tools': ['read_file'], 'output_format': 'patches', 'max_calls': 3, 'max_tokens': 50000}
        definitions.save('workflow', 'repair', {'nodes': [{'id': 'repair', 'work_order': repair}], 'outputs': ['repair']}, 0)
        definitions.save('workflow', 'main', {'nodes': [
            {'id': 'stable', 'work_order': {'id': 'stable', 'role': 'Observer', 'goal': 'Return exactly independent branch retained. Do not use tools.', 'max_calls': 1, 'max_tokens': 10000}},
            {'id': 'check', 'kind': 'verification', 'dependencies': ['stable'], 'repair_ref': 'repair@1', 'max_repairs': 1},
        ], 'outputs': ['check']}, 0)
        headers = {'X-LyAgent-Token': client.get('/api/bootstrap').json()['token']}
        cid = client.post('/api/conversations', headers=headers).json()['id']
        url = '/api/conversations/' + cid
        task = {'goal': 'Verify the injected note error; repair only note.md to budget 137 plus newline, then recheck. Retain the independent branch.', 'required_artifacts': ['note.md'], 'require_tests': True, 'workflow': {'name': 'main', 'version': 1, 'team': 'team', 'team_version': 1}, 'budget': {'max_calls': 4, 'max_tokens': 80000, 'max_tools': 5}}
        report['task'] = task
        client.post(url + '/messages', headers=headers, json={'content': task['goal'], 'task': task, 'client_id': 'injected-finite-repair-live'}).raise_for_status()
        start = time.monotonic()
        while time.monotonic() - start < 240:
            state = client.get(url).json()
            for control in state['controls']:
                if control['status'] != 'pending':
                    continue
                arguments = json.loads(control['arguments'])
                approved = control['tool'] == 'run_tests' and arguments == {}
                if control['tool'] == 'replace_file':
                    approved = arguments.get('path') == 'note.md' and arguments.get('content') == 'budget 137\n'
                client.post(url + '/approvals/' + control['id'], headers=headers, json={'arguments_hash': control['arguments_hash'], 'approved': approved}).raise_for_status()
                report['approvals'].append({'tool': control['tool'], 'approved': approved, 'arguments_hash': control['arguments_hash']})
            if state['turns'][-1]['status'] not in {'queued', 'running', 'waiting_approval'}:
                break
            time.sleep(.1)
        else:
            client.post(url + '/stop', headers=headers).raise_for_status()
            time.sleep(.2)
            state = client.get(url).json()
        run = state['runs'][0]
        report['state'] = state
        report['elapsed_seconds'] = round(time.monotonic() - start, 3)
        report['passed'] = run['status'] == 'completed' and [item['status'] for item in run['verifications']] == ['failed', 'passed'] and len(run['workers']) == 2 and (workspace / 'note.md').read_text() == 'budget 137\n'
        report['events'] = [dict(row) for row in client.app.state.repo.db.execute('SELECT * FROM events ORDER BY seq')]
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(out / 'report.json'), 'passed': report['passed'], 'budget': run['budget']}))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
