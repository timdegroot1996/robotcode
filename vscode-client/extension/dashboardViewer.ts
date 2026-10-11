import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as zlib from "zlib";
import { CONFIG_SECTION } from "./config";
import { DashboardSetup } from "./dashboardSetup";
import { ExecutionEventsBatch, ExecutionEventsHub, RobotEvent } from "./executionEvents";
import { LanguageClientsManager } from "./languageclientsmanger";

const VIEW_TYPE = "robotcode.dashboardViewer";
// robotdashboard --embed puts this on every script tag; the page runs under a CSP with a fresh nonce
const NONCE_PLACEHOLDER = "__ROBOTDASHBOARD_NONCE__";

type PageMessage =
  | { type: "ready" }
  | { type: "openSource"; source?: string; lineno?: number }
  | { type: "openLog"; path?: string }
  | { type: "replayEvents"; paths?: string[]; name?: string }
  | { type: "dataRequest" }
  | { type: "resolveFiles"; paths?: string[] };

// images the Live page may show (screenshots that steps log)
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

type RobotExitedBody = { outputFile?: string; logFile?: string; reportFile?: string };

// Shows robotdashboard (history plus its Live page) in a webview and feeds the Live page with the execution
// events of runs started from RobotCode and of runs started elsewhere (see ExecutionEventsHub). Opt-in: events
// only arrive when the dashboard is turned on (see DashboardSetup), and only runs that sent events go to the
// history.
// The page is generated once with `robotcode dashboard generate --embed`; it asks for its data, which
// `robotcode dashboard data` reads from the database, so a new run only reloads the page.
export class DashboardViewerManager implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable;
  private _panel: vscode.WebviewPanel | undefined;
  private _folder: vscode.WorkspaceFolder | undefined;
  // events of the current (or last) run, replayed to a page that (re)loads
  private _events: RobotEvent[] = [];
  // debug sessions that sent events: their runs go to the history
  private readonly _eventSessions = new Set<string>();
  private _shellReady = false;
  private _generating: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly setup: DashboardSetup,
    private readonly languageClientsManager: LanguageClientsManager,
    private readonly outputChannel: vscode.OutputChannel,
    events: ExecutionEventsHub,
  ) {
    this._disposables = vscode.Disposable.from(
      vscode.commands.registerCommand("robotcode.openRobotDashboard", () =>
        this.openOnRequest(vscode.workspace.workspaceFolders?.[0]),
      ),
      this.createSidebarView(),
      events.onDidReceiveEvents((batch) => this.onRobotEvents(batch)),
      // a run started elsewhere goes to the history with the result files it reported
      events.onDidEndRun((run) => {
        if (run.external && run.completed) void this.addExternalRunToHistory(run.folder);
      }),
      vscode.debug.onDidReceiveDebugSessionCustomEvent(async (event) => {
        if (event.session.configuration.type !== "robotcode" || event.event !== "robotExited") return;
        await this.addToHistory(event.session, event.body as RobotExitedBody);
      }),
    );
  }

  // the activity bar entry: an empty view whose welcome text has an open button; showing it opens the dashboard
  private createSidebarView(): vscode.Disposable {
    const view = vscode.window.createTreeView("robotcode.dashboardView", {
      treeDataProvider: { getChildren: () => [], getTreeItem: (item: vscode.TreeItem) => item },
    });
    return vscode.Disposable.from(
      view,
      view.onDidChangeVisibility((e) => {
        if (e.visible) void this.openOnRequest(vscode.workspace.workspaceFolders?.[0]);
      }),
    );
  }

  dispose(): void {
    this._panel?.dispose();
    this._disposables.dispose();
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION, this._folder);
  }

  private async onRobotEvents(batch: ExecutionEventsBatch): Promise<void> {
    const events = batch.events;
    if (events.length === 0) return;
    if (!batch.external) this._eventSessions.add(batch.key);
    if (events.some((e) => e.type === "run.started")) this._events = [];
    this._events.push(...events);

    if (this._panel) {
      void this._panel.webview.postMessage({ type: "events", events });
    } else if (this.config.get<boolean>("dashboard.openOnRun", true)) {
      await this.open(batch.folder ?? vscode.workspace.workspaceFolders?.[0], true);
    }
  }

  // the open command and the sidebar: a dashboard that is turned off offers to turn it on
  private async openOnRequest(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    if (!(await this.setup.isEnabled(folder))) {
      const answer = await vscode.window.showInformationMessage(
        "Robot Dashboard is turned off. Turn it on to see runs live and keep their history?",
        "Turn on",
      );
      if (answer !== "Turn on") return;
      await this.setup.enable();
    }
    await this.open(folder);
  }

  async open(folder: vscode.WorkspaceFolder | undefined, preserveFocus = false): Promise<void> {
    this._folder = folder ?? this._folder;
    if (this._panel) {
      this._panel.reveal(undefined, preserveFocus);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Robot Dashboard",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this._panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "images", "dashboard", "robotdashboard-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "images", "dashboard", "robotdashboard-dark.svg"),
    };
    panel.onDidDispose(() => {
      if (this._panel === panel) this._panel = undefined;
    });
    panel.webview.onDidReceiveMessage((message: PageMessage) => this.onPageMessage(message));
    panel.webview.html = loadingHtml("Generating Robot Dashboard...");

    await this.reload();
  }

  private onPageMessage(message: PageMessage): void {
    switch (message.type) {
      case "ready":
        // a (re)loaded page gets the events of the current run, then live batches
        if (this._events.length > 0) {
          void this._panel?.webview.postMessage({ type: "reset" });
          void this._panel?.webview.postMessage({ type: "events", events: this._events });
          void this._panel?.webview.postMessage({ type: "showPage", page: "live" });
        }
        break;
      case "openSource":
        void openSource(message.source, message.lineno);
        break;
      case "openLog":
        void this.openLog(message.path);
        break;
      case "replayEvents":
        this.replayEvents(message.paths ?? [], message.name);
        break;
      case "dataRequest":
        void this.sendData();
        break;
      case "resolveFiles":
        this.resolveFiles(message.paths ?? []);
        break;
    }
  }

  // webview urls for screenshots the page shows; only existing images in the archive or a workspace folder
  private resolveFiles(paths: string[]): void {
    const panel = this._panel;
    if (!panel) return;
    const files: Record<string, string> = {};
    for (const pagePath of paths) {
      const file = this.allowedFile(pagePath, IMAGE_EXTENSIONS);
      if (file) files[pagePath] = panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
    }
    void panel.webview.postMessage({ type: "files", files });
  }

  // answers the page's dataRequest with the history from the database
  private async sendData(): Promise<void> {
    const result = await this.setup.runRobotCode(this._folder, [
      "--format",
      "json",
      "dashboard",
      "data",
      "-d",
      this.databasePath(this._folder),
      "-n",
      this.dashboardPath(),
    ]);
    let data: Record<string, string> = {};
    if (result.ok) {
      try {
        data = JSON.parse(result.stdout) as Record<string, string>;
      } catch (e) {
        this.outputChannel.appendLine(`Robot Dashboard: unreadable data: ${String(e)}`);
      }
    }
    // an empty answer still lets the page start (without history)
    void this._panel?.webview.postMessage({ type: "dashboardData", ...data });
  }

  // a path the page sends, resolved like robotdashboard stores it (relative to the dashboard file with
  // --uselogs); only existing files with one of `extensions` in the archive or a workspace folder
  private allowedFile(pagePath: string, extensions: string[]): string | undefined {
    const resolved = path.resolve(path.dirname(this.dashboardPath()), pagePath);
    const roots = [
      this.archiveRoot(this._folder),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    ];
    const inside = roots.some((root) => {
      const relative = path.relative(root, resolved);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    const name = resolved.toLowerCase();
    return inside && extensions.some((ext) => name.endsWith(ext)) && fs.existsSync(resolved) ? resolved : undefined;
  }

  // sends the events file of a history run to the page, which replays it on its Live page
  private replayEvents(paths: string[], name: string | undefined): void {
    const file = paths.map((p) => this.allowedFile(p, [".jsonl", ".jsonl.gz"])).find((p) => p !== undefined);
    if (!file) {
      void this._panel?.webview.postMessage({
        type: "replayError",
        message:
          "This run has no events file. Runs recorded with robotframework-events have one next to their output.xml.",
      });
      return;
    }
    try {
      const data = fs.readFileSync(file);
      const text = (file.toLowerCase().endsWith(".gz") ? zlib.gunzipSync(data) : data).toString("utf-8");
      const events: RobotEvent[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as RobotEvent);
        } catch {
          // a line cut off by a crash
        }
      }
      void this._panel?.webview.postMessage({ type: "replay", events, name: name ?? path.basename(file) });
    } catch (e) {
      void this._panel?.webview.postMessage({ type: "replayError", message: `Could not read ${file}: ${String(e)}` });
    }
  }

  // opens a log.html that robotdashboard links to; only html files in the archive or a workspace folder
  private async openLog(logPath: string | undefined): Promise<void> {
    if (!logPath) return;
    const [file, fragment] = logPath.split("#", 2);
    const resolved = this.allowedFile(file, [".html"]);
    if (!resolved) {
      void vscode.window.showWarningMessage(`Robot Dashboard: log file not found: ${file}`);
      return;
    }
    await this.languageClientsManager.openOutputFile(vscode.Uri.file(resolved).with({ fragment: fragment ?? "" }));
  }

  private workspacePath(folder: vscode.WorkspaceFolder | undefined, setting: string, fallback: string): string {
    const value = this.config.get<string>(setting, fallback) || fallback;
    return path.isAbsolute(value) || !folder ? value : path.join(folder.uri.fsPath, value);
  }

  private databasePath(folder: vscode.WorkspaceFolder | undefined): string {
    // next to the archive in .robotdashboard/, which is git-ignored: nothing new shows up in the project
    const database = this.workspacePath(folder, "dashboard.database", ".robotdashboard/robot_results.db");
    ensureIgnoredFolder(path.dirname(database));
    return database;
  }

  private archiveRoot(folder: vscode.WorkspaceFolder | undefined): string {
    return this.workspacePath(folder, "dashboard.archiveFolder", ".robotdashboard/runs");
  }

  // the --embed page; paths of history runs are stored relative to it
  private dashboardPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, "robot_dashboard_embed.html");
  }

  // shows the page (generated once per session; its data comes with dataRequest); runs one at a time
  private reload(): Promise<void> {
    const run = this._generating.then(async () => {
      if (!this._shellReady) {
        fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
        const result = await this.setup.runRobotCode(this._folder, [
          "dashboard",
          "generate",
          "-d",
          this.databasePath(this._folder),
          "-n",
          this.dashboardPath(),
        ]);
        this._shellReady = result.ok;
        if (!result.ok) {
          if (this._panel)
            this._panel.webview.html = loadingHtml(
              "Robot Dashboard could not be shown: robotframework-dashboard is missing or too old in the project " +
                "environment. See the message or the RobotCode output for details.",
            );
          void this.setup.checkEnvironment(this._folder);
          return;
        }
      }
      if (this._panel)
        this._panel.webview.html = withNonce(fs.readFileSync(this.dashboardPath(), "utf-8"), this._panel.webview);
    });
    this._generating = run.catch(() => undefined);
    return run;
  }

  private async addToHistory(session: vscode.DebugSession, files: RobotExitedBody): Promise<void> {
    // only runs of an opted-in dashboard send events
    if (!this._eventSessions.delete(session.id)) return;
    await this.addRunToHistory(session.workspaceFolder, files);
  }

  // the result files come from the resultfile.created events of the run
  private async addExternalRunToHistory(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    const file = (kind: string) =>
      this._events.find((e) => e.type === "resultfile.created" && e.kind === kind)?.path as string | undefined;
    await this.addRunToHistory(folder, {
      outputFile: file("OUTPUT"),
      logFile: file("LOG"),
      reportFile: file("REPORT"),
    });
  }

  private async addRunToHistory(folder: vscode.WorkspaceFolder | undefined, files: RobotExitedBody): Promise<void> {
    if (!this.config.get<boolean>("dashboard.addRunsToHistory", true)) return;
    const existing = (file: string | undefined): string | undefined => {
      if (!file) return undefined;
      const full = path.isAbsolute(file) || !folder ? file : path.join(folder.uri.fsPath, file);
      return fs.existsSync(full) ? full : undefined;
    };
    const outputFile = existing(files.outputFile);
    if (!outputFile) return;
    this._folder = folder ?? this._folder;

    const archived = this.archiveRun(folder, outputFile, existing(files.logFile), existing(files.reportFile));
    const keep = this.config.get<number>("dashboard.keepRuns", 100);
    const result = await this.setup.runRobotCode(folder, [
      "dashboard",
      "add",
      archived,
      "-d",
      this.databasePath(folder),
      "--keep",
      String(Math.max(0, keep)),
    ]);
    if (!result.ok) void this.setup.checkEnvironment(folder);
    if (keep > 0) this.pruneArchive(folder, keep);
    // the page asks for the new data when it loads
    if (this._panel) await this.reload();
  }

  // copies the run's result files and events into their own folder, so every history run keeps its own log;
  // the events are gzipped (about 15 times smaller) and named like robotdashboard looks for them
  private archiveRun(
    folder: vscode.WorkspaceFolder | undefined,
    outputFile: string,
    logFile: string | undefined,
    reportFile: string | undefined,
  ): string {
    const run = this._events.find((e) => e.type === "run.started")?.run as string | undefined;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const target = path.join(this.archiveRoot(folder), run ? `${stamp}-${run.slice(0, 8)}` : stamp);
    try {
      fs.mkdirSync(target, { recursive: true });
      ensureIgnoredFolder(path.dirname(this.archiveRoot(folder)));
      fs.copyFileSync(outputFile, path.join(target, "output.xml"));
      if (logFile) fs.copyFileSync(logFile, path.join(target, "log.html"));
      if (reportFile) fs.copyFileSync(reportFile, path.join(target, "report.html"));
      if (this._events.length > 0) {
        const lines = this._events.map((e) => JSON.stringify(e)).join("\n") + "\n";
        fs.writeFileSync(path.join(target, "events.jsonl.gz"), zlib.gzipSync(lines));
      }
      return path.join(target, "output.xml");
    } catch (e) {
      this.outputChannel.appendLine(`Robot Dashboard: could not archive the run: ${String(e)}`);
      return outputFile;
    }
  }

  // keeps the newest `keep` run folders; folder names start with a sortable timestamp
  private pruneArchive(folder: vscode.WorkspaceFolder | undefined, keep: number): void {
    const root = this.archiveRoot(folder);
    try {
      const runs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{8}-\d{6}/.test(d.name))
        .map((d) => d.name)
        .sort();
      for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    } catch (e) {
      this.outputChannel.appendLine(`Robot Dashboard: could not prune the archive: ${String(e)}`);
    }
  }
}

// a folder of generated files that must not end up in version control
function ensureIgnoredFolder(folder: string): void {
  // only robotcode's own folder; a folder the user chose (for example the workspace root) is left alone
  if (path.basename(folder) !== ".robotdashboard") return;
  try {
    fs.mkdirSync(folder, { recursive: true });
    const ignore = path.join(folder, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  } catch {
    // not fatal: the dashboard still works
  }
}

async function openSource(source: string | undefined, lineno: number | undefined): Promise<void> {
  // only open existing files that the page names, never anything else
  if (!source || !path.isAbsolute(source) || !fs.existsSync(source)) return;
  const line = Math.max(0, (lineno ?? 1) - 1);
  await vscode.window.showTextDocument(vscode.Uri.file(source), {
    viewColumn: vscode.ViewColumn.One,
    selection: new vscode.Range(line, 0, line, 0),
  });
}

// a fresh nonce for the page's script tags, and a Content-Security-Policy that only allows those
function withNonce(html: string, webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource} data:`,
  ].join("; ");
  return html
    .split(NONCE_PLACEHOLDER)
    .join(nonce)
    .replace(/<head([^>]*)>/i, `<head$1><meta http-equiv="Content-Security-Policy" content="${csp}">`);
}

function loadingHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); padding: 16px">${escaped}</body></html>`;
}
