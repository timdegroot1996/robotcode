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
