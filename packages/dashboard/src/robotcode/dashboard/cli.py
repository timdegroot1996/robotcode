import contextlib
import sys
from datetime import datetime
from importlib import metadata
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import click

from robotcode.plugin import Application, OutputFormat, pass_application

from .__version__ import __version__
from .config import load_dashboard_config

DEFAULT_DATABASE = "robot_results.db"
PACKAGES = ("robotframework", "robotframework-events", "robotframework-dashboard")


def _version(distribution: str) -> Optional[str]:
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError:
        return None


def _supports_embed() -> Optional[bool]:
    """Whether the installed robotframework-dashboard can generate pages for editors (--embed); None if missing."""
    try:
        import inspect

        from robotframework_dashboard.robotdashboard import RobotDashboard
    except ImportError:
        return None
    return "embed" in inspect.signature(RobotDashboard.__init__).parameters


def _robotdashboard(database: str, dashboard_name: Optional[Path], generate: bool, embed: bool) -> Any:
    """A RobotDashboard from the project environment; robotframework-dashboard is not a robotcode dependency."""
    try:
        from robotframework_dashboard.robotdashboard import RobotDashboard
    except ImportError as e:
        raise click.ClickException(
            "robotframework-dashboard is not installed in this environment "
            f"({sys.executable}): python -m pip install robotframework-dashboard"
        ) from e

    options: Dict[str, Any] = {
        "database_path": database,
        "generate_dashboard": generate,
        "dashboard_name": str(dashboard_name or "robot_dashboard.html"),
        # robotdashboard shows it in its title as local time
        "generation_datetime": datetime.now(),  # noqa: DTZ005
        "list_runs": False,
        "dashboard_title": "",
        "database_class": None,
        "json_config": "",
        "message_config": [],
        "quantity": 20,
        "use_logs": True,
        "offline_dependencies": True,
        "force_json_config": False,
        "project_version": None,
        "no_vacuum": False,
        "no_autoupdate": False,
    }
    if embed:
        options["embed"] = True
    try:
        return RobotDashboard(**options)
    except TypeError as e:
        raise click.ClickException(
            f"robotframework-dashboard {_version('robotframework-dashboard')} does not support editor hosts (--embed), "
            "upgrade it: python -m pip install -U robotframework-dashboard"
        ) from e


@click.group(add_help_option=True, invoke_without_command=False)
@click.version_option(version=__version__, package_name="robotcode.dashboard", prog_name="RobotCode Dashboard")
@pass_application
def dashboard(app: Application) -> None:
    """\
    Run history and live view with robotframework-dashboard and robotframework-events.

    Both packages are optional and installed in the project environment; robotcode only uses
    them when `[tool.robotcode-dashboard] enabled` (or an editor setting) turns them on.
    """


@dashboard.command()
@click.argument("paths", nargs=-1, type=click.Path(exists=True, path_type=Path))
@pass_application
def info(app: Application, paths: Tuple[Path, ...]) -> None:
    """\
    Shows the Python environment, the installed versions of robotframework, robotframework-events and
    robotframework-dashboard, and `[tool.robotcode-dashboard] enabled` from robot.toml.

    Editors use it (with `--format json`) to check what is missing in an environment.
    """
    config = load_dashboard_config(app, paths)
    enabled = config.enabled if config is not None else None
    versions: Dict[str, Optional[str]] = {name: _version(name) for name in PACKAGES}
    if app.config.output_format in (None, OutputFormat.TEXT):
        app.echo(f"Python: {sys.executable}")
        for name, version in versions.items():
            app.echo(f"{name}: {version or 'not installed'}")
        app.echo(f"enabled in robot.toml: {enabled if enabled is not None else 'not set'}")
        return
    data = {
        "python": sys.executable,
        "prefix": sys.prefix,
        "conda": (Path(sys.prefix) / "conda-meta").is_dir(),
        "enabled": enabled,
        "versions": versions,
        # what the installed versions can do, for checks that a version number alone cannot answer
        "features": {"embed": _supports_embed()},
    }
    app.print_data(data, remove_defaults=False)


@dashboard.command()
@click.option("-d", "--database", default=DEFAULT_DATABASE, show_default=True, help="The robotdashboard database.")
@click.option(
    "-n", "--name", "dashboard_name", required=True, type=click.Path(path_type=Path), help="The HTML file to write."
)
@click.option(
    "--embed / --no-embed",
    default=True,
    show_default=True,
    help="Write the page without data, for an editor that sends the data (see `robotcode dashboard data`).",
)
@pass_application
def generate(app: Application, database: str, dashboard_name: Path, embed: bool) -> None:
    """Generates the dashboard HTML file."""
    robotdashboard = _robotdashboard(database, dashboard_name, generate=True, embed=embed)
    with contextlib.redirect_stdout(sys.stderr):
        robotdashboard.initialize_database()
        robotdashboard.create_dashboard()
    app.verbose(f"Dashboard written to {dashboard_name}")


@dashboard.command()
@click.option("-d", "--database", default=DEFAULT_DATABASE, show_default=True, help="The robotdashboard database.")
@click.option(
    "-n",
    "--name",
    "dashboard_name",
    required=True,
    type=click.Path(path_type=Path),
    help="The --embed dashboard the data is for: paths of runs become relative to it.",
)
@pass_application
def data(app: Application, database: str, dashboard_name: Path) -> None:
    """\
    Prints the data of an --embed dashboard as JSON, for its host to send in a `dashboardData` message.
    """
    robotdashboard = _robotdashboard(database, dashboard_name, generate=False, embed=True)
    # robotdashboard reports its steps on stdout; only the data may go there
    with contextlib.redirect_stdout(sys.stderr):
        robotdashboard.initialize_database()
        payload = robotdashboard.get_embed_data()
    app.print_data(payload, remove_defaults=False, default_output_format=OutputFormat.JSON)


@dashboard.command()
@click.argument("outputs", nargs=-1, required=True, type=click.Path(exists=True, path_type=Path))
@click.option("-d", "--database", default=DEFAULT_DATABASE, show_default=True, help="The robotdashboard database.")
@click.option(
    "--keep",
    type=int,
    default=0,
    show_default=True,
    help="Keep only the newest N runs per project afterwards (0 keeps all).",
)
@pass_application
def add(app: Application, outputs: Tuple[Path, ...], database: str, keep: int) -> None:
    """Adds output.xml files to the robotdashboard database."""
    robotdashboard = _robotdashboard(database, None, generate=False, embed=False)
    with contextlib.redirect_stdout(sys.stderr):
        robotdashboard.initialize_database()
        robotdashboard.process_outputs(output_file_info_list=[(str(output), []) for output in outputs])
        if keep > 0:
            from robotframework_dashboard.arguments import ArgumentParser

            robotdashboard.remove_outputs(remove_runs=ArgumentParser()._process_remove_runs([f"limit={keep}"]))
