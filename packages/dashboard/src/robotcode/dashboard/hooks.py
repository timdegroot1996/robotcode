from typing import List

import click

from robotcode.plugin import hookimpl
from robotcode.plugin.specs import ToolConfig

from .cli import dashboard
from .config import TOOL_NAME, DashboardConfig


@hookimpl
def register_cli_commands() -> List[click.Command]:
    return [dashboard]


@hookimpl
def register_tool_config_classes() -> List[ToolConfig]:
    return [ToolConfig(TOOL_NAME, DashboardConfig)]
