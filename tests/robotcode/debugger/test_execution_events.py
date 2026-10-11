"""Tests for batching robotframework-events events into `robotEvents` DAP events."""

import threading
import time
from typing import Any, Dict, List

from robotcode.debugger.execution_events import ExecutionEventsBatcher


def event(seq: int, type_: str = "step.started") -> Dict[str, Any]:
    return {"v": 1, "seq": seq, "t": 0.0, "type": type_}


def test_sends_full_batches_with_run_and_seq_range() -> None:
    batches: List[Dict[str, Any]] = []
    batcher = ExecutionEventsBatcher(batches.append, interval=60, max_events=3)
    batcher({**event(1, "run.started"), "run": "r1"})
    batcher(event(2))
    batcher(event(3))
    assert batches == [{"run": "r1", "from": 1, "to": 3, "events": batches[0]["events"]}]
    assert [e["seq"] for e in batches[0]["events"]] == [1, 2, 3]
    batcher.close()


def test_sends_partial_batch_after_interval() -> None:
    sent = threading.Event()
    batches: List[Dict[str, Any]] = []

    def send(batch: Dict[str, Any]) -> None:
        batches.append(batch)
        sent.set()

    batcher = ExecutionEventsBatcher(send, interval=0.01, max_events=100)
    batcher(event(1))
    assert sent.wait(2)
    assert batches[0]["events"] == [event(1)]
    batcher.close()


def test_run_ended_flushes_immediately_and_stops_the_timer() -> None:
    batches: List[Dict[str, Any]] = []
    batcher = ExecutionEventsBatcher(batches.append, interval=60, max_events=100)
    batcher(event(1))
    batcher(event(2, "run.ended"))
    assert [b["to"] for b in batches] == [2]
    time.sleep(0.05)
    batcher(event(3))
    batcher.flush()
    assert [b["to"] for b in batches] == [2, 3]


def test_concurrent_events_keep_order_and_none_are_lost() -> None:
    batches: List[Dict[str, Any]] = []
    batcher = ExecutionEventsBatcher(batches.append, interval=0.001, max_events=7)
    for seq in range(1, 1001):
        batcher(event(seq))
    batcher.close()
    seqs = [e["seq"] for b in batches for e in b["events"]]
    assert seqs == list(range(1, 1001))


# --- opt-in: no listener unless turned on ------------------------------------------------------

from pathlib import Path  # noqa: E402
from unittest.mock import patch  # noqa: E402

import pytest  # noqa: E402

from robotcode.dashboard.config import DashboardConfig  # noqa: E402
from robotcode.debugger.run import _execution_events_args, _execution_events_enabled  # noqa: E402
from robotcode.plugin import Application  # noqa: E402
from robotcode.plugin.specs import ToolConfig  # noqa: E402


def app_for(project: Path) -> Application:
    app = Application()
    app.config.root = project
    return app


def with_dashboard_plugin():  # type: ignore[no-untyped-def]
    return patch(
        "robotcode.plugin.manager.PluginManager.tool_config_classes",
        new=[ToolConfig("robotcode-dashboard", DashboardConfig)],
    )


@pytest.mark.parametrize("explicit", [True, False])
def test_explicit_option_wins_over_robot_toml(tmp_path: Path, explicit: bool) -> None:
    (tmp_path / "robot.toml").write_text(
        f"[tool.robotcode-dashboard]\nenabled = {str(not explicit).lower()}\n", encoding="utf-8"
    )
    with with_dashboard_plugin():
        assert _execution_events_enabled(app_for(tmp_path), explicit) is explicit


def test_robot_toml_decides_without_option(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "robot.toml").write_text("[tool.robotcode-dashboard]\nenabled = true\n", encoding="utf-8")
    with with_dashboard_plugin():
        assert _execution_events_enabled(app_for(tmp_path), None) is True


def test_off_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    with with_dashboard_plugin():
        assert _execution_events_enabled(app_for(tmp_path), None) is False


def test_off_adds_no_listener(tmp_path: Path) -> None:
    assert _execution_events_args(app_for(tmp_path), False) == []
