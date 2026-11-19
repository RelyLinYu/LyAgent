"""Test-only provider and server. Never loaded by the production application."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ['LYAGENT_WORKSPACE'] = str(ROOT / 'artifacts' / 'approval-ui' / 'workspace')
os.environ['LYAGENT_ALLOW_WRITES'] = '1'
from apps.api.main import create_app
from tests.test_approval_api import Provider

app = create_app(ROOT / 'artifacts' / 'approval-ui' / 'data', Provider())
