"""Windows cross-process durable budget for the authorized live acceptance batch."""
import json
import threading
import os
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / 'artifacts/contest-final/batch-20261111-authorized.json'
LOCK = threading.Lock()
REQUEST_CAP, TOKEN_CAP = 64, 200000
COMPARISON_LABELS = {scenario + '-' + variant for scenario in ('materials', 'python-maintenance') for variant in ('B0', 'B2')}


def select_comparison_batch(label):
    global PATH, REQUEST_CAP, TOKEN_CAP
    if os.environ.get('LYAGENT_LIVE_BATCH') != '20261112-comparison':
        return
    if label not in COMPARISON_LABELS:
        raise RuntimeError('This batch authorizes only the four scenario comparisons')
    PATH = ROOT / 'artifacts/contest-final/batch-20261112-comparison.json'
    REQUEST_CAP, TOKEN_CAP = 32, 120000
    with batch_lock():
        state = json.loads(PATH.read_text(encoding='utf-8'))
        if state.get('request_cap') != REQUEST_CAP or state.get('token_cap') != TOKEN_CAP or state.get('prior_requests') != 0 or state.get('prior_reported_tokens') != 0:
            raise RuntimeError('Comparison authorization mismatch')
        if label in state.get('started_labels', []):
            raise RuntimeError('Comparison already started; no automatic paid retry')
        state.setdefault('started_labels', []).append(label)
        save(state)


@contextmanager
def batch_lock():
    with LOCK:
        with PATH.with_suffix('.lock').open('a+b') as handle:
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                # Windows permits locking beyond EOF; initialize only while owning the byte.
                if not handle.read(1):
                    handle.write(b'0')
                    handle.flush()
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def save(state):
    temporary = PATH.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as handle:
        json.dump(state, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, PATH)


def wrap(provider, label):
    original = provider.stream

    async def stream(messages, tools=None):
        amount = len(json.dumps(messages, ensure_ascii=False).encode('utf-8')) + len(json.dumps(tools, ensure_ascii=False).encode('utf-8')) + 4096
        with batch_lock():
            state = json.loads(PATH.read_text(encoding='utf-8'))
            if state['request_cap'] != REQUEST_CAP or state['token_cap'] != TOKEN_CAP or any(row['status'] == 'unknown' for row in state['requests']):
                raise RuntimeError('Batch limits or unknown usage require review; no model dispatch')
            charged = state['prior_reported_tokens'] + sum(row.get('reported', row.get('reserved', 25000)) for row in state['requests'])
            if state['prior_requests'] + len(state['requests']) >= state['request_cap'] or charged + amount > state['token_cap']:
                raise RuntimeError('Authorized batch budget reached; no model dispatch')
            index = len(state['requests'])
            state['requests'].append({'label': label, 'status': 'reserved', 'reserved': amount})
            save(state)
        reported = None
        try:
            async for packet in original(messages, tools):
                usage = packet.get('usage')
                if usage is not None:
                    value = usage.get('total_tokens')
                    if type(value) is int and value >= 0:
                        reported = value
                yield packet
        finally:
            with batch_lock():
                state = json.loads(PATH.read_text())
                row = state['requests'][index]
                if reported is not None:
                    row.update(reported=reported, status='settled')
                else:
                    row['status'] = 'unknown'
                save(state)
    provider.stream = stream
    return provider
