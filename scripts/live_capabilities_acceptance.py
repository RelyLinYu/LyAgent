"""Bounded paid-model/real-MCP joint check; explicit --live only."""
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


def main():
    if '--live' not in sys.argv:
        raise SystemExit('Explicit --live required')
    provider = Provider()
    provider.base, provider.model = 'https://api.deepseek.com', 'deepseek-chat'
    provider.key = os.environ.get('DEEPSEEK_API_KEY', '')
    if not provider.configured:
        raise SystemExit('Authorized environment key unavailable')
    original = provider.stream
    from live_batch_budget import wrap
    wrap(provider, 'current-capabilities')
    original = provider.stream
    calls = 0

    async def bounded(messages, tools=None):
        nonlocal calls
        if calls >= 4:
            raise RuntimeError('Live capability request cap reached')
        calls += 1
        async for packet in original(messages, tools):
            yield packet

    provider.stream = bounded
    out = ROOT / 'artifacts' / 'contest-final' / datetime.now().strftime('%Y%m%d-%H%M%S-capabilities-live')
    out.mkdir(parents=True)
    variables = {'LYAGENT_ENABLE_CAPABILITIES': '1', 'LYAGENT_MCP_URL': '', 'LYAGENT_WORKSPACE': '', 'LYAGENT_ALLOW_WRITES': '0', 'LYAGENT_ALLOW_TESTS': '0'}
    previous = {key: os.environ.get(key) for key in variables}
    os.environ.update(variables)
    report = {'mode': 'live-model-real-stdio-mcp', 'build': BUILD, 'model': provider.model, 'request_cap': 4, 'passed': False, 'approvals': [], 'approval_mode': 'isolated-read-only-acceptance-controller'}
    try:
        with TestClient(create_app(out / 'data', provider)) as client:
            headers = {'X-LyAgent-Token': client.get('/api/bootstrap').json()['token']}
            cid = client.post('/api/conversations', headers=headers).json()['id']
            url = f'/api/conversations/{cid}'
            client.post(url + '/messages', headers=headers, json={'client_id': 'capabilities-live-001', 'mode': 'Agent', 'content': '这是受限能力验收。请实际调用 load_skill，id 为 evidence-review；实际调用 mcp_catalog 发现工具，然后调用 mcp_call：name 为 reference_rules，arguments 为 {"topic":"materials"}。可以在一次模型回复中提出多个工具调用。只读取这两个随包来源，禁止写文件或运行测试。最后用中文简述技能版本、资料提交规则及这只是虚构演示规则，不得声称是正式赛事要求。'}).raise_for_status()
            start = time.monotonic()
            while time.monotonic() - start < 180:
                state = client.get(url).json()
                for control in state['controls']:
                    if control['status'] != 'pending':
                        continue
                    arguments = json.loads(control['arguments'])
                    approved = control['tool'] == 'mcp_call' and arguments == {'name': 'reference_rules', 'arguments': {'topic': 'materials'}}
                    client.post(url + '/approvals/' + control['id'], headers=headers, json={'arguments_hash': control['arguments_hash'], 'approved': approved}).raise_for_status()
                    report['approvals'].append({'tool': control['tool'], 'arguments_hash': control['arguments_hash'], 'approved': approved})
                if state['turns'][-1]['status'] not in {'queued', 'running', 'waiting_approval'}:
                    break
                time.sleep(.1)
            else:
                client.post(url + '/stop', headers=headers).raise_for_status()
                state = client.get(url).json()
            rows = [dict(row) for row in client.app.state.repo.db.execute('SELECT * FROM invocations')]
            results = {row['tool']: json.loads(row['result']) for row in rows if row['status'] == 'settled' and row['result']}
            report.update(state=state, invocations=rows, elapsed_seconds=round(time.monotonic() - start, 3), reported_tokens=sum(row['reported'] for row in state['usage']))
            report['passed'] = state['turns'][-1]['status'] == 'completed' and {'load_skill', 'mcp_catalog', 'mcp_call'} <= results.keys() and results['load_skill'].get('version') == '1.0.0' and not results['mcp_call'].get('result', {}).get('isError', True) and not any(row['unknown_calls'] for row in state['usage'])
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        report['requests'] = calls
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(out / 'report.json'), 'passed': report['passed'], 'requests': calls, 'reported_tokens': report.get('reported_tokens')}))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
