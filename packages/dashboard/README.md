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

## Step screenshots

The Live page can play back a test with a screenshot after each step (robotframework-events 0.6.0 or newer).
Off by default, and no library gets screenshots until it is named:

```toml
[tool.robotcode-dashboard.screenshots]
mode = "actions"                          # off (default), actions, all or failure
libraries = ["Browser", "SeleniumLibrary"]
exclude = ["Browser.Hover"]
```

In VS Code, `robotcode.dashboard.stepScreenshots` (mode) and `robotcode.dashboard.screenshotLibraries` (added to
`libraries`) take precedence; `robotcode.dashboard.keepScreenshotRuns` (default 10) sets how many of the newest
history runs keep their screenshots. `robotcode debug` has `--execution-events-screenshots` and
`--execution-events-screenshot-libraries`. Presets, `include`, `custom` libraries and capture types: see the
robotframework-events README, "Step screenshots".
