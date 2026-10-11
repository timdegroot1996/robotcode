import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CONFIG_SECTION } from "./config";
import { PythonManager } from "./pythonmanger";

// Robot Dashboard and the live view are opt-in: robotcode installs nothing and adds no listener until the
// user turns them on, with the `robotcode.dashboard.enabled` setting, `[tool.robotcode-dashboard] enabled`
// in robot.toml, or the one-time introduction message. Turning them on checks the project environment and
// offers to install what is missing.

const ENABLED_SETTING = "dashboard.enabled";
const INTRODUCTION_STATE = "robotcode.dashboard.introduction"; // "enabled" | "dismissed"

const MIN_ROBOT_FRAMEWORK = "7.0";
const MIN_EVENTS = "0.5.0";
// decided when this ships; until then any installed robotframework-dashboard is accepted
const MIN_DASHBOARD: string | undefined = undefined;

export type EnvironmentInfo = {
  python: string;
  prefix: string;
  conda: boolean;
  enabled: boolean | null;
  versions: Record<string, string | null>;
  // embed: the installed robotframework-dashboard can generate pages for editors (null when not installed)
  features?: { embed?: boolean | null };
};

type Requirement = { name: string; minimum?: string };

const REQUIREMENTS: Requirement[] = [
  { name: "robotframework-events", minimum: MIN_EVENTS },
  { name: "robotframework-dashboard", minimum: MIN_DASHBOARD },
];

// the value the user set (folder, workspace or user level), undefined when not set anywhere
export function explicitDashboardSetting(folder: vscode.WorkspaceFolder | undefined): boolean | undefined {
  const inspected = vscode.workspace.getConfiguration(CONFIG_SECTION, folder).inspect<boolean>(ENABLED_SETTING);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

export function versionAtLeast(version: string | null | undefined, minimum: string | undefined): boolean {
  if (!version) return false;
  if (!minimum) return true;
  const parts = (v: string) => (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const [a, b] = [parts(version), parts(minimum)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return true;
}

// what is missing or too old, e.g. "robotframework-events (not installed)"
export function missingRequirements(info: EnvironmentInfo): { specs: string[]; descriptions: string[] } {
  const specs: string[] = [];
  const descriptions: string[] = [];
  for (const requirement of REQUIREMENTS) {
    const version = info.versions[requirement.name];
    // a dashboard without editor support (--embed) cannot be shown in the panel, whatever its version
    const noEmbed = requirement.name === "robotframework-dashboard" && version && info.features?.embed === false;
    if (noEmbed) {
      specs.push(requirement.name);
      descriptions.push(`${requirement.name} ${version} (needs a version that supports editors, --embed)`);
      continue;
    }
    if (versionAtLeast(version, requirement.minimum)) continue;
    specs.push(requirement.minimum ? `${requirement.name}>=${requirement.minimum}` : requirement.name);
    descriptions.push(
      version
        ? `${requirement.name} ${version} (needs ${requirement.minimum} or newer)`
        : `${requirement.name} (not installed)`,
    );
  }
  return { specs, descriptions };
}

// pip is right for plain virtual environments; projects managed by another tool get its own command
export function installCommand(
  folder: string | undefined,
  info: EnvironmentInfo,
  specs: string[],
): { command: string; pip: boolean } {
  const quoted = specs.map((s) => `"${s}"`).join(" ");
  const has = (file: string) => folder !== undefined && fs.existsSync(path.join(folder, file));
  if (has("uv.lock")) return { command: `uv add --dev ${quoted}`, pip: false };
  if (has("poetry.lock")) return { command: `poetry add --group dev ${quoted}`, pip: false };
  if (has("pdm.lock")) return { command: `pdm add -dG dev ${quoted}`, pip: false };
  if (has("pixi.toml") || has("pixi.lock")) return { command: `pixi add --pypi ${quoted}`, pip: false };
  if (has("hatch.toml"))
    return { command: `add ${specs.join(", ")} to the dependencies of your Hatch environment`, pip: false };
  const pipCommand = `"${info.python}" -m pip install -U ${quoted}`;
  if (info.conda) return { command: pipCommand, pip: false }; // let the user run it in the activated environment
  return { command: pipCommand, pip: true };
}

// what keeps a turned-on environment from working, for the "Robot Dashboard" language status item
export function environmentProblem(info: EnvironmentInfo): string | undefined {
  const robot = info.versions["robotframework"];
  if (!versionAtLeast(robot, MIN_ROBOT_FRAMEWORK))
    return `needs Robot Framework ${MIN_ROBOT_FRAMEWORK} or newer (${robot ?? "not installed"})`;
  const { descriptions } = missingRequirements(info);
  return descriptions.length > 0 ? `needs ${descriptions.join(" and ")}` : undefined;
}

// the switch for this folder: explicit setting first, then robot.toml (from a known environment info)
export function dashboardEnabledFor(
  folder: vscode.WorkspaceFolder | undefined,
  info: EnvironmentInfo | undefined,
): boolean {
  return explicitDashboardSetting(folder) ?? info?.enabled === true;
}

function activeFolder(): vscode.WorkspaceFolder | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri !== undefined ? vscode.workspace.getWorkspaceFolder(uri) : vscode.workspace.workspaceFolders?.[0];
}

export class DashboardSetup implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable;
  // fires when the switch or the installed packages change, so the language status item can refresh
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  // per Python executable: environments that are complete, and problems the user already answered this session
  private readonly _complete = new Set<string>();
  private readonly _answered = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly pythonManager: PythonManager,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this._disposables = vscode.Disposable.from(
      this._onDidChange,
      vscode.commands.registerCommand("robotcode.enableRobotDashboard", async () => {
        await this.setEnabled(activeFolder(), true);
      }),
      vscode.commands.registerCommand("robotcode.disableRobotDashboard", async () => {
        await this.setEnabled(activeFolder(), false);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(`${CONFIG_SECTION}.${ENABLED_SETTING}`)) return;
        this._onDidChange.fire();
        void this.updateContext();
        this._answered.clear();
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          if (explicitDashboardSetting(folder) !== true) continue;
          void this.checkEnvironment(folder).then((ready) => {
            if (ready)
              void vscode.window.showInformationMessage(
                "Robot Dashboard is on: runs started from RobotCode show up live and in the history.",
              );
          });
        }
      }),
      vscode.debug.onDidStartDebugSession((session) => {
        if (session.type !== "robotcode" || session.configuration.request !== "launch") return;
        void this.checkBeforeRun(session.workspaceFolder);
      }),
    );
    void this.updateContext();
    // after activation, without delaying it
    setTimeout(() => {
      this.showIntroduction().catch((e: unknown) => this.outputChannel.appendLine(String(e)));
    }, 5000);
  }

  dispose(): void {
    this._disposables.dispose();
  }

  // runs the bundled robotcode with the project's Python, so it sees the project's packages
  async runRobotCode(
    folder: vscode.WorkspaceFolder | undefined,
    args: string[],
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const python = await this.pythonManager.getPythonCommand(folder);
    if (!python) return { ok: false, stdout: "", stderr: "No Python environment selected" };
    const allArgs = [this.pythonManager.robotCodeMain, "--no-color", "--no-pager", ...args];
    this.outputChannel.appendLine(`Robot Dashboard: ${python} ${allArgs.join(" ")}`);
    return new Promise((resolve) => {
      cp.execFile(
        python,
        allArgs,
        {
          cwd: folder?.uri.fsPath,
          maxBuffer: 512 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        },
        (error, stdout, stderr) => {
          if (error) this.outputChannel.appendLine(`Robot Dashboard failed: ${stderr || error.message}`);
          resolve({ ok: !error, stdout, stderr });
        },
      );
    });
  }

  async environmentInfo(folder: vscode.WorkspaceFolder | undefined): Promise<EnvironmentInfo | undefined> {
    const result = await this.runRobotCode(folder, ["--format", "json", "dashboard", "info"]);
    if (!result.ok) return undefined;
    try {
      return JSON.parse(result.stdout) as EnvironmentInfo;
    } catch {
      return undefined;
    }
  }

  // explicit setting first, then robot.toml, off by default
  async isEnabled(folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    const explicit = explicitDashboardSetting(folder);
    if (explicit !== undefined) return explicit;
    return (await this.environmentInfo(folder))?.enabled === true;
  }

  // the `robotcode.dashboard.enabled` context key: shows or hides the Robot Dashboard sidebar entry
  async updateContext(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let enabled = folders.some((f) => explicitDashboardSetting(f) === true);
    if (!enabled) {
      // folders without an explicit setting follow their robot.toml
      for (const folder of folders.filter((f) => explicitDashboardSetting(f) === undefined)) {
        if (await this.isEnabled(folder)) {
          enabled = true;
          break;
        }
      }
    }
    await vscode.commands.executeCommand("setContext", "robotcode.dashboard.enabled", enabled);
  }

  // changes the setting where it is set now (folder, workspace or user), so the change takes effect;
  // not set anywhere: the user setting, like the introduction message
  async setEnabled(folder: vscode.WorkspaceFolder | undefined, value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder);
    const inspected = config.inspect<boolean>(ENABLED_SETTING);
    const target =
      inspected?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspected?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await config.update(ENABLED_SETTING, value, target);
    if (value) await this.context.globalState.update(INTRODUCTION_STATE, "enabled");
  }

  async enable(): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(ENABLED_SETTING, true, vscode.ConfigurationTarget.Global);
    await this.context.globalState.update(INTRODUCTION_STATE, "enabled");
  }

  private async showIntroduction(): Promise<void> {
    if (this.context.globalState.get<string>(INTRODUCTION_STATE)) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some((f) => explicitDashboardSetting(f) === true)) {
      await this.context.globalState.update(INTRODUCTION_STATE, "enabled");
      return;
    }
    const answer = await vscode.window.showInformationMessage(
      "RobotCode can show your test runs live, keyword by keyword, and keep their history in Robot Dashboard. " +
        "It uses robotframework-events and robotframework-dashboard in your project's Python environment.",
      "Enable",
      "Not now",
      "Don't show again",
    );
    if (answer === "Enable")
      await this.enable(); // the setting change checks the environment
    else if (answer === "Don't show again") await this.context.globalState.update(INTRODUCTION_STATE, "dismissed");
    // "Not now" (or closing the message): ask again at the next start
  }

  private async checkBeforeRun(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    if (explicitDashboardSetting(folder) === false) return;
    const python = await this.pythonManager.getPythonCommand(folder);
    if (python && this._complete.has(python)) return;
    const info = await this.environmentInfo(folder);
    if (!info) return;
    const enabled = explicitDashboardSetting(folder) ?? info.enabled === true;
    if (enabled) await this.checkEnvironment(folder, info);
  }

  // tells a user who turned it on exactly what is missing in this environment and offers to fix it
  async checkEnvironment(folder: vscode.WorkspaceFolder | undefined, known?: EnvironmentInfo): Promise<boolean> {
    const info = known ?? (await this.environmentInfo(folder));
    if (!info) {
      void vscode.window.showWarningMessage(
        "Robot Dashboard: could not check the Python environment. See the RobotCode output for details.",
      );
      return false;
    }
    const key = (problem: string) => `${info.python}|${problem}`;

    const robot = info.versions["robotframework"];
    if (!versionAtLeast(robot, MIN_ROBOT_FRAMEWORK)) {
      if (!this._answered.has(key("robot"))) {
        this._answered.add(key("robot"));
        void vscode.window.showWarningMessage(
          `Robot Dashboard and the live view need Robot Framework ${MIN_ROBOT_FRAMEWORK} or newer; ` +
            `this environment has ${robot ? `Robot Framework ${robot}` : "no Robot Framework"} (${info.python}).`,
        );
      }
      return false;
    }

    const { specs, descriptions } = missingRequirements(info);
    if (specs.length === 0) {
      this._complete.add(info.python);
      return true;
    }
    if (this._answered.has(key(specs.join(" ")))) return false;
    this._answered.add(key(specs.join(" ")));

    const { command, pip } = installCommand(folder?.uri.fsPath, info, specs);
    const text = `Robot Dashboard is turned on, but this environment needs ${descriptions.join(" and ")} (${info.python}).`;
    if (pip) {
      const answer = await vscode.window.showWarningMessage(text, "Install", "Copy command", "Not now");
      if (answer === "Install") return this.install(folder, info, specs, command);
      if (answer === "Copy command") await vscode.env.clipboard.writeText(command);
      return false;
    }
    const answer = await vscode.window.showWarningMessage(
      `${text} Install it with: ${command}`,
      "Copy command",
      "Not now",
    );
    if (answer === "Copy command") await vscode.env.clipboard.writeText(command);
    return false;
  }

  private async install(
    folder: vscode.WorkspaceFolder | undefined,
    info: EnvironmentInfo,
    specs: string[],
    command: string,
  ): Promise<boolean> {
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing ${specs.join(", ")}...` },
      () =>
        new Promise<boolean>((resolve) => {
          const args = ["-m", "pip", "install", "-U", ...specs];
          this.outputChannel.appendLine(`Robot Dashboard: ${info.python} ${args.join(" ")}`);
          const child = cp.spawn(info.python, args, { cwd: folder?.uri.fsPath, env: process.env });
          child.stdout?.on("data", (data) => this.outputChannel.append(String(data)));
          child.stderr?.on("data", (data) => this.outputChannel.append(String(data)));
          child.on("error", () => resolve(false));
          child.on("close", (code) => resolve(code === 0));
        }),
    );
    this._answered.clear();
    this._onDidChange.fire();
    if (!ok) {
      const answer = await vscode.window.showErrorMessage(
        `Installing ${specs.join(", ")} failed, see the RobotCode output. Command: ${command}`,
        "Copy command",
      );
      if (answer === "Copy command") await vscode.env.clipboard.writeText(command);
      return false;
    }
    const after = await this.environmentInfo(folder);
    const done = after !== undefined && missingRequirements(after).specs.length === 0;
    if (done) {
      this._complete.add(info.python);
      void vscode.window.showInformationMessage(
        "Robot Dashboard is ready. Runs started from RobotCode now show up live and in the history.",
      );
    }
    return done;
  }
}
