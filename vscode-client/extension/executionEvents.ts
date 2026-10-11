import * as fs from "fs";
import * as vscode from "vscode";
import { DashboardSetup } from "./dashboardSetup";

// Execution events of Robot Framework runs, from two sources:
// - runs started from RobotCode: the `robotEvents` batches that robotcode's debugger forwards
// - runs started elsewhere (a terminal, a task runner) with `--listener robotframework_events`: the
//   `events*.jsonl` file that robotframework-events writes, followed while it grows
// Files are only watched while Robot Dashboard is turned on for the workspace folder (opt-in). Runs
// started from RobotCode write the same file; it is recognized by the run id and not followed twice.

export type RobotEvent = { type: string; [key: string]: unknown };

export interface ExecutionEventsBatch {
  // the debug session id, or the events file and run id of a run started elsewhere
  readonly key: string;
  readonly folder: vscode.WorkspaceFolder | undefined;
  readonly events: RobotEvent[];
  // true for a run started outside RobotCode (followed through its events file)
  readonly external: boolean;
}

export interface ExecutionRunEnded {
  readonly key: string;
  readonly folder: vscode.WorkspaceFolder | undefined;
  readonly external: boolean;
  // false when the run stopped without run.ended (stopped, crashed)
  readonly completed: boolean;
}

const EVENTS_FILE_PATTERN = "**/events*.jsonl";
// DAP batches come every 100 ms: wait this long before a file run counts as started elsewhere
const DEBUG_RUN_GRACE_MS = 500;
// a file that is not followed by a watcher event is still read this often while its run goes on
const POLL_MS = 1000;
// a run whose file did not grow this long and whose process is gone has stopped without run.ended
const STALE_MS = 10000;
// a file that changes but holds a run that ended longer ago than this is an old run, not shown
const OLD_RUN_MS = 30000;
// the start of the file, to notice that the next run rewrote it
const HEAD_BYTES = 128;
const MAX_DEBUG_RUNS = 100;

class EventsFileTail {
  offset = 0;
  rest: Buffer = Buffer.alloc(0);
  head: Buffer = Buffer.alloc(0);
  runId: string | undefined;
  pid: number | undefined;
  // events that wait for the grace period before the run is announced
  pending: RobotEvent[] = [];
  announced = false;
  ignored = false;
  ended = false;
  startedAt = 0;
  lastGrowth = Date.now();
  graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly file: string,
    public folder: vscode.WorkspaceFolder,
  ) {}

  get key(): string {
    return `file:${this.file}#${this.runId ?? ""}`;
  }

  reset(): void {
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.head = Buffer.alloc(0);
    this.newRun(undefined, undefined);
  }

  newRun(runId: string | undefined, pid: number | undefined): void {
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.runId = runId;
    this.pid = pid;
    this.pending = [];
    this.announced = false;
    this.ignored = false;
    this.ended = false;
    this.startedAt = Date.now();
  }
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ExecutionEventsHub implements vscode.Disposable {
  private readonly _onDidReceiveEvents = new vscode.EventEmitter<ExecutionEventsBatch>();
  readonly onDidReceiveEvents = this._onDidReceiveEvents.event;
  private readonly _onDidEndRun = new vscode.EventEmitter<ExecutionRunEnded>();
  readonly onDidEndRun = this._onDidEndRun.event;

  private readonly _disposables: vscode.Disposable;
  private _watchers: vscode.Disposable[] = [];
  private _watchGeneration = 0;
  private readonly _tails = new Map<string, EventsFileTail>();
  // run ids of runs started from RobotCode, newest last
  private readonly _debugRuns: string[] = [];
  private _pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly setup: DashboardSetup) {
    this._disposables = vscode.Disposable.from(
      this._onDidReceiveEvents,
      this._onDidEndRun,
      vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
        if (event.session.configuration.type !== "robotcode" || event.event !== "robotEvents") return;
        const events = (event.body as { events?: RobotEvent[] }).events ?? [];
        if (events.length === 0) return;
        for (const e of events) {
          if (e.type === "run.started" && typeof e.run === "string") this.rememberDebugRun(e.run);
        }
        this._onDidReceiveEvents.fire({
          key: event.session.id,
          folder: event.session.workspaceFolder,
          events,
          external: false,
        });
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.configuration.type !== "robotcode") return;
        this._onDidEndRun.fire({ key: session.id, folder: session.workspaceFolder, external: false, completed: false });
      }),
      setup.onDidChange(() => {
        void this.updateWatchers();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.updateWatchers();
      }),
    );
    void this.updateWatchers();
  }

  dispose(): void {
    this._watchGeneration++;
    for (const watcher of this._watchers) watcher.dispose();
    this._watchers = [];
    for (const tail of this._tails.values()) if (tail.graceTimer !== undefined) clearTimeout(tail.graceTimer);
    this._tails.clear();
    this.updatePolling();
    this._disposables.dispose();
  }

  private rememberDebugRun(runId: string): void {
    this._debugRuns.push(runId);
    if (this._debugRuns.length > MAX_DEBUG_RUNS) this._debugRuns.shift();
    // a file run announced before the debugger's first batch arrived is the same run: drop it
    for (const tail of this._tails.values()) {
      if (tail.runId !== runId || tail.ignored) continue;
      tail.ignored = true;
      if (tail.announced && !tail.ended) {
        tail.ended = true;
        this._onDidEndRun.fire({ key: tail.key, folder: tail.folder, external: true, completed: false });
      }
    }
  }

  // one watcher per workspace folder that has the dashboard turned on
  private async updateWatchers(): Promise<void> {
    const generation = ++this._watchGeneration;
    const enabled: vscode.WorkspaceFolder[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (await this.setup.isEnabled(folder)) enabled.push(folder);
    }
    if (generation !== this._watchGeneration) return;

    for (const watcher of this._watchers) watcher.dispose();
    this._watchers = enabled.map((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, EVENTS_FILE_PATTERN));
      return vscode.Disposable.from(
        watcher,
        watcher.onDidCreate((uri) => this.onFileChanged(uri, folder)),
        watcher.onDidChange((uri) => this.onFileChanged(uri, folder)),
      );
    });
    // files of folders that were turned off are no longer followed
    for (const [file, tail] of this._tails) {
      if (enabled.includes(tail.folder)) continue;
      if (tail.announced && !tail.ended && !tail.ignored)
        this._onDidEndRun.fire({ key: tail.key, folder: tail.folder, external: true, completed: false });
      if (tail.graceTimer !== undefined) clearTimeout(tail.graceTimer);
      this._tails.delete(file);
    }
    this.updatePolling();
  }

  private onFileChanged(uri: vscode.Uri, folder: vscode.WorkspaceFolder): void {
    const file = uri.fsPath;
    let tail = this._tails.get(file);
    if (tail === undefined) this._tails.set(file, (tail = new EventsFileTail(file, folder)));
    tail.folder = folder;
    this.read(tail);
    this.updatePolling();
  }

  private read(tail: EventsFileTail): void {
    let data: Buffer;
    try {
      const fd = fs.openSync(tail.file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        // the next run truncates and rewrites the file: it is shorter or starts differently
        let restart = size < tail.offset;
        if (!restart && tail.head.length > 0) {
          const head = Buffer.alloc(tail.head.length);
          fs.readSync(fd, head, 0, head.length, 0);
          restart = !head.equals(tail.head);
        }
        if (restart) tail.reset();
        if (size === tail.offset) return;
        data = Buffer.alloc(size - tail.offset);
        const read = fs.readSync(fd, data, 0, data.length, tail.offset);
        data = data.subarray(0, read);
        if (tail.head.length < HEAD_BYTES && tail.offset === 0) {
          tail.head = Buffer.from(data.subarray(0, Math.min(HEAD_BYTES, data.length)));
        }
        tail.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // removed or not readable (yet)
      return;
    }
    tail.lastGrowth = Date.now();

    // only complete lines; the rest waits for the next read
    const buffer = tail.rest.length > 0 ? Buffer.concat([tail.rest, data]) : data;
    const end = buffer.lastIndexOf(0x0a);
    tail.rest = Buffer.from(buffer.subarray(end + 1));
    if (end < 0) return;
    const events: RobotEvent[] = [];
    for (const line of buffer.subarray(0, end).toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as RobotEvent);
      } catch {
        // a damaged line
      }
    }
    this.accept(tail, events);
  }

  private accept(tail: EventsFileTail, events: RobotEvent[]): void {
    let batch: RobotEvent[] = [];
    const flush = () => {
      if (batch.length > 0) this.deliver(tail, batch);
      batch = [];
    };
    for (const event of events) {
      if (event.type === "run.started") {
        flush();
        if (tail.announced && !tail.ended && !tail.ignored)
          this._onDidEndRun.fire({ key: tail.key, folder: tail.folder, external: true, completed: false });
        const runId = typeof event.run === "string" ? event.run : undefined;
        tail.newRun(runId, typeof event.pid === "number" ? event.pid : undefined);
        tail.ignored = runId === undefined || this._debugRuns.includes(runId);
      }
      if (tail.runId === undefined || tail.ignored) continue;
      batch.push(event);
    }
    flush();
  }

  private deliver(tail: EventsFileTail, events: RobotEvent[]): void {
    if (tail.announced) {
      this.fire(tail, events);
      return;
    }
    tail.pending.push(...events);
    if (tail.graceTimer !== undefined) return;
    const wait = Math.max(0, DEBUG_RUN_GRACE_MS - (Date.now() - tail.startedAt));
    tail.graceTimer = setTimeout(() => {
      tail.graceTimer = undefined;
      if (tail.ignored || tail.runId === undefined || this._debugRuns.includes(tail.runId)) {
        tail.ignored = true;
        tail.pending = [];
        return;
      }
      // a changed file that holds a run that ended a while ago (copied, touched): not a live run
      const ended = tail.pending.find((e) => e.type === "run.ended");
      if (ended !== undefined && typeof ended.t === "number" && Date.now() - ended.t * 1000 > OLD_RUN_MS) {
        tail.ignored = true;
        tail.pending = [];
        return;
      }
      tail.announced = true;
      const pending = tail.pending;
      tail.pending = [];
      this.fire(tail, pending);
    }, wait);
  }

  private fire(tail: EventsFileTail, events: RobotEvent[]): void {
    this._onDidReceiveEvents.fire({ key: tail.key, folder: tail.folder, events, external: true });
    if (events.some((e) => e.type === "run.ended")) {
      tail.ended = true;
      this._onDidEndRun.fire({ key: tail.key, folder: tail.folder, external: true, completed: true });
    }
    this.updatePolling();
  }

  // runs that go on are read regularly too: watcher events can be late or merged
  private updatePolling(): void {
    const active = [...this._tails.values()].some((t) => !t.ended && !t.ignored && t.runId !== undefined);
    if (active && this._pollTimer === undefined) {
      this._pollTimer = setInterval(() => this.poll(), POLL_MS);
    } else if (!active && this._pollTimer !== undefined) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private poll(): void {
    const now = Date.now();
    for (const tail of this._tails.values()) {
      if (tail.ended || tail.ignored || tail.runId === undefined) continue;
      this.read(tail);
      if (tail.ended || now - tail.lastGrowth < STALE_MS || isAlive(tail.pid)) continue;
      // stopped without run.ended: killed or crashed
      tail.ended = true;
      if (tail.announced)
        this._onDidEndRun.fire({ key: tail.key, folder: tail.folder, external: true, completed: false });
    }
    this.updatePolling();
  }
}
