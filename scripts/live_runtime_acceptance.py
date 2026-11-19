"""One-shot live structure/knowledge acceptance under the existing authorized batch."""
import argparse
import base64
import hashlib
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
    parser.add_argument('case', choices=['structures', 'knowledge'])
    parser.add_argument('--live', action='store_true', required=True)
    args = parser.parse_args()
    provider = Provider()
    provider.base, provider.model, provider.key = 'https://api.deepseek.com', 'deepseek-chat', os.environ.get('DEEPSEEK_API_KEY', '')
    if not provider.configured:
        raise SystemExit('Current process credential required')
    wrap(provider, 'runtime-' + args.case)
    out = ROOT / 'artifacts/contest-final' / datetime.now().strftime('%Y%m%d-%H%M%S')
    out = out.with_name(out.name + '-runtime-' + args.case + '-live')
    out.mkdir(parents=True, exist_ok=False)
    workspace = out / 'workspace'
    workspace.mkdir()
    os.environ.update(LYAGENT_WORKSPACE=str(workspace), LYAGENT_ENABLE_WORKFLOWS='1', LYAGENT_ALLOW_WRITES='0', LYAGENT_ALLOW_TESTS='0', LYAGENT_ENABLE_CAPABILITIES='0')
    report = {'build': BUILD, 'case': args.case, 'mode': 'live-model-production-runtime', 'model': provider.model, 'paid_retries': False, 'passed': False}
    start = time.monotonic()
    with TestClient(create_app(out / 'data', provider)) as client:
        app = client.app
        definitions = app.state.definitions
        headers = {'X-LyAgent-Token': client.get('/api/bootstrap').json()['token']}
        tools = ['search_knowledge'] if args.case == 'knowledge' else []
        definitions.save('profile', 'reader', {'role': 'Read-only acceptance worker', 'model_ref': 'configured', 'capacity': 2, 'tools': tools}, 0)
        definitions.save('team', 'team', {'profiles': ['reader@1']}, 0)
        def worker(name, dependencies=None):
            return {'id': name, 'dependencies': dependencies or [], 'work_order': {'id': name, 'role': 'Reader', 'goal': 'Return exactly BRANCH_OK without quotes, punctuation or any explanation.', 'max_calls': 1, 'max_tokens': 20000}}
        cid = client.post('/api/conversations', headers=headers).json()['id']
        url = '/api/conversations/' + cid
        task = {'goal': 'Validate the explicitly pinned read-only workflow.', 'budget': {'max_calls': 9, 'max_tokens': 100000, 'max_tools': 4}, 'workflow': {'name': 'main', 'version': 1, 'team': 'team', 'team_version': 1}}
        if args.case == 'structures':
            definitions.save('workflow', 'leaf', {'nodes': [worker('leaf')], 'outputs': ['leaf']}, 0)
            nodes = [worker('first'), worker('parallel'), worker('sequence', ['first']),
                {'id': 'choice', 'kind': 'condition', 'dependencies': ['sequence'], 'condition': {'source': 'sequence', 'field': 'text', 'equals': 'BRANCH_OK'}},
                {**worker('selected', ['choice']), 'when': {'choice': True}},
                {**worker('skipped', ['choice']), 'when': {'choice': False}},
                {'id': 'join', 'kind': 'join', 'dependencies': ['parallel', 'selected', 'skipped']},
                {'id': 'loop', 'kind': 'loop', 'dependencies': ['join'], 'max_iterations': 2, 'subflow_ref': 'leaf@1'},
                {'id': 'nested', 'kind': 'subflow', 'dependencies': ['loop'], 'subflow_ref': 'leaf@1'}]
            definitions.save('workflow', 'main', {'nodes': nodes, 'outputs': ['nested']}, 0)
        else:
            content = '预算上限 137 元\n负责人 林青\n'
            source = client.post('/api/attachments', headers=headers, json={'name': 'fictional-rules.md', 'encoded': base64.b64encode(content.encode()).decode()}).json()
            client.post('/api/knowledge/collections/rules', headers=headers, json={'expected_version': 0, 'source_ids': [source['id']]}).raise_for_status()
            pinned = client.post(url + '/knowledge', headers=headers, json={'name': 'rules', 'version': 1}).json()
            task['knowledge_snapshots'] = [pinned['id']]
            task['budget']['max_calls'] = 4
            order = {'id': 'read', 'role': 'Reader', 'goal': 'Use search_knowledge on the supplied snapshot with query 预算. Return the exact matching source line with its source ID and 1-based line. Do not guess.', 'tools': tools, 'use_task_knowledge': True, 'max_calls': 3, 'max_tokens': 50000}
            definitions.save('workflow', 'main', {'nodes': [{'id': 'read', 'work_order': order}], 'outputs': ['read']}, 0)
            other = client.post('/api/conversations', headers=headers).json()['id']
            other_snapshot = client.post(f'/api/conversations/{other}/knowledge', headers=headers, json={'name': 'rules', 'version': 1}).json()
            report['cross_conversation_reuse'] = bool(client.get(f'/api/conversations/{other}/knowledge/{other_snapshot["id"]}/search', params={'query': '预算'}).json()['matches'])
            report['no_match'] = client.get(url + f'/knowledge/{pinned["id"]}/search', params={'query': '不存在的条目'}).json()['matches'] == []
            report['cross_scope_denied'] = client.get(f'/api/conversations/{other}/knowledge/{pinned["id"]}/search', params={'query': '预算'}).status_code == 409
            report['source_sha256'] = hashlib.sha256(content.encode()).hexdigest()
        report['task'] = task
        client.post(url + '/messages', headers=headers, json={'content': task['goal'], 'task': task, 'client_id': 'runtime-' + args.case + '-live'}).raise_for_status()
        while time.monotonic() - start < 240:
            state = client.get(url).json()
            if state['turns'][-1]['status'] not in {'queued', 'running', 'waiting_approval'}:
                break
            time.sleep(.1)
        else:
            client.post(url + '/stop', headers=headers).raise_for_status()
            time.sleep(.2)
            state = client.get(url).json()
        run = state['runs'][0]
        report['passed'] = run['status'] == 'completed'
        if args.case == 'structures':
            nodes = [dict(row) for row in app.state.repo.db.execute('SELECT * FROM workflow_node_results')]
            workers = run['workers']
            intervals = [(row['started'], row['ended']) for row in workers if row['started'] and row['ended']]
            report['parallel_overlap'] = any(a < d and c < b for i, (a, b) in enumerate(intervals) for c, d in intervals[i + 1:])
            report['nodes'] = nodes
            report['passed'] &= report['parallel_overlap'] and any(row['node_id'] == 'skipped' and row['status'] == 'skipped' for row in nodes) and len(workers) == 7
        else:
            invocations = [dict(row) for row in app.state.repo.db.execute('SELECT * FROM invocations')]
            report['invocations'] = invocations
            report['passed'] &= all(report[key] for key in ['cross_conversation_reuse', 'no_match', 'cross_scope_denied']) and any(row['tool'] == 'search_knowledge' and row['status'] == 'settled' for row in invocations) and '137' in run['workers'][0]['result']
        report.update(state=state, elapsed_seconds=round(time.monotonic() - start, 3))
        report['events'] = [dict(row) for row in app.state.repo.db.execute('SELECT * FROM events ORDER BY seq')]
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(out / 'report.json'), 'passed': report['passed'], 'budget': run['budget']}))
    raise SystemExit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
