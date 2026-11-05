from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
CLI = HERE.parents[1] / "engine" / "dist" / "cli.js"

sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

if not CLI.exists():
    pytest.exit(f"Build the Node package first (npm run build): {CLI} is missing", returncode=2)

# Tests run the engine from this checkout, not from npm.
os.environ["MCPWATCH_ENGINE"] = f'node "{CLI}"'


@pytest.fixture
def files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """Fresh events and pins files, so no test sees another's pinned tools or events."""
    out = {"events": tmp_path / "events.jsonl", "pins": tmp_path / "pins.json"}
    monkeypatch.setenv("MCPWATCH_EVENTS", str(out["events"]))
    monkeypatch.setenv("MCPWATCH_PINS", str(out["pins"]))
    for name in ("MCPWATCH_PROJECT_KEY", "MCPWATCH_MODE", "MCPWATCH_ENABLED", "MCPWATCH_AI"):
        monkeypatch.delenv(name, raising=False)
    return out


def read_events(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()] if path.exists() else []
