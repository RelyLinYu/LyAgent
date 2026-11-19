"""Explicit, bounded live acceptance: at most three provider requests, never prints secrets."""
import asyncio
import json
import os
import sys
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from apps.api.provider import Provider
from apps.api.executor import AgentExecutor
from apps.api.tools import FileTools


async def main():
    if '--live' not in sys.argv:
        raise SystemExit('Requires --live; uses the already authorized DEEPSEEK_API_KEY environment variable')
    root = Path(__file__).resolve().parents[1]
    model = Provider()
    model.base = 'https://api.deepseek.com'
    model.model = 'deepseek-chat'
    model.key = os.environ.get('DEEPSEEK_API_KEY', '')
    if not model.configured:
        raise SystemExit('No authorized model key in environment')
    out = root / 'artifacts' / 'contest-final' / datetime.now().strftime('%Y%m%d-%H%M%S-read-live')
    out.mkdir(parents=True, exist_ok=False)
    workspace = out / 'workspace'
    workspace.mkdir()
    (workspace / 'acceptance.md').write_text('Acceptance nonce: ly-20261110-read-7942\n', encoding='utf-8')
    events = []
    calls = 0
    from live_batch_budget import wrap
    wrap(model, 'current-read')
    original = model.stream

    async def bounded(messages, tools=None):
        nonlocal calls
        calls += 1
        if calls > 3:
            raise RuntimeError('Live acceptance request limit reached')
        async for packet in original(messages, tools):
            yield packet
    model.stream = bounded

    async def emit(kind, payload):
        events.append({'kind': kind, 'payload': payload})

    report = {'mode': 'live', 'model': model.model, 'created': datetime.now(timezone.utc).isoformat()}
    try:
        usage = await AgentExecutor(model, FileTools(workspace)).run([
            {'role': 'system', 'content': 'Use the provided read tool.'},
            {'role': 'user', 'content': '读取 acceptance.md，原样返回里面的 nonce。必须实际调用 read_file，不要猜测。'}
        ], 'Agent', emit)
        text = ''.join(e['payload'] for e in events if e['kind'] == 'text')
        used = any(e['kind'] == 'tool_result' and e['payload']['tool'] == 'read_file' and 'error' not in e['payload']['result'] for e in events)
        report.update({'passed': used and 'ly-20261110-read-7942' in text, 'usage': usage})
    except Exception:
        report.update({'passed': False, 'error': 'Live provider/protocol execution failed; no credentials or upstream body retained'})
    report.update({'requests': calls, 'events': events})
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'report': str(out / 'report.json'), 'passed': report['passed'], 'requests': calls, 'usage': report.get('usage')}, ensure_ascii=False))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
