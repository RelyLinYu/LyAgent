"""Real HTTP/SSE/browser acceptance with an explicit test-only provider."""
import asyncio
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from apps.api.main import BUILD, create_app


class ControlFixture:
    configured = True
    model = 'deterministic-control-fixture-not-live'

    def __init__(self):
        self.reconnect_calls = 0
        self.mode_schemas = {}

    async def stream(self, messages, tools=None):
        if messages[0]['content'].startswith('Select one allowed workflow'):
            yield {'text': json.dumps({'index': 0, 'reason': 'Explicit browser candidate selected; deterministic fixture, not live'})}
            yield {'usage': {'total_tokens': 1}}
            return
        contract = next((json.loads(item['content'].split('：', 1)[1]) for item in reversed(messages) if item['role'] == 'user' and item['content'].startswith('本次明确执行契约')), None)
        if contract and contract.get('require_source_checks'):
            contract_index = max(index for index, item in enumerate(messages) if item['role'] == 'user' and item['content'].startswith('本次明确执行契约'))
            previous = [item for item in messages[contract_index + 1:] if item['role'] == 'tool']
            if not previous:
                name, args = 'search_knowledge', {'snapshot_id': contract['knowledge_snapshots'][0], 'query': '预算'}
            elif len(previous) == 1:
                name, args = 'create_file', {'path': 'source-report.md', 'content': '预算上限 100 元'}
            elif len(previous) == 2:
                match = json.loads(previous[0]['content'])['matches'][0]
                name, args = 'verify_source_claims', {'path': 'source-report.md', 'claims': [{'snapshot_id': contract['knowledge_snapshots'][0], 'source_id': match['source_id'], 'start_line': match['line'], 'quote': '预算上限 100 元', 'statement': '预算上限 100 元'}]}
            else:
                assert json.loads(previous[-1]['content'])['status'] == 'passed'
                yield {'text': '来源机械检查已完成，语义未检查。'}
                yield {'usage': {'total_tokens': 1}}
                return
            yield {'tool_calls': [{'id': f'source-check-{len(previous)}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}
            yield {'usage': {'total_tokens': 1}}
            return
        if messages[-1]['role'] == 'user' and messages[-1]['content'].startswith('模式权限样例'):
            mode = messages[-1]['content'].split()[-1]
            self.mode_schemas[mode] = [tool['function']['name'] for tool in tools or []]
            yield {'tool_calls': [{'id': 'mode-forged-1', 'type': 'function', 'function': {'name': 'create_file', 'arguments': json.dumps({'path': 'forbidden-mode.md', 'content': 'must not exist'})}}]}
            yield {'usage': {'total_tokens': 1}}
            return
        if messages[-1]['role'] == 'tool':
            projected = next((item['content'] for item in messages if item['role'] == 'user' and 'parent_task_goal' in item['content']), '')
            if projected:
                order = json.loads(projected.split('\nReturn only a JSON object', 1)[0])
                if order['goal'] == 'Submit workflow source claims':
                    match = json.loads(messages[-1]['content'])['matches'][0]
                    quote = '预算上限 100 元' if 'failed_source_verification' in order['inputs'] else '预算上限 999 元'
                    yield {'text': json.dumps({'path': 'workflow-report.md', 'claims': [{'snapshot_id': order['knowledge_snapshots'][0], 'source_id': match['source_id'], 'start_line': match['line'], 'quote': quote, 'statement': '预算上限 100 元'}]})}
                    yield {'usage': {'total_tokens': 1}}
                    return
            result = json.loads(messages[-1]['content'])
            if 'answer' in result:
                yield {'text': '已收到补充：' + result['answer']}
            elif 'matches' in result:
                yield {'text': '知识快照实际检索：' + (result['matches'][0]['text'] if result['matches'] else '无匹配来源')}
            elif 'text' in result:
                if any('Return only a JSON object with a patches array' in str(message.get('content', '')) for message in messages):
                    yield {'text': json.dumps({'patches': [{'path': 'note.md', 'content': result['text'], 'base_sha256': result['sha256']}]})}
                else:
                    yield {'text': '工作流真实读取：' + result['text']}
            elif 'sha256' in result:
                yield {'text': '已写入样例文件，结果以调用记录为准。'}
                yield {'tool_calls': [{'id': 'verify-written-1', 'type': 'function', 'function': {'name': 'run_tests', 'arguments': '{}'}}]}
            elif 'result' in result:
                yield {'text': 'MCP 真实调用已返回。'}
            elif 'tests_run' in result:
                yield {'text': f"独立测试实际执行 {result['tests_run']} 项：{result['status']}。"}
            else:
                yield {'text': '未写入：审批被拒绝或操作失败。'}
        elif '需要澄清' in messages[-1]['content']:
            yield {'tool_calls': [{'id': 'question-1', 'type': 'function', 'function': {'name': 'ask_user', 'arguments': json.dumps({'question': '请确认输出名称。'}, ensure_ascii=False)}}]}
        elif 'parent_task_goal' in messages[-1]['content']:
            order = json.loads(messages[-1]['content'].split('\nReturn only a JSON object', 1)[0])
            if order['goal'] == 'Create workflow source report':
                yield {'text': json.dumps({'patches': [{'path': 'workflow-report.md', 'content': '预算上限 100 元', 'base_sha256': None}]})}
                yield {'usage': {'total_tokens': 1}}
                return
            if order.get('knowledge_snapshots'):
                yield {'tool_calls': [{'id': 'flow-knowledge-1', 'type': 'function', 'function': {'name': 'search_knowledge', 'arguments': json.dumps({'snapshot_id': order['knowledge_snapshots'][0], 'query': '预算'})}}]}
            else:
                yield {'tool_calls': [{'id': 'flow-read-1', 'type': 'function', 'function': {'name': 'read_file', 'arguments': '{"path":"note.md"}'}}]}
        elif 'knowledge_snapshots' in messages[-1]['content'] and 'search_knowledge' in {item['function']['name'] for item in tools or []}:
            contract = json.loads(messages[-1]['content'].split('：', 1)[1])
            yield {'tool_calls': [{'id': 'knowledge-browser-1', 'type': 'function', 'function': {'name': 'search_knowledge', 'arguments': json.dumps({'snapshot_id': contract['knowledge_snapshots'][0], 'query': '预算'})}}]}
        elif 'MCP样例' in messages[-1]['content']:
            yield {'tool_calls': [{'id': 'mcp-browser-1', 'type': 'function', 'function': {'name': 'mcp_call', 'arguments': json.dumps({'name': 'reference_rules', 'arguments': {'topic': 'materials'}})}}]}
        elif '测试闭环样例' in messages[-1]['content']:
            yield {'tool_calls': [{'id': 'tests-browser-1', 'type': 'function', 'function': {'name': 'run_tests', 'arguments': '{}'}}]}
        elif '写入样例' in messages[-1]['content']:
            yield {'tool_calls': [{'id': 'write-1', 'type': 'function', 'function': {'name': 'create_file', 'arguments': json.dumps({'path': 'note.md', 'content': 'control acceptance content\n'})}}]}
        elif '停止样例' in messages[-1]['content']:
            yield {'text': '停止前保留的部分回复。'}
            await asyncio.sleep(30)
            yield {'text': '不应出现的后续回复。'}
        elif '长流式样例' in messages[-1]['content']:
            self.reconnect_calls += 1
            for index in range(40):
                yield {'text': f'\n\n### 核验段落 {index + 1}\n\n' + '这是用于真实流式渲染的虚构资料，检查来源、负责人及未完成项。' * 8 + '\n\n```python\n' + 'result = ' + repr('long-value-' * 30) + '\n```\n\n| 资料 | 状态 | 依据 |\n| --- | --- | --- |\n| 样例 | 待核对 | 未获得独立证据 |\n'}
                await asyncio.sleep(.025)
            yield {'text': '\n\n长流式结束标记。'}
        else:
            yield {'text': '独立测试回复。'}
        yield {'usage': {'total_tokens': 1}}


def main():
    out = ROOT / 'artifacts' / 'control-ui' / datetime.now().strftime('%Y%m%d-%H%M%S')
    out.mkdir(parents=True)
    task_directory = tempfile.TemporaryDirectory(prefix='lyagent-control-')
    workspace = Path(task_directory.name) / 'workspace'
    workspace.mkdir()
    evaluation = Path(task_directory.name) / 'evaluation'
    evaluation.mkdir()
    (evaluation / 'test_acceptance.py').write_text('import unittest\nfrom pathlib import Path\nclass Acceptance(unittest.TestCase):\n    def test_written_artifact(self):\n        self.assertEqual(Path("note.md").read_text(), "control acceptance content\\n")\n', encoding='utf-8')
    variables = {'LYAGENT_WORKSPACE': str(workspace), 'LYAGENT_ALLOW_WRITES': '1', 'LYAGENT_ALLOW_TESTS': '1', 'LYAGENT_EVALUATION_ROOT': str(evaluation.resolve()), 'LYAGENT_ENABLE_CAPABILITIES': '1', 'LYAGENT_MCP_URL': ''}
    previous = {key: os.environ.get(key) for key in variables}
    previous['LYAGENT_ENABLE_WORKFLOWS'] = os.environ.get('LYAGENT_ENABLE_WORKFLOWS')
    variables['LYAGENT_ENABLE_WORKFLOWS'] = '1'
    os.environ.update(variables)
    try:
        provider = ControlFixture()
        app = create_app(out / 'data', provider)
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    app.mount('/', StaticFiles(directory=ROOT / 'apps' / 'web' / 'dist', html=True), name='test-static-web')
    # Explicit fault fixture: bytes exist, but the dispatched invocation never settled.
    repo = app.state.repo
    definitions = app.state.definitions
    definitions.save('profile', 'reader', {'role': 'Browser workflow reader', 'model_ref': 'configured', 'tools': ['read_file'], 'capacity': 2}, 0)
    definitions.save('team', 'readers', {'profiles': ['reader@1']}, 0)
    nodes = [{'id': name, 'kind': 'worker', 'work_order': {'id': name, 'goal': 'Read the projected note', 'role': 'reader', 'tools': ['read_file'], 'paths': ['note.md']}} for name in ['first', 'second']]
    nodes.append({'id': 'join', 'kind': 'join', 'dependencies': ['first', 'second']})
    definitions.save('workflow', 'read-pair', {'nodes': nodes, 'outputs': ['join']}, 0)
    patch_order = {'id': 'patch', 'goal': 'Propose preserving verified bytes with an explicit baseline', 'role': 'reader', 'tools': ['read_file'], 'paths': ['note.md'], 'output_format': 'patches'}
    definitions.save('workflow', 'parent-patch', {'nodes': [{'id': 'patch', 'kind': 'worker', 'work_order': patch_order}], 'outputs': ['patch']}, 0)
    definitions.save('workflow', 'checked-patch', {'nodes': [{'id': 'patch', 'kind': 'worker', 'work_order': patch_order}, {'id': 'check', 'kind': 'verification', 'dependencies': ['patch']}], 'outputs': ['check']}, 0)
    definitions.save('profile', 'knowledge-reader', {'role': 'Read fixed rules', 'model_ref': 'configured', 'tools': ['search_knowledge']}, 0)
    definitions.save('team', 'knowledge-readers', {'profiles': ['knowledge-reader@1']}, 0)
    knowledge_order = {'id': 'rules', 'goal': 'Read budget from fixed task sources', 'role': 'reader', 'tools': ['search_knowledge'], 'use_task_knowledge': True}
    definitions.save('workflow', 'read-knowledge', {'nodes': [{'id': 'rules', 'kind': 'worker', 'work_order': knowledge_order}], 'outputs': ['rules']}, 0)
    source_order = {**knowledge_order, 'goal': 'Submit workflow source claims'}
    definitions.save('workflow', 'repair-source-claims', {'nodes': [{'id': 'claims', 'work_order': source_order}], 'outputs': ['claims']}, 0)
    write_order = {'id': 'write', 'goal': 'Create workflow source report', 'role': 'reader', 'paths': ['workflow-report.md'], 'output_format': 'patches'}
    definitions.save('workflow', 'check-knowledge', {'nodes': [{'id': 'write', 'work_order': write_order}, {'id': 'claims', 'dependencies': ['write'], 'work_order': source_order}, {'id': 'check', 'kind': 'source_check', 'claims_from': 'claims', 'dependencies': ['claims'], 'repair_ref': 'repair-source-claims@1', 'max_repairs': 2}], 'outputs': ['check']}, 0)
    recovery_conversation = repo.create()['id']
    repo.submit(recovery_conversation, '注入故障恢复样例', 'Agent', 'recovery-fixture-001')
    turn = repo.claim(recovery_conversation)
    content = b'recovery fixture effect\n'
    (workspace / 'recovery.md').write_bytes(content)
    repo.invocation(turn, 'tool_intent', {'invocation_id': 'recovery-write-1', 'tool': 'create_file'})
    repo.invocation(turn, 'tool_dispatch', {'invocation_id': 'recovery-write-1', 'tool': 'create_file', 'recovery': {'path': 'recovery.md', 'expected_sha256': hashlib.sha256(content).hexdigest(), 'base_sha256': None}})
    repo.finish(turn, 'cancelled')
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='error', timeout_graceful_shutdown=5))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            if not thread.is_alive():
                raise RuntimeError('Acceptance server exited before startup')
            time.sleep(.05)
        if not server.started:
            raise RuntimeError('Acceptance server startup timed out')
        browser_env = {**os.environ, 'LYAGENT_CONTROL_WORKSPACE': str(workspace), 'LYAGENT_CONTROL_EVALUATION': str(evaluation)}
        result = subprocess.run(['node', 'scripts/check_control_integration.mjs', f'http://127.0.0.1:{port}', str(out)], cwd=ROOT, env=browser_env, timeout=120, capture_output=True, text=True, encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        (out / 'browser.stdout.log').write_text(result.stdout, encoding='utf-8')
        (out / 'browser.stderr.log').write_text(result.stderr, encoding='utf-8')
        print(result.stdout)
        if result.returncode == 0:
            source_check = repo.db.execute('SELECT s.artifact_id,s.status,a.path,a.content FROM source_verifications s JOIN artifact_versions a ON a.id=s.artifact_id').fetchone()
            assert source_check and source_check['status'] == 'passed' and source_check['path'] == 'source-report.md'
            assert source_check['content'] == (workspace / 'source-report.md').read_text(encoding='utf-8') == '预算上限 100 元'
            review = repo.db.execute('SELECT decision FROM recovery_decisions WHERE turn_id=? AND invocation_id=?', (turn['id'], 'recovery-write-1')).fetchone()
            invocation = repo.db.execute('SELECT status FROM invocations WHERE turn_id=? AND id=?', (turn['id'], 'recovery-write-1')).fetchone()
            assert review and review['decision'] == 'reviewed_keep_state'
            assert invocation['status'] == 'unknown'
            assert not repo.workspace_granted(recovery_conversation)
            assert provider.reconnect_calls == 1
            assert provider.mode_schemas['Ask'] == []
            assert 'create_file' not in provider.mode_schemas['Plan']
            assert 'run_tests' not in provider.mode_schemas['Plan']
            assert not (workspace / 'forbidden-mode.md').exists()
            assert not repo.db.execute("SELECT 1 FROM events WHERE kind='tool_dispatch' AND payload LIKE '%mode-forged-1%'").fetchone()
            mcp_rows = repo.db.execute("SELECT i.status,i.result FROM invocations i WHERE i.tool='mcp_call'").fetchall()
            assert len(mcp_rows) == 2
            results = [json.loads(row['result']) for row in mcp_rows]
            assert sum('result' in item and not item['result']['isError'] for item in results) == 1
            assert sum('error' in item for item in results) == 1
            assert all(row['status'] == 'settled' for row in mcp_rows)
            verified_run = repo.db.execute("SELECT * FROM runs WHERE contract LIKE '%note.md%' AND status='completed'").fetchone()
            assert verified_run
            artifact = repo.db.execute('SELECT id FROM artifact_versions WHERE run_id=?', (verified_run['id'],)).fetchone()
            verification = repo.db.execute('SELECT * FROM verifications WHERE run_id=?', (verified_run['id'],)).fetchone()
            assert artifact and verification and verification['status'] == 'passed'
            assert artifact['id'] in json.loads(verification['artifact_ids'])
            assert json.loads(verification['result'])['tests_run'] == 1
        if result.returncode:
            print(result.stderr)
        summary = {'mode': 'deterministic-provider-real-http-sse-browser', 'build': BUILD, 'base': f'http://127.0.0.1:{port}', 'exit_code': result.returncode, 'live_model': False, 'api_or_sse_mocked': False}
        (out / 'manifest.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
        print(json.dumps({'report': str(out), **summary}))
        if result.returncode:
            raise SystemExit(result.returncode)
    finally:
        server.should_exit = True
        thread.join(timeout=15)
        listener.close()
        if thread.is_alive():
            raise RuntimeError('Acceptance server did not shut down')
        shutil.copytree(workspace, out / 'workspace', dirs_exist_ok=True)
        shutil.copytree(evaluation, out / 'evaluation', dirs_exist_ok=True)
        task_directory.cleanup()


if __name__ == '__main__':
    main()
