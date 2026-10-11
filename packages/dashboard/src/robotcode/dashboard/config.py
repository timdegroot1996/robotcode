from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

from robotcode.plugin import Application
from robotcode.robot.config.loader import load_robot_config_from_path
from robotcode.robot.config.model import BaseOptions, field
from robotcode.robot.config.utils import get_config_files

TOOL_NAME = "robotcode-dashboard"


@dataclass
class DashboardConfig(BaseOptions):
    """robotcode-dashboard configuration."""

    enabled: Optional[bool] = field(
        description="""\
            Turns on the live view and the run history: runs started by robotcode get the
            robotframework-events listener, and robotframework-dashboard keeps their history.
            Off by default. An explicit editor setting (VS Code `robotcode.dashboard.enabled`)
            or the `--execution-events` / `--no-execution-events` option of `robotcode debug`
            takes precedence.

            Examples:

            ```toml
            [tool.robotcode-dashboard]
            enabled = true
            ```
            """
    )


def load_dashboard_config(app: Application, paths: Sequence[Path] = ()) -> Optional[DashboardConfig]:
    """The `[tool.robotcode-dashboard]` section of the robot.toml files that apply to `paths` (default: cwd)."""
    config_files, _, _ = get_config_files(
        paths or None,
        app.config.config_files,
        root_folder=app.config.root,
        no_vcs=app.config.no_vcs,
        verbose_callback=app.verbose,
    )
    robot_config = load_robot_config_from_path(
        *config_files, extra_tools={TOOL_NAME: DashboardConfig}, verbose_callback=app.verbose
    )
    config = robot_config.tool.get(TOOL_NAME, None) if robot_config.tool is not None else None
    return config if isinstance(config, DashboardConfig) else None
