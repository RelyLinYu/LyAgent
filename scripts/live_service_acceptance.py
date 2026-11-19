"""Bounded live HTTP-service acceptance, isolated database, at most 4 requests."""
import base64
import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from apps.api.main import create_app, BUILD
from apps.api.provider import Provider

if '--live' not in sys.argv:
    raise SystemExit('Explicit --live required')
provider = Provider()
provider.base = 'https://api.deepseek.com'
provider.model = 'deepseek-chat'
provider.key = os.environ.get('DEEPSEEK_API_KEY', '')
if not provider.configured:
    raise SystemExit('Authorized environment key not available')
original = provider.stream
from live_batch_budget import wrap
wrap(provider, 'current-service')
original = provider.stream
calls = 0
async def bounded(messages, tools=None):
    global calls
    calls += 1
    if calls > 4:
        raise RuntimeError('Live batch request cap exceeded')
    async for packet in original(messages, tools):
        yield packet
provider.stream = bounded
root = Path(__file__).resolve().parents[1]
out = root / 'artifacts' / 'contest-final' / datetime.now().strftime('%Y%m%d-%H%M%S-service-live')
report = {'build': BUILD, 'mode': 'live', 'model': provider.model, 'checks': []}
with TestClient(create_app(out / 'data', provider)) as client:
    token = client.get('/api/bootstrap').json()['token']
    headers = {'X-LyAgent-Token': token}
    conversation = client.post('/api/conversations', headers=headers).json()['id']
    source = client.post('/api/attachments', headers=headers, json={'name': 'acceptance.md', 'encoded': base64.b64encode(b'Validation code: ly-service-9261\n').decode()}).json()
    requests = [
        {'content': '用一句中文回答你好。', 'mode': 'Ask', 'client_id': 'live-greeting-01'},
        {'content': '请调用 read_source 读取本次附件，原样返回 validation code，不要猜测。', 'attachment_ids': [source['id']], 'client_id': 'live-source-01'},
    ]
    for body in requests:
        response = client.post(f'/api/conversations/{conversation}/messages', headers=headers, json=body)
        assert response.status_code == 200
        for _ in range(2000):
            state = client.get('/api/conversations/' + conversation).json()
            if state['turns'][-1]['status'] not in {'queued', 'running'}:
                break
            time.sleep(.1)
        report['checks'].append({'client_id': body['client_id'], 'status': state['turns'][-1]['status'], 'text': state['messages'][-1]['content'], 'error': state['turns'][-1]['error']})
    repo = client.app.state.repo
    invocations = [dict(row) for row in repo.db.execute('SELECT * FROM invocations')]
    report['invocations'] = invocations
    report['usage'] = state['usage']
    report['passed'] = all(check['status'] == 'completed' for check in report['checks']) and 'ly-service-9261' in report['checks'][-1]['text'] and any(row['tool'] == 'read_source' and row['status'] == 'settled' for row in invocations)
report['requests'] = calls
(out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'report': str(out / 'report.json'), 'passed': report['passed'], 'requests': calls, 'reported_tokens': sum(item['reported'] for item in report['usage'])}))
if not report['passed']:
    raise SystemExit(1)
