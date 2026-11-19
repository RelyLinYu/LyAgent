"""Explicit live B0/B2 observations against identical isolated scenario contracts."""
import argparse
import ast
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
from prepare_scenario import prepare
from live_batch_budget import wrap, select_comparison_batch


def safe_python(content):
    try:
        tree = ast.parse(content)
        allowed = (ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.Call, ast.Name, ast.Load, ast.Store, ast.GeneratorExp, ast.ListComp, ast.comprehension, ast.Compare, ast.IsNot, ast.Constant, ast.If, ast.Assign, ast.For, ast.AugAssign, ast.Add, ast.BinOp, ast.Pass, ast.Expr)
        return len(tree.body) == 1 and isinstance(tree.body[0], ast.FunctionDef) and tree.body[0].name == 'total' and all(isinstance(node, allowed) and (not isinstance(node, ast.Call) or isinstance(node.func, ast.Name) and node.func.id == 'sum') and (not isinstance(node, ast.Name) or not node.id.startswith('__')) for node in ast.walk(tree))
    except (SyntaxError, TypeError):
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('scenario', choices=['materials', 'python-maintenance'])
    parser.add_argument('variant', choices=['B0', 'B2'])
    parser.add_argument('--live', action='store_true', required=True)
    args = parser.parse_args()
    select_comparison_batch(args.scenario + '-' + args.variant)
    out = ROOT / 'artifacts/contest-final' / datetime.now().strftime('%Y%m%d-%H%M%S')
    out = out.with_name(out.name + '-' + args.scenario + '-' + args.variant + '-live')
    manifest = prepare(args.scenario, out)
    os.environ.update(LYAGENT_WORKSPACE=str(out / 'workspace'), LYAGENT_EVALUATION_ROOT=str(out / 'evaluation'), LYAGENT_ALLOW_WRITES='1', LYAGENT_ALLOW_TESTS='1', LYAGENT_ENABLE_WORKFLOWS='1', LYAGENT_ENABLE_CAPABILITIES='0')
    provider = Provider()
    provider.base, provider.model, provider.key = 'https://api.deepseek.com', 'deepseek-chat', os.environ.get('DEEPSEEK_API_KEY', '')
    if not provider.configured:
        raise SystemExit('Explicit key required')
    wrap(provider, args.scenario + '-' + args.variant)
    report = {'build': BUILD, 'live': True, 'scenario': args.scenario, 'variant': args.variant, 'task': manifest['comparison_tasks'][args.variant], 'approval_mode': 'isolated-sample-path-and-python-AST-controller', 'approvals': []}
    with TestClient(create_app(out / 'data', provider)) as client:
        headers = {'X-LyAgent-Token': client.get('/api/bootstrap').json()['token']}
        cid = client.post('/api/conversations', headers=headers).json()['id']
        url = '/api/conversations/' + cid
        task = report['task']
        client.post(url + '/messages', headers=headers, json={'content': task['goal'], 'mode': 'Agent', 'client_id': 'scenario-live-001', 'task': task}).raise_for_status()
        start = time.monotonic()
        while time.monotonic() - start < 660:
            state = client.get(url).json()
            for control in state['controls']:
                if control['status'] != 'pending':
                    continue
                arguments = json.loads(control['arguments'])
                approved = control['tool'] == 'run_tests' and arguments == {}
                if control['tool'] in {'create_file', 'replace_file'} and arguments.get('path') in task['required_artifacts']:
                    approved = args.scenario == 'materials' or safe_python(arguments.get('content', ''))
                client.post(url + '/approvals/' + control['id'], headers=headers, json={'arguments_hash': control['arguments_hash'], 'approved': approved}).raise_for_status()
                report['approvals'].append({'tool': control['tool'], 'hash': control['arguments_hash'], 'approved': approved})
            if state['turns'][-1]['status'] not in {'queued', 'running', 'waiting_approval'}:
                break
            time.sleep(.1)
        else:
            client.post(url + '/stop', headers=headers).raise_for_status()
            state = client.get(url).json()
        report.update(state=state, elapsed_seconds=round(time.monotonic() - start, 3), passed=state['runs'][0]['status'] == 'completed')
        report['input_evaluation_intact'] = all((out / name).exists() and hashlib.sha256((out / name).read_bytes()).hexdigest() == digest for name, digest in manifest['input_hashes'].items() if name != 'workspace/calculator.py')
        report['passed'] = report['passed'] and report['input_evaluation_intact']
        report['invocations'] = [dict(row) for row in client.app.state.repo.db.execute('SELECT * FROM invocations')]
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(out / 'report.json'), 'passed': report['passed'], 'budget': state['runs'][0]['budget'], 'reason': state['runs'][0]['reason']}))


if __name__ == '__main__':
    main()
