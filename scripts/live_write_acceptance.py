"""Bounded live read/write/test acceptance in a disposable authorized sample root."""
import hashlib
import ast
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from apps.api.main import BUILD, create_app
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
wrap(provider, 'current-write')
original = provider.stream
calls = 0


async def bounded(messages, tools=None):
    global calls
    calls += 1
    if calls > 6:
        raise RuntimeError('Live acceptance request cap exceeded')
    async for packet in original(messages, tools):
        yield packet


provider.stream = bounded
root = Path(__file__).resolve().parents[1]
out = root / 'artifacts' / 'contest-final' / datetime.now().strftime('%Y%m%d-%H%M%S-write-live')
workspace = out / 'workspace'
evaluation = out / 'evaluation'
workspace.mkdir(parents=True)
evaluation.mkdir()
(workspace / 'calculator.py').write_text('def total(values):\n    return sum(values)\n', encoding='utf-8')
(evaluation / 'test_total.py').write_text('import unittest\nfrom calculator import total\nclass Tests(unittest.TestCase):\n    def test_normal(self):\n        self.assertEqual(total([2, 3, -1]), 4)\n    def test_none(self):\n        self.assertEqual(total([2, None, 3]), 5)\n    def test_empty(self):\n        self.assertEqual(total([]), 0)\n', encoding='utf-8')
variables = {'LYAGENT_WORKSPACE': str(workspace.resolve()), 'LYAGENT_ALLOW_WRITES': '1', 'LYAGENT_ALLOW_TESTS': '1', 'LYAGENT_EVALUATION_ROOT': str(evaluation.resolve()), 'LYAGENT_ENABLE_CAPABILITIES': '0'}
previous = {key: os.environ.get(key) for key in variables}
os.environ.update(variables)
report = {'mode': 'live', 'build': BUILD, 'model': provider.model, 'request_cap': 6, 'approval_mode': 'acceptance_controller_for_isolated_sample_only', 'approvals': []}
try:
    with TestClient(create_app(out / 'data', provider)) as client:
        token = client.get('/api/bootstrap').json()['token']
        headers = {'X-LyAgent-Token': token}
        cid = client.post('/api/conversations', headers=headers).json()['id']
        url = '/api/conversations/' + cid
        response = client.post(url + '/messages', headers=headers, json={'content': '请实际修改 calculator.py：total(values) 求和时忽略 None，保留普通数字及空列表行为。先 read_file 获取内容与 SHA256，使用 replace_file 修改，再调用 run_tests 做真实验证。不要创建其他文件，不要仅给代码建议。测试运行器已由用户配置在独立根，不需要你读取或修改测试文件。', 'mode': 'Agent', 'client_id': 'live-write-001', 'task': {'goal': 'Ignore None values in total and verify real unittest results', 'required_artifacts': ['calculator.py'], 'require_tests': True}})
        response.raise_for_status()
        start = time.monotonic()
        while time.monotonic() - start < 240:
            state = client.get(url).json()
            for control in state['controls']:
                if control['status'] != 'pending':
                    continue
                arguments = json.loads(control['arguments'])
                approved = (control['tool'] == 'replace_file' and arguments.get('path') == 'calculator.py' and set(arguments) == {'path', 'content', 'base_sha256'}) or (control['tool'] == 'run_tests' and arguments == {})
                if control['tool'] == 'replace_file' and approved:
                    try:
                        tree = ast.parse(arguments['content'])
                        allowed_nodes = (ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.Call, ast.Name, ast.Load, ast.Store, ast.GeneratorExp, ast.ListComp, ast.comprehension, ast.Compare, ast.IsNot, ast.Constant, ast.If, ast.Assign, ast.For, ast.AugAssign, ast.Add, ast.BinOp, ast.Pass, ast.Expr)
                        approved = len(tree.body) == 1 and isinstance(tree.body[0], ast.FunctionDef) and tree.body[0].name == 'total' and all(isinstance(node, allowed_nodes) and (not isinstance(node, ast.Call) or isinstance(node.func, ast.Name) and node.func.id == 'sum') and (not isinstance(node, ast.Name) or not node.id.startswith('__')) for node in ast.walk(tree))
                    except (SyntaxError, TypeError):
                        approved = False
                client.post(url + '/approvals/' + control['id'], headers=headers, json={'arguments_hash': control['arguments_hash'], 'approved': approved}).raise_for_status()
                report['approvals'].append({'id': control['id'], 'tool': control['tool'], 'arguments_hash': control['arguments_hash'], 'approved': approved})
            if state['turns'][-1]['status'] not in {'queued', 'running', 'waiting_approval'}:
                break
            time.sleep(.1)
        else:
            client.post(url + '/stop', headers=headers)
            state = client.get(url).json()
        report['elapsed_seconds'] = round(time.monotonic() - start, 3)
        report['state'] = state
        report['invocations'] = [dict(row) for row in client.app.state.repo.db.execute('SELECT * FROM invocations')]
        report['requests'] = calls
        report['reported_tokens'] = sum(row['reported'] for row in state['usage'])
        tools = {row['tool'] for row in report['invocations'] if row['status'] == 'settled'}
        report['passed'] = state['turns'][-1]['status'] == 'completed' and state['runs'][0]['status'] == 'completed' and {'read_file', 'replace_file', 'run_tests'} <= tools and len(state['runs'][0]['verifications']) > 0
        report['output_sha256'] = hashlib.sha256((workspace / 'calculator.py').read_bytes()).hexdigest()
finally:
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'report': str(out / 'report.json'), 'passed': report.get('passed', False), 'requests': calls, 'reported_tokens': report.get('reported_tokens')}))
if not report.get('passed'):
    raise SystemExit(1)
