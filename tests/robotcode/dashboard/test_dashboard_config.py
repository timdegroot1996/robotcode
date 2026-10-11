"""`[tool.robotcode-dashboard]` in robot.toml: the opt-in switch for the live view and the run history."""

from pathlib import Path

import pytest

from robotcode.dashboard.config import DashboardConfig, load_dashboard_config
from robotcode.plugin import Application


def app_for(project: Path) -> Application:
    app = Application()
    app.config.root = project
    return app


def test_not_set_without_section(tmp_path: Path) -> None:
    (tmp_path / "robot.toml").write_text("[profiles.default]\n", encoding="utf-8")
    config = load_dashboard_config(app_for(tmp_path), [tmp_path])
    assert config is None or config.enabled is None


@pytest.mark.parametrize("value", [True, False])
def test_reads_enabled(tmp_path: Path, value: bool) -> None:
    (tmp_path / "robot.toml").write_text(
        f"[tool.robotcode-dashboard]\nenabled = {str(value).lower()}\n", encoding="utf-8"
    )
    config = load_dashboard_config(app_for(tmp_path), [tmp_path])
    assert isinstance(config, DashboardConfig)
    assert config.enabled is value
