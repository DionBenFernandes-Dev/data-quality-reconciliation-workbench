import os
import sys
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
# Isolate API integration tests from any user run database or upload directory.
os.environ.setdefault("DQW_DATA_DIR", os.path.join(tempfile.gettempdir(), f"dqw-test-{os.getpid()}"))
