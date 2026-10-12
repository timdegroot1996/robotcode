# robotcode-dashboard

RobotCode plugin for [robotframework-dashboard](https://github.com/MarketSquare/robotframework-dashboard) and
[robotframework-events](https://github.com/timdegroot1996/robotframework-events): run history and the live view
of running tests in editors.

Both packages are optional and installed in the project environment. Nothing is used until it is turned on:

```toml
[tool.robotcode-dashboard]
enabled = true
```

Commands: `robotcode dashboard info`, `generate`, `data` and `add` (see `robotcode dashboard --help`).

In VS Code, the dashboard's Live page shows runs from the Test Explorer, runs started elsewhere in the workspace
(`robot` or `pabot` with `--listener robotframework_events.Listener`, followed through their `events*.jsonl`
files) and pabot runs as one run. Every finished run goes to the history; a run that crashed gets an
`output.xml` rebuilt from its events. See the robotframework-dashboard
[Live View documentation](https://github.com/MarketSquare/robotframework-dashboard/blob/main/docs/live-view.md).
