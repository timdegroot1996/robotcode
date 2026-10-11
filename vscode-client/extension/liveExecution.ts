import * as path from "path";
import * as vscode from "vscode";
import { CONFIG_SECTION } from "./config";

// Live execution in the editor, fed by the `robotEvents` batches that robotcode's debugger forwards from
// robotframework-events (so only when Robot Dashboard is turned on):
// - the running keyword line gets a spinner in the gutter, the lines that called it a ring
//   (no line background: with fast keywords it flickers, the gutter is clear enough)
// - every line that ran gets a pass or fail mark that stays until the next run or until the file is edited
//   (the failure message itself is shown by the Test Explorer's inline message)
// - a status bar item shows the progress of the run

const HIGHLIGHT_SETTING = "liveExecution.highlightKeywords";
const RESULTS_SETTING = "liveExecution.showResults";
const PROGRESS_SETTING = "liveExecution.showProgress";
// how long the result of a finished run stays in the status bar
const RESULT_VISIBLE_MS = 10000;

type RobotEvent = { type: string; [key: string]: unknown };

type Location = { source: string; lineno: number };

type Frame = Location & { id: string };

type Ended = Location & { status: string };

class SessionState {
  // source of every started item that has not ended, for steps that inherit their parent's source
  readonly sources = new Map<string, string>();
  // running tests and steps in start order: the last one is the innermost
  readonly frames: Frame[] = [];
  planned = 0;
  done = 0;
  failed = 0;
  skipped = 0;
  currentTest: string | undefined;
  ended = false;
}

// Windows paths differ in drive letter case between Robot Framework and VS Code
function pathKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// updates one session from one event; returns the location and result of a test or step that ended
function applyEvent(state: SessionState, event: RobotEvent): Ended | undefined {
  const id = str(event.id);
  switch (event.type) {
    case "suite.started": {
      if (id === undefined) return undefined;
      const source = str(event.source);
      if (source !== undefined) state.sources.set(id, source);
      // the top-level suite knows every test the run will execute
      if (event.parent === undefined) {
        state.planned = Array.isArray(event.planned)
          ? event.planned.length
          : typeof event.tests === "number"
            ? event.tests
            : 0;
      }
      return undefined;
    }
    case "test.started":
    case "step.started": {
      if (id === undefined) return undefined;
      const parent = str(event.parent);
      const source = str(event.source) ?? (parent !== undefined ? state.sources.get(parent) : undefined);
      if (source === undefined) return undefined;
      state.sources.set(id, source);
      if (event.type === "test.started") state.currentTest = str(event.name);
      const lineno = typeof event.lineno === "number" ? event.lineno : 0;
      if (lineno > 0) state.frames.push({ id, source, lineno });
      return undefined;
    }
    case "test.ended":
    case "step.ended":
    case "suite.ended": {
      if (id === undefined) return undefined;
      state.sources.delete(id);
      const index = state.frames.findIndex((frame) => frame.id === id);
      const frame = index >= 0 ? state.frames[index] : undefined;
      if (index >= 0) state.frames.splice(index);
      if (event.type === "test.ended") {
        state.done++;
        if (event.status === "FAIL") state.failed++;
        else if (event.status === "SKIP") state.skipped++;
        state.currentTest = undefined;
      }
      if (frame === undefined) return undefined;
      return { source: frame.source, lineno: frame.lineno, status: str(event.status) ?? "" };
    }
    case "run.ended":
      state.frames.length = 0;
      state.ended = true;
      return undefined;
  }
  return undefined;
}

function lineRange(lineno: number): vscode.Range {
  return new vscode.Range(lineno - 1, 0, lineno - 1, 0);
}

export class LiveExecutionManager implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable;
  private readonly _sessions = new Map<string, SessionState>();
  // per file (pathKey) and line of the last run: true when it failed at least once
  private readonly _results = new Map<string, Map<number, boolean>>();
  private readonly _statusBar: vscode.StatusBarItem;
  private readonly _running: vscode.TextEditorDecorationType;
  private readonly _caller: vscode.TextEditorDecorationType;
  private readonly _passed: vscode.TextEditorDecorationType;
  private readonly _failed: vscode.TextEditorDecorationType;
  private _hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: vscode.ExtensionContext) {
    const icon = (name: string) => vscode.Uri.joinPath(context.extensionUri, "images", "live", `${name}.svg`);

    this._statusBar = vscode.window.createStatusBarItem("robotcode.liveExecution", vscode.StatusBarAlignment.Left, 0);
    this._statusBar.name = "Robot Framework Run Progress";

    this._running = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon("running"),
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("charts.orange"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
    this._caller = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon("caller"),
      gutterIconSize: "contain",
    });
    this._passed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon("passed"),
      gutterIconSize: "contain",
    });
    this._failed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: icon("failed"),
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this._disposables = vscode.Disposable.from(
      this._statusBar,
      this._running,
      this._caller,
      this._passed,
      this._failed,
      vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
        if (event.session.configuration.type !== "robotcode" || event.event !== "robotEvents") return;
        this.onEvents(event.session, (event.body as { events?: RobotEvent[] }).events ?? []);
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        const state = this._sessions.get(session.id);
        if (state === undefined) return;
        // a run that stopped without run.ended (stopped by the user, crashed) leaves no running lines behind
        state.frames.length = 0;
        state.ended = true;
        this.update();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.updateDecorations()),
      // marks of a file that is edited no longer match its lines
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        if (this._results.delete(pathKey(e.document.uri.fsPath))) this.updateDecorations();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          [HIGHLIGHT_SETTING, RESULTS_SETTING, PROGRESS_SETTING].some((s) =>
            e.affectsConfiguration(`${CONFIG_SECTION}.${s}`),
          )
        )
          this.update();
      }),
    );
  }

  dispose(): void {
    if (this._hideTimer !== undefined) clearTimeout(this._hideTimer);
    this._disposables.dispose();
  }

  private onEvents(session: vscode.DebugSession, events: RobotEvent[]): void {
    if (events.length === 0) return;
    for (const event of events) {
      if (event.type === "run.started") {
        // a new run replaces the results of runs that already finished
        for (const [id, state] of this._sessions) if (state.ended) this._sessions.delete(id);
        if (![...this._sessions.values()].some((s) => !s.ended)) this._results.clear();
        this._sessions.set(session.id, new SessionState());
      }
      const state = this._sessions.get(session.id);
      const ended = state !== undefined ? applyEvent(state, event) : undefined;
      if (ended !== undefined) this.record(ended);
    }
    this.update();
  }

  private record(ended: Ended): void {
    const key = pathKey(ended.source);
    if (ended.status !== "PASS" && ended.status !== "FAIL") return;
    let lines = this._results.get(key);
    if (lines === undefined) this._results.set(key, (lines = new Map()));
    lines.set(ended.lineno, lines.get(ended.lineno) === true || ended.status === "FAIL");
  }

  private update(): void {
    this.updateDecorations();
    this.updateStatusBar();
  }

  private updateDecorations(): void {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const highlight = config.get<boolean>(HIGHLIGHT_SETTING, true);
    const showResults = config.get<boolean>(RESULTS_SETTING, true);

    const running = new Map<string, Set<number>>();
    const callers = new Map<string, Set<number>>();
    const add = (target: Map<string, Set<number>>, key: string, lineno: number) => {
      let set = target.get(key);
      if (set === undefined) target.set(key, (set = new Set()));
      set.add(lineno);
    };
    if (highlight) {
      for (const state of this._sessions.values()) {
        state.frames.forEach((frame, index) => {
          add(index === state.frames.length - 1 ? running : callers, pathKey(frame.source), frame.lineno);
        });
      }
    }

    for (const editor of vscode.window.visibleTextEditors) {
      const key = pathKey(editor.document.uri.fsPath);
      const runningLines = running.get(key) ?? new Set<number>();
      // one mark per line: running beats caller beats a result
      const busy = (lineno: number) => runningLines.has(lineno) || (callers.get(key)?.has(lineno) ?? false);
      const callerLines = [...(callers.get(key) ?? [])].filter((lineno) => !runningLines.has(lineno));

      const passed: vscode.Range[] = [];
      const failed: vscode.Range[] = [];
      if (showResults) {
        for (const [lineno, didFail] of this._results.get(key) ?? []) {
          if (busy(lineno)) continue;
          (didFail ? failed : passed).push(lineRange(lineno));
        }
      }

      editor.setDecorations(this._running, [...runningLines].map(lineRange));
      editor.setDecorations(this._caller, callerLines.map(lineRange));
      editor.setDecorations(this._passed, passed);
      editor.setDecorations(this._failed, failed);
    }
  }

  private updateStatusBar(): void {
    if (!vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(PROGRESS_SETTING, true)) {
      this._statusBar.hide();
      return;
    }
    const states = [...this._sessions.values()];
    if (states.length === 0) return;
    const sum = (pick: (s: SessionState) => number) => states.reduce((total, s) => total + pick(s), 0);
    const [planned, done, failed, skipped] = [
      sum((s) => s.planned),
      sum((s) => s.done),
      sum((s) => s.failed),
      sum((s) => s.skipped),
    ];
    const running = states.some((s) => !s.ended);
    const icon = running ? "$(sync~spin)" : failed > 0 ? "$(error)" : "$(pass)";
    const counts = planned > 0 ? `${done}/${planned}` : `${done}`;
    this._statusBar.text = `${icon} ${counts} tests${failed > 0 ? ` · ${failed} failed` : ""}`;
    const current = states.map((s) => s.currentTest).filter((name) => name !== undefined);
    this._statusBar.tooltip = [
      running ? "Robot Framework run in progress" : "Robot Framework run finished",
      `${done - failed - skipped} passed, ${failed} failed, ${skipped} skipped`,
      ...current.map((name) => `Running: ${name}`),
    ].join("\n");
    this._statusBar.show();

    if (this._hideTimer !== undefined) clearTimeout(this._hideTimer);
    this._hideTimer = undefined;
    if (!running) {
      this._hideTimer = setTimeout(() => {
        // the status bar result goes away; the pass/fail marks stay until the next run
        for (const [id, state] of this._sessions) if (state.ended) this._sessions.delete(id);
        this._statusBar.hide();
      }, RESULT_VISIBLE_MS);
    }
  }
}
