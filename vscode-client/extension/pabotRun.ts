import { randomUUID } from "crypto";
import * as path from "path";
import { RobotEvent } from "./executionEvents";

// Merges the items of one pabot run into one event stream, so the Live page, its replay and the history
// show one run. pabot starts one robot process per suite (or per test with --testlevelsplit), each with its
// own events file, run id and Robot Framework ids that start again at s1 in every process. The merged stream:
// - one run.started and one top-level suite; suites with the same full name in several items are one suite
// - new ids that follow the format (s1-s2-t1-k3), numbered in start order, so they never collide
// - run.ended once the last item pabot starts has ended (`pabot.last`), with the stats of all items
// - links in HTML messages (screenshots) relative to the merged output directory, so they point into the
//   item's folder (pabot_results/<n>/...) where the item wrote them
// The ids are not the ids of pabot's merged output.xml, which numbers suites in source order; `withLogIds` maps
// them once that file is there.

type Stats = { total: number; passed: number; failed: number; skipped: number };

interface Item {
  // item id -> merged id
  readonly ids: Map<string, string>;
  // the item's output directory relative to the run's, with "/" (for example "pabot_results/3")
  readonly folder: string | undefined;
  ended: boolean;
}

const LINK = /(<(?:img|a)\b[^>]*?\b(?:src|href)\s*=\s*)(["'])(.*?)\2/gi;

// links in an HTML message relative to `folder` instead of the item's output directory; URLs, absolute paths and
// fragments stay as they are
function relinked(html: string, folder: string): string {
  return html.replace(LINK, (match: string, start: string, quote: string, link: string) => {
    if (!link || link.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(link) || /^[\\/]/.test(link)) return match;
    return `${start}${quote}${path.posix.normalize(`${folder}/${link}`)}${quote}`;
  });
}

interface MergedSuite {
  // items in which the suite runs now
  open: number;
  startT: number;
  status: string;
  stats: Stats;
  message: string | undefined;
  // suite.ended was sent; with --testlevelsplit a later item can run the suite again
  ended: boolean;
}

const STATUS_ORDER = ["FAIL", "PASS", "SKIP", "NOT RUN"];

function worse(a: string, b: string): string {
  const ia = STATUS_ORDER.indexOf(a);
  const ib = STATUS_ORDER.indexOf(b);
  return ia < 0 ? b : ib < 0 ? a : ia <= ib ? a : b;
}

function addStats(target: Stats, value: unknown): void {
  const stats = value as Partial<Stats> | undefined;
  if (!stats) return;
  target.total += stats.total ?? 0;
  target.passed += stats.passed ?? 0;
  target.failed += stats.failed ?? 0;
  target.skipped += stats.skipped ?? 0;
}

function emptyStats(): Stats {
  return { total: 0, passed: 0, failed: 0, skipped: 0 };
}

// the folder pabot writes its items to (`<outputdir>/pabot_results`), from the output directory of an item
export function pabotResultsFolder(outputdir: string): string | undefined {
  const parts = outputdir.split(/[\\/]/);
  const index = parts.lastIndexOf("pabot_results");
  return index > 0 ? parts.slice(0, index + 1).join(path.sep) : undefined;
}

export class PabotRun {
  readonly run = randomUUID();
  private _seq = 0;
  private readonly _items = new Map<string, Item>();
  private readonly _indexes = new Set<number>();
  // merged suite id by full name, and their state
  private readonly _suiteIds = new Map<string, string>();
  private readonly _suites = new Map<string, MergedSuite>();
  // last child number per merged parent and kind (s, t, k)
  private readonly _counters = new Map<string, number>();
  private _lastStarted = false;
  private _started = false;
  private _ended = false;
  private _startT = 0;
  private readonly _stats = emptyStats();

  // `folder` is <outputdir>/pabot_results; pabot writes the merged output.xml to its parent
  constructor(readonly folder: string) {}

  get outputDir(): string {
    return path.dirname(this.folder);
  }

  // when the first item started, in seconds
  get startT(): number {
    return this._startT;
  }

  get ended(): boolean {
    return this._ended;
  }

  // every item has ended and pabot starts no more
  get complete(): boolean {
    return this._lastStarted && [...this._items.values()].every((item) => item.ended);
  }

  // an item index that this run already had: pabot started a new run in the same folder
  hasItem(index: number): boolean {
    return this._indexes.has(index);
  }

  // the merged events for events of one item (`item`: the key of its event stream)
  add(item: string, events: RobotEvent[]): RobotEvent[] {
    const out: RobotEvent[] = [];
    for (const event of events) {
      const merged = this.map(item, event);
      if (merged !== undefined) out.push(merged);
    }
    return out;
  }

  // an item that stopped without run.ended (killed, crashed)
  stop(item: string): void {
    const state = this._items.get(item);
    if (state !== undefined) state.ended = true;
  }

  // closes the top-level suite and the run
  finish(t: number = Date.now() / 1000): RobotEvent[] {
    if (this._ended || !this._started) return [];
    this._ended = true;
    const status = this._stats.failed > 0 ? "FAIL" : this._stats.passed > 0 ? "PASS" : "SKIP";
    return [
      this.event("suite.ended", t, {
        id: "s1",
        status,
        elapsed: Math.round((t - this._startT) * 1000) / 1000,
        stats: { ...this._stats },
      }),
      this.event("run.ended", t, { status, stats: { ...this._stats } }),
    ];
  }

  private event(type: string, t: number, fields: Record<string, unknown>): RobotEvent {
    return { v: 1, seq: ++this._seq, t, type, ...fields };
  }

  private renumber(event: RobotEvent, fields: Record<string, unknown>): RobotEvent {
    return { ...event, ...fields, seq: ++this._seq };
  }

  private child(parent: string, kind: "s" | "t" | "k"): string {
    const key = `${parent}|${kind}`;
    const next = (this._counters.get(key) ?? 0) + 1;
    this._counters.set(key, next);
    return `${parent}-${kind}${next}`;
  }

  private map(key: string, event: RobotEvent): RobotEvent | undefined {
    const t = typeof event.t === "number" ? event.t : Date.now() / 1000;
    if (event.type === "run.started") {
      const pabot = (event.pabot ?? {}) as { index?: number; processes?: number; last?: boolean };
      const folder =
        typeof event.outputdir === "string"
          ? path.relative(this.outputDir, event.outputdir).split(path.sep).join("/")
          : undefined;
      this._items.set(key, {
        ids: new Map(),
        folder: folder && !folder.startsWith("..") ? folder : undefined,
        ended: false,
      });
      if (typeof pabot.index === "number") this._indexes.add(pabot.index);
      if (pabot.last) this._lastStarted = true;
      if (this._started) return undefined;
      this._started = true;
      this._startT = t;
      return this.event("run.started", t, {
        run: this.run,
        rf: event.rf,
        python: event.python,
        cwd: event.cwd,
        outputdir: this.outputDir,
        pabot: { index: 0, ...(typeof pabot.processes === "number" ? { processes: pabot.processes } : {}) },
      });
    }

    const item = this._items.get(key);
    if (item === undefined) return undefined;
    const id = typeof event.id === "string" ? event.id : undefined;
    const parent = typeof event.parent === "string" ? item.ids.get(event.parent) : undefined;

    switch (event.type) {
      case "suite.started": {
        if (id === undefined) return undefined;
        const longname = String(event.longname ?? "");
        const top = event.parent === undefined;
        let merged = this._suiteIds.get(longname);
        const isNew = merged === undefined;
        if (merged === undefined) {
          if (!top && parent === undefined) return undefined;
          merged = top ? "s1" : this.child(parent as string, "s");
          this._suiteIds.set(longname, merged);
          this._suites.set(merged, {
            open: 0,
            startT: t,
            status: "",
            stats: emptyStats(),
            message: undefined,
            ended: false,
          });
        }
        item.ids.set(id, merged);
        const suite = this._suites.get(merged)!;
        suite.open++;
        // a suite that runs in several items starts once; the top-level suite has no total (items come later)
        if (!isNew) return undefined;
        // planned names only this item's tests
        const rest = { ...event };
        delete rest.planned;
        // the total of the run is not known up front: the page counts the tests it saw
        return this.renumber(rest, top ? { id: merged, tests: 0 } : { id: merged, parent });
      }
      case "suite.ended": {
        if (id === undefined) return undefined;
        const merged = item.ids.get(id);
        if (merged === undefined) return undefined;
        const suite = this._suites.get(merged)!;
        suite.open--;
        suite.status = suite.status ? worse(suite.status, String(event.status)) : String(event.status);
        addStats(suite.stats, event.stats);
        if (typeof event.message === "string" && event.message) suite.message = event.message;
        // the top-level suite ends with the run; another suite when no item runs it anymore
        if (merged === "s1" || suite.open > 0) return undefined;
        // ended before, ran again in a later item: only its status can change
        if (suite.ended)
          return this.event("status.changed", t, {
            id: merged,
            item: "suite",
            status: suite.status,
            ...(suite.message ? { message: suite.message } : {}),
          });
        suite.ended = true;
        return this.event("suite.ended", t, {
          id: merged,
          status: suite.status,
          ...(suite.message ? { message: suite.message } : {}),
          elapsed: Math.round((t - suite.startT) * 1000) / 1000,
          stats: { ...suite.stats },
        });
      }
      case "test.started":
      case "step.started": {
        if (id === undefined || parent === undefined) return undefined;
        const merged = this.child(parent, event.type === "test.started" ? "t" : "k");
        item.ids.set(id, merged);
        return this.renumber(event, { id: merged, parent });
      }
      case "step.screenshot": {
        // the image lies in the item's folder
        const merged = id !== undefined ? item.ids.get(id) : undefined;
        if (merged === undefined || typeof event.path !== "string") return undefined;
        const file = item.folder ? path.posix.normalize(`${item.folder}/${event.path}`) : event.path;
        return this.renumber(event, { id: merged, path: file });
      }
      case "test.ended":
      case "step.ended":
      case "status.changed": {
        const merged = id !== undefined ? item.ids.get(id) : undefined;
        return merged === undefined ? undefined : this.renumber(event, { id: merged });
      }
      case "message.logged":
        // messages outside any item (without parent) are kept as they are
        if (event.parent !== undefined && parent === undefined) return undefined;
        return this.renumber(event, {
          ...(parent !== undefined ? { parent } : {}),
          ...(event.html && typeof event.text === "string" && item.folder
            ? { text: relinked(event.text, item.folder) }
            : {}),
        });
      case "run.ended":
        item.ended = true;
        addStats(this._stats, event.stats);
        return undefined;
      default:
        // result files of an item (its own output.xml) are not the run's
        return undefined;
    }
  }
}

const XML_TAG = /<(\/?)(suite|test)\b([^>]*)>/g;
const XML_ATTRIBUTE = /(\w+)="([^"]*)"/g;

function xmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// the ids of the suites and tests in an output.xml by full name
export function outputIds(xml: string): Map<string, string> {
  const ids = new Map<string, string>();
  const suites: string[] = [];
  for (const match of xml.matchAll(XML_TAG)) {
    const [, closing, tag, attributes] = match;
    if (closing) {
      if (tag === "suite") suites.pop();
      continue;
    }
    const attrs = new Map([...attributes.matchAll(XML_ATTRIBUTE)].map((a) => [a[1], xmlText(a[2])]));
    const id = attrs.get("id");
    const name = attrs.get("name") ?? "";
    const parent = suites.at(-1);
    const full = parent !== undefined ? `${parent}.${name}` : name;
    if (id !== undefined && !ids.has(full)) ids.set(full, id);
    if (tag === "suite") suites.push(full);
  }
  return ids;
}

// The merged events with the ids of pabot's merged output.xml (`ids`, see outputIds), so links to its log.html
// open the right test and step. Suites and tests are matched by full name; a step keeps its place below its
// test or suite. Events of suites or tests that the file does not have keep their ids.
export function withLogIds(events: RobotEvent[], ids: Map<string, string>): RobotEvent[] {
  const mapped = new Map<string, string>();
  for (const event of events) {
    if ((event.type === "suite.started" || event.type === "test.started") && typeof event.id === "string") {
      const id = ids.get(String(event.longname ?? ""));
      if (id !== undefined) mapped.set(event.id, id);
    }
  }
  if (mapped.size === 0) return events;
  // the longest known prefix of an id, followed by the rest of it
  const map = (id: unknown): unknown => {
    if (typeof id !== "string") return id;
    for (let end = id.length; end > 0; end = id.lastIndexOf("-", end - 1)) {
      const prefix = mapped.get(id.slice(0, end));
      if (prefix !== undefined) return prefix + id.slice(end);
    }
    return id;
  };
  return events.map((event) => {
    if (event.id === undefined && event.parent === undefined) return event;
    const copy = { ...event };
    if (copy.id !== undefined) copy.id = map(copy.id);
    if (copy.parent !== undefined) copy.parent = map(copy.parent);
    return copy;
  });
}
