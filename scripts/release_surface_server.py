"""Exercise the production unconfigured UI using isolated data and no model keys."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    environment = {k: v for k, v in os.environ.items() if not k.startswith('LYAGENT_') and k not in {'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'}}
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='lyagent-release-surface-') as data:
        process = subprocess.Popen([sys.executable, 'scripts/serve.py', '--port', str(port), '--data-dir', str(Path(data) / 'database')], cwd=ROOT, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError('Isolated surface server exited')
                try:
                    with urllib.request.urlopen(base + '/api/health', timeout=1) as response:
                        health = json.load(response)
                    assert health['configured'] is False
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('Isolated surface server timed out')
            workspace = Path(data) / 'workspace'
            evaluation = Path(data) / 'evaluation'
            workspace.mkdir()
            evaluation.mkdir()
            environment['LYAGENT_SURFACE_WORKSPACE'] = str(workspace)
            environment['LYAGENT_SURFACE_EVALUATION'] = str(evaluation)
            subprocess.run(['node', 'scripts/check_release_surface.mjs', base], cwd=ROOT, env=environment, check=True, timeout=120)
        finally:
            if os.name == 'nt' and process.poll() is None:
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            elif process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=15)


if __name__ == '__main__':
    main()
