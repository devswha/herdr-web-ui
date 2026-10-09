/**
 * Durable, socket-scoped references to native transcripts, never copies of their messages.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SavedConversation, ResumeConversationResponse } from "../shared/conversation-history.ts";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { codexHistorySegments, defaultCodexHome } from "./codex.ts";
import { codexTranscriptImage } from "./codex-images.ts";
import { ConversationUnavailable, piTranscriptImage, resolveTranscript, transcriptImage, transcriptPage, transcriptToolOutput, type ConversationPage, type RecognizedConversation, type StreamSource } from "./conversation.ts";
import { herdrRpc, herdrSocketPath, paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { historyShellInputEmpty } from "./history-shell.ts";
import { defaultPiSessionDir } from "./pi.ts";
import { omoSessionFolder } from "./omo.ts";
import { startShellAgent } from "./shell-agent.ts";

type Source = StreamSource;
/** DB sessions need a separate archival identity/reader; never treat their DB as JSONL. */
function archiveSource(value: RecognizedConversation["source"]): Source | null {
  switch (value) {
    case "claude-transcript": case "codex-transcript": case "omo-transcript":
    case "omp-transcript": case "pi-transcript": case "gjc-transcript": return value;
    case "opencode-transcript": case "devin-transcript": return null;
    default: { const unreachable: never = value; return unreachable; }
  }
}
type Entry = {
  readonly id: string;
  readonly source: Source;
  readonly path: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly desiredOpen: boolean;
  readonly error: string | null;
  readonly binding: OwnedBinding | null;
  readonly observedBoot: string | null;
  readonly attemptBoot: string | null;
  readonly restoreState: "started" | "failed" | null;
};
type Binding = ResumeConversationResponse;
type OwnedBinding = Binding & { readonly terminal_id: string };
type ProcessInfo = { readonly shell_pid?: number; readonly foreground_processes?: readonly { readonly pid: number; readonly argv?: readonly string[] }[] };
function idleShell(info: ProcessInfo): boolean {
  const processes = info.foreground_processes ?? [];
  const shell = processes[0];
  const argv = shell?.argv ?? [];
  return processes.length === 1 && shell !== undefined && shell.pid === info.shell_pid
    && /^(?:bash|zsh|sh|dash|ksh|fish|nu|pwsh|powershell|cmd)(?:\.exe)?$/i.test(basename(argv[0] ?? "").replace(/^-/, ""))
    && argv.slice(1).every((argument) => /^(?:-[il]+|--login|--interactive|-NoLogo|-NoProfile)$/i.test(argument));
}
/** Only process-facing effects are injectable; files, validation and parsing stay real. */
export interface ConversationHistoryRuntime {
  readonly snapshot: () => Promise<SessionSnapshot>;
  readonly resolve: (pane: HerdrPane, snapshot: SessionSnapshot) => Promise<{ source: RecognizedConversation["source"]; path: string }>;
  readonly create: (cwd: string, title: string) => Promise<OwnedBinding>;
  readonly start: (paneId: string, args: string[]) => Promise<void>;
  readonly close: (workspaceId: string) => Promise<void>;
  readonly bootIdentity: () => string | null;
  readonly processInfo: (paneId: string) => Promise<ProcessInfo>;
  readonly inputIdle: (paneId: string) => Promise<boolean>;
}
export interface ConversationHistoryOptions {
  readonly stateDir: string;
  readonly codexHome?: string;
  /** OmO agent-state directory, not the user's home; contains sessions/. */
  readonly omoHome?: string;
  readonly runtime?: ConversationHistoryRuntime;
  /** An override requires a matching runtime: shell startup otherwise uses HERDR_SOCKET. */
  readonly socketPath?: string;
  /** Opt-in: production enables this; unrelated tests do not restart agents. */
  readonly autoRestore?: boolean;
}
export class ConversationHistoryError extends Error {
  constructor(readonly code: "history_registry_unavailable" | "history_stopped" | "conversation_not_found" | "conversation_unavailable" | "resume_unsupported" | "resume_failed", message: string) {
    super(message);
    this.name = "ConversationHistoryError";
  }
}

const HEAD_BYTES = 64 * 1024;
const INDEX_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERY_FILES = 4096;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (source: Source, path: string, sessionId: string) => hash(`${source}\0${path}\0${sessionId}`);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const absent = (error: unknown) => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function source(value: unknown): value is Source {
  return value === "claude-transcript" || value === "codex-transcript" || value === "omo-transcript" || value === "omp-transcript" || value === "pi-transcript" || value === "gjc-transcript";
}
function entry(value: unknown, socket: string): value is Entry {
  return object(value) && source(value.source) && typeof value.path === "string" && isAbsolute(value.path)
    && typeof value.sessionId === "string" && SESSION_ID.test(value.sessionId)
    && typeof value.cwd === "string" && isAbsolute(value.cwd) && typeof value.title === "string"
    && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) && typeof value.desiredOpen === "boolean"
    && (value.error === null || typeof value.error === "string")
    && (value.binding === null || (object(value.binding) && typeof value.binding.pane_id === "string" && typeof value.binding.workspace_id === "string" && typeof value.binding.terminal_id === "string"))
    && (value.observedBoot === null || typeof value.observedBoot === "string")
    && (value.attemptBoot === null || typeof value.attemptBoot === "string")
    && (value.restoreState === null || value.restoreState === "started" || value.restoreState === "failed")
    && value.id === hash(`${socket}\0${identity(value.source, value.path, value.sessionId)}`);
}
function inside(root: string, path: string): string {
  const canonical = realpathSync(path);
  const rel = relative(realpathSync(root), canonical);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !canonical.endsWith(".jsonl")) {
    throw new ConversationUnavailable("transcript_outside_store");
  }
  return canonical;
}
/** Regular files only, including when a FIFO or symlink replaces a saved transcript. */
function head(path: string): { text: string; tail: string; updatedAt: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ConversationUnavailable("transcript_not_file");
    const bytes = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    const text = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
    const tailAt = Math.max(bytes.length, stat.size - HEAD_BYTES);
    const tailBytes = Buffer.alloc(stat.size - tailAt);
    const tail = tailBytes.subarray(0, readSync(fd, tailBytes, 0, tailBytes.length, tailAt)).toString("utf8");
    return { text, tail: tailAt > bytes.length ? tail.slice(tail.indexOf("\n") + 1) : tail, updatedAt: stat.mtimeMs };
  } finally { closeSync(fd); }
}
/** Bounded directory enumeration; no recursive traversal into artifacts or children. */
function names(path: string, limit: number): string[] {
  let directory;
  try { directory = opendirSync(path); } catch (error) { if (absent(error)) return []; throw error; }
  try {
    const found: string[] = [];
    for (let scanned = 0; scanned < limit; scanned++) {
      const item = directory.readSync();
      if (item === null) break;
      if (!item.isSymbolicLink()) found.push(item.name);
    }
    return found;
  } finally { directory.closeSync(); }
}
function sessionName(text: string): string | null {
  let name: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"session_info"')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (object(value) && value.type === "session_info" && typeof value.name === "string" && value.name.trim()) name = value.name.slice(0, 512);
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return name;
}

export class ConversationHistory {
  private readonly entries = new Map<string, Entry>();
  private readonly live = new Map<string, Binding>();
  private readonly resuming = new Map<string, Promise<Binding>>();
  private readonly launched = new Map<string, Binding>();
  private readonly runtime: ConversationHistoryRuntime;
  private readonly omoHome: string;
  private readonly codexHome: string;
  private readonly socket: string;
  private readonly registry: string;
  private readonly autoRestore: boolean;
  private boot: string | null = null;
  private stopped = false;
  private pendingOperations = 0;
  private disk: string | null;
  private observations: Promise<void> = Promise.resolve();

  constructor(options: ConversationHistoryOptions) {
    this.socket = resolve(options.socketPath ?? herdrSocketPath());
    if (!options.runtime && this.socket !== resolve(herdrSocketPath())) throw new ConversationHistoryError("history_registry_unavailable", "socket override requires its own runtime");
    this.omoHome = resolve(options.omoHome ?? process.env["OMO_CODING_AGENT_DIR"] ?? process.env["SENPI_CODING_AGENT_DIR"] ?? process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".omo", "agent"));
    this.codexHome = options.codexHome ?? defaultCodexHome();
    this.registry = join(options.stateDir, `conversations-${hash(this.socket)}.json`);
    this.autoRestore = options.autoRestore ?? false;
    this.runtime = options.runtime ?? {
      snapshot: () => sessionSnapshot(this.socket),
      // The fifth argument belongs to OpenCode. History's OmO policy is the sixth.
      resolve: (pane, snapshot) => resolveTranscript(pane, pane.cwd ?? "", this.codexHome, snapshot.panes, undefined, { agentDir: this.omoHome, exactOnly: true }),
      create: async (cwd, title) => {
        const created = await workspaceCreate({ cwd, label: title }, this.socket);
        return { pane_id: created.root_pane.pane_id, workspace_id: created.workspace.workspace_id, terminal_id: created.root_pane.terminal_id };
      },
      start: (paneId, args) => {
        if (resolve(herdrSocketPath()) !== this.socket) throw new ConversationHistoryError("resume_failed", "Herdr socket changed during resume");
        return startShellAgent("omo", paneId, args);
      },
      close: (workspaceId) => workspaceClose(workspaceId, this.socket),
      bootIdentity: () => {
        try {
          const socket = statSync(this.socket);
          return `${socket.dev}:${socket.ino}:${socket.birthtimeMs}`;
        } catch (error) { if (absent(error)) return null; throw error; }
      },
      processInfo: async (paneId) => {
        const response = await herdrRpc<{ process_info: ProcessInfo }>("pane.process_info", { pane_id: paneId }, this.socket);
        return response.process_info;
      },
      inputIdle: async (paneId) => {
        const screen = await paneRead({ paneId, source: "detection", format: "text" }, this.socket);
        return !screen.truncated && historyShellInputEmpty(screen.text);
      },
    };
    this.disk = this.readRegistry();
    if (this.disk !== null) {
      try {
        const data: unknown = JSON.parse(this.disk);
        if (!object(data) || data.version !== 1 || data.socket !== this.socket || !Array.isArray(data.entries) || !(data.boot === null || typeof data.boot === "string")) throw new SyntaxError("invalid history registry");
        this.boot = data.boot;
        for (const value of data.entries) {
          if (!entry(value, this.socket) || this.entries.has(value.id)) throw new SyntaxError("invalid history entry");
          this.entries.set(value.id, value);
          if (value.restoreState === "started" && value.binding && value.observedBoot === this.runtime.bootIdentity()) {
            this.launched.set(value.id, value.binding);
          }
        }
      } catch (error) { throw new ConversationHistoryError("history_registry_unavailable", errorText(error)); }
    }
    this.discover();
  }

  private readRegistry(): string | null {
    try {
      const fd = openSync(this.registry, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > INDEX_BYTES) throw new ConversationHistoryError("history_registry_unavailable", "invalid history registry file");
        return readFileSync(fd, "utf8");
      } finally { closeSync(fd); }
    } catch (error) {
      if (absent(error)) return null;
      throw new ConversationHistoryError("history_registry_unavailable", errorText(error));
    }
  }

  private persist(): void {
    if (this.readRegistry() !== this.disk) throw new ConversationHistoryError("history_registry_unavailable", "history registry changed outside this service");
    const data = JSON.stringify({ version: 1, socket: this.socket, boot: this.boot, entries: [...this.entries.values()] });
    if (Buffer.byteLength(data) > INDEX_BYTES) throw new ConversationHistoryError("history_registry_unavailable", "history registry is full");
    if (data === this.disk) return;
    mkdirSync(dirname(this.registry), { recursive: true, mode: 0o700 });
    const temporary = `${this.registry}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.registry);
      this.disk = data;
      const directory = openSync(dirname(this.registry), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      try { unlinkSync(temporary); } catch (cleanup) { if (!absent(cleanup)) throw new ConversationHistoryError("history_registry_unavailable", errorText(cleanup)); }
      throw new ConversationHistoryError("history_registry_unavailable", errorText(error));
    }
  }

  private metadata(resolved: { source: Source; path: string }, fallbackCwd: string): Entry {
    const home = process.env["HOME"] ?? homedir();
    const roots: Record<Source, string> = {
      "omo-transcript": join(this.omoHome, "sessions"), "codex-transcript": join(this.codexHome, "sessions"),
      "claude-transcript": join(home, ".claude", "projects"), "omp-transcript": join(home, ".omp", "agent", "sessions"),
      "gjc-transcript": join(home, ".gjc", "agent", "sessions"), "pi-transcript": defaultPiSessionDir(),
    };
    const path = inside(roots[resolved.source], resolved.path);
    const sampled = head(path);
    const first: unknown = JSON.parse(sampled.text.split("\n")[0] ?? "");
    if (!object(first)) throw new ConversationUnavailable("invalid_transcript_header");
    let sessionId: string;
    let cwd: string;
    switch (resolved.source) {
      case "claude-transcript":
        sessionId = basename(path, ".jsonl");
        cwd = typeof first.cwd === "string" ? first.cwd : fallbackCwd;
        if (!/^[0-9a-f-]{36}$/i.test(sessionId) || (first.sessionId !== undefined && first.sessionId !== sessionId)) throw new ConversationUnavailable("invalid_transcript_header");
        break;
      case "codex-transcript": {
        const header = first.payload;
        if (first.type !== "session_meta" || !object(header) || typeof header.id !== "string" || typeof header.cwd !== "string"
          || (header.source && typeof header.source !== "string") || header.source === "subagent" || header.agent_role
          || (header.thread_source && header.thread_source !== "user")) throw new ConversationUnavailable("invalid_transcript_header");
        sessionId = header.id; cwd = header.cwd;
        break;
      }
      case "omo-transcript":
      case "omp-transcript":
      case "gjc-transcript":
      case "pi-transcript":
        if (first.type !== "session" || typeof first.id !== "string" || typeof first.cwd !== "string") throw new ConversationUnavailable("invalid_transcript_header");
        sessionId = first.id; cwd = first.cwd;
        break;
      default: {
        const unreachable: never = resolved.source;
        throw new ConversationUnavailable(String(unreachable));
      }
    }
    if (!SESSION_ID.test(sessionId) || !isAbsolute(cwd)) throw new ConversationUnavailable("invalid_transcript_header");
    if (resolved.source === "omo-transcript") {
      const rel = relative(realpathSync(roots["omo-transcript"]), path).split(sep);
      if (rel.length !== 2 || rel[0] !== omoSessionFolder(cwd)
        || !/^\d{4}-\d\d-\d\dT[\d-]+Z_/.test(basename(path)) || !basename(path).endsWith(`_${sessionId}.jsonl`)
        || first.parentSession || first.parentSessionId || first.subagent || first.isSubagent || first.agentRole) throw new ConversationUnavailable("invalid_omo_session");
    }
    return { id: hash(`${this.socket}\0${identity(resolved.source, path, sessionId)}`), source: resolved.source, path, sessionId, cwd,
      title: sessionName(sampled.text + "\n" + sampled.tail) ?? basename(cwd), updatedAt: sampled.updatedAt, desiredOpen: false, error: null,
      binding: null, observedBoot: null, attemptBoot: null, restoreState: null };
  }

  private discover(): void {
    const root = join(this.omoHome, "sessions");
    let remaining = MAX_DISCOVERY_FILES;
    for (const directory of names(root, 1024)) {
      if (!directory.startsWith("--") || !directory.endsWith("--")) continue;
      for (const name of names(join(root, directory), remaining)) {
        if (--remaining < 0) break;
        if (!name.endsWith(".jsonl")) continue;
        try {
          const found = this.metadata({ source: "omo-transcript", path: join(root, directory, name) }, "");
          if (!this.entries.has(found.id)) this.entries.set(found.id, found);
        } catch (error) { if (!(error instanceof Error)) throw error; /* a malformed discovery candidate is not a saved record */ }
      }
      if (remaining <= 0) break;
    }
    this.persist();
  }

  private get(id: string): Entry {
    const found = this.entries.get(id);
    if (!found) throw new ConversationHistoryError("conversation_not_found", "saved conversation not found");
    return found;
  }
  private validate(record: Entry): Entry {
    try {
      const current = this.metadata(record, record.cwd);
      if (current.id !== record.id || current.cwd !== record.cwd || current.path !== record.path) throw new ConversationUnavailable("transcript_identity_changed");
      return current;
    } catch (error) { throw new ConversationHistoryError("conversation_unavailable", errorText(error)); }
  }
  private public(record: Entry): SavedConversation {
    let current = record;
    let available = true;
    let error = record.error;
    try { current = this.validate(record); } catch (failure) { if (!(failure instanceof ConversationHistoryError)) throw failure; available = false; error = failure.message; }
    const binding = this.live.get(record.id);
    let canResume = available && record.source === "omo-transcript";
    if (canResume) {
      try { canResume = statSync(record.cwd).isDirectory(); } catch (failure) { if (!(failure instanceof Error)) throw failure; canResume = false; }
      if (!canResume) error = "conversation_cwd_unavailable";
    }
    return { id: record.id, agent: record.source.replace("-transcript", ""), title: current.title === basename(record.cwd) ? record.title : current.title, cwd: record.cwd,
      updated_at: current.updatedAt, session_id: record.sessionId, pane_id: binding?.pane_id ?? null,
      state: available ? binding ? "open" : "closed" : "unavailable", can_resume: canResume || (available && binding !== undefined), error };
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    const operation = this.observations.then(run).finally(() => { this.pendingOperations--; });
    this.observations = operation.then(() => {}, (error: unknown) => { if (!(error instanceof Error)) throw error; });
    return operation;
  }
  /** In-flight reads may finish, but no queued work may start another agent. */
  stop(): void { this.stopped = true; }
  private active(): void {
    if (this.stopped) throw new ConversationHistoryError("history_stopped", "conversation history service stopped");
  }
  observe(snapshot: SessionSnapshot): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const refresh = this.pendingOperations > 0;
    return this.serialize(async () => this.observeSnapshot(refresh ? await this.runtime.snapshot() : snapshot, this.autoRestore));
  }
  private async observeSnapshot(snapshot: SessionSnapshot, restore: boolean): Promise<void> {
    this.active();
    const boot = this.runtime.bootIdentity();
    const bindings = new Map<string, Binding>();
    for (const pane of snapshot.panes) {
      if (!pane.cwd) continue;
      try {
        const resolved = await this.runtime.resolve(pane, snapshot);
        const kind = archiveSource(resolved.source);
        if (kind === null) continue;
        const found = this.metadata({ source: kind, path: resolved.path }, pane.cwd);
        const previous = this.entries.get(found.id);
        const binding = { pane_id: pane.pane_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id };
        const title = pane.label || (found.title !== basename(found.cwd) ? found.title : pane.title || pane.terminal_title_stripped || pane.display_agent || found.title);
        this.entries.set(found.id, { ...found, title, desiredOpen: previous?.desiredOpen === true || !this.live.has(found.id),
          binding, observedBoot: boot, attemptBoot: previous?.attemptBoot ?? null });
        bindings.set(found.id, binding);
      } catch (error) { if (!(error instanceof Error)) throw error; /* unresolved is not evidence for any other transcript */ }
    }
    this.active();
    this.live.clear();
    for (const [id, binding] of bindings) this.live.set(id, binding);
    const targets: Entry[] = [];
    for (const record of this.entries.values()) {
      if (!record.desiredOpen || !record.binding || bindings.has(record.id) || boot === null) continue;
      if ([...bindings.values()].some((binding) => binding.pane_id === record.binding?.pane_id
        && binding.workspace_id === record.binding?.workspace_id)) {
        // /new or /resume replaced this pane's conversation; retain the old history, not its launch intent.
        this.entries.set(record.id, { ...record, desiredOpen: false, restoreState: null });
        this.launched.delete(record.id);
        continue;
      }
      // A previous-boot record stays pending even if its first new snapshot has no pane yet.
      // A recorded attempt is never automatically replayed after a Web UI restart.
      if (record.observedBoot !== null && record.observedBoot !== boot) {
        if (restore && record.source === "omo-transcript" && record.attemptBoot !== boot) targets.push(record);
      } else {
        const pane = snapshot.panes.find((candidate) => candidate.pane_id === record.binding?.pane_id && candidate.workspace_id === record.binding?.workspace_id);
        let closed = pane === undefined;
        if (pane) {
          // An unreadable resolver is not proof of closure. An actual idle shell is.
          try { closed = idleShell(await this.runtime.processInfo(pane.pane_id)); }
          catch (error) { if (!(error instanceof Error)) throw error; }
        }
        if (closed) {
          this.entries.set(record.id, { ...record, desiredOpen: false, restoreState: null });
          this.launched.delete(record.id);
        }
      }
    }
    this.active();
    this.boot = boot ?? this.boot;
    this.persist();
    for (const target of targets) await this.restore(target, snapshot, boot);
  }

  private async restore(record: Entry, snapshot: SessionSnapshot, boot: string | null): Promise<void> {
    this.active();
    if (boot === null || record.binding === null) return;
    try {
      const original = record.binding;
      const pane = snapshot.panes.find((candidate) => candidate.pane_id === original.pane_id);
      if (!pane) {
        this.entries.set(record.id, { ...record, error: "original_restore_pane_pending" });
        this.persist();
        return;
      }
      if (pane.workspace_id !== original.workspace_id || pane.cwd !== record.cwd || (pane.foreground_cwd && pane.foreground_cwd !== record.cwd)
        || pane.terminal_id === original.terminal_id) throw new ConversationUnavailable("original_restore_pane_unavailable");
      this.validate(record);
      if (!statSync(record.cwd).isDirectory()) throw new ConversationUnavailable("conversation_cwd_unavailable");
      // Recheck every exact session before launch: another pane may already have resumed it.
      const fresh = await this.runtime.snapshot();
      const current = fresh.panes.find((candidate) => candidate.pane_id === pane.pane_id);
      if (!current) {
        this.entries.set(record.id, { ...record, error: "original_restore_pane_pending" });
        this.persist();
        return;
      }
      if (current.workspace_id !== pane.workspace_id || current.cwd !== record.cwd || (current.foreground_cwd && current.foreground_cwd !== record.cwd) || current.terminal_id !== pane.terminal_id
        || this.runtime.bootIdentity() !== boot) throw new ConversationUnavailable("original_restore_pane_changed");
      await this.observeSnapshot(fresh, false);
      if (this.live.has(record.id)) return;
      const info = await this.runtime.processInfo(pane.pane_id);
      this.active();
      if (!idleShell(info)) {
        throw new ConversationUnavailable("original_restore_pane_busy");
      }
      if (!(await this.runtime.inputIdle(pane.pane_id))) throw new ConversationUnavailable("original_restore_input_busy");
      this.active();
      if (this.runtime.bootIdentity() !== boot) throw new ConversationUnavailable("original_restore_pane_changed");
      // Claim the input operation durably, but never consume a not-yet-restored pane's attempt.
      this.entries.set(record.id, { ...record, attemptBoot: boot, restoreState: "failed", error: "automatic restore was interrupted" });
      this.persist();
      await this.runtime.start(pane.pane_id, ["--session", record.path]);
      const binding = { pane_id: pane.pane_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id };
      this.entries.set(record.id, { ...record, binding, observedBoot: boot, attemptBoot: boot, restoreState: "started", error: null });
      this.live.set(record.id, binding);
      this.launched.set(record.id, binding);
    } catch (error) {
      const current = this.get(record.id);
      this.entries.set(record.id, { ...current, attemptBoot: error instanceof ConversationUnavailable ? boot : current.attemptBoot, restoreState: "failed", error: errorText(error) });
    }
    this.persist();
  }

  async list(): Promise<SavedConversation[]> {
    await this.observations;
    return [...this.entries.values()].map((record) => this.public(record)).sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
  }
  async read(id: string, page: ConversationPage = {}): Promise<RecognizedConversation> {
    await this.observations;
    const record = this.validate(this.get(id));
    return transcriptPage(record.source, record.path, page, this.codexHome);
  }
  async image(id: string, ref: string): Promise<ReturnType<typeof transcriptImage>> {
    await this.observations;
    const record = this.validate(this.get(id));
    switch (record.source) {
      case "claude-transcript": return transcriptImage(record.path, ref);
      case "pi-transcript": return piTranscriptImage(record.path, ref);
      case "codex-transcript": return codexTranscriptImage(codexHistorySegments(record.path, this.codexHome), ref, record.cwd);
      case "omo-transcript": case "omp-transcript": case "gjc-transcript": return null;
      default: { const unreachable: never = record.source; return unreachable; }
    }
  }
  async toolOutput(id: string, ref: string): Promise<string | null> {
    await this.observations;
    const record = this.validate(this.get(id));
    return transcriptToolOutput(record.source, record.path, ref, this.codexHome);
  }
  async restoreTargets(): Promise<SavedConversation[]> {
    return (await this.list()).filter((record) => this.get(record.id).desiredOpen);
  }
  /** A confirmed close in the same daemon boot cancels intent before the next poll. */
  closePane(paneId: string): Promise<void> {
    return this.serialize(async () => {
      const boot = this.runtime.bootIdentity();
      for (const record of this.entries.values()) {
        if (record.binding?.pane_id !== paneId || boot === null || record.observedBoot !== boot) continue;
        this.entries.set(record.id, { ...record, desiredOpen: false, restoreState: null });
        this.live.delete(record.id);
        this.launched.delete(record.id);
      }
      this.persist();
    });
  }
  async setDesiredOpen(id: string, desiredOpen: boolean): Promise<void> {
    return this.serialize(async () => {
      this.entries.set(id, { ...this.get(id), desiredOpen });
      this.persist();
    });
  }
  resume(id: string): Promise<ResumeConversationResponse> {
    const pending = this.resuming.get(id);
    if (pending) return pending;
    const operation = this.serialize(() => this.resumeOnce(id)).finally(() => this.resuming.delete(id));
    this.resuming.set(id, operation);
    return operation;
  }
  private async resumeOnce(id: string): Promise<Binding> {
    this.active();
    this.get(id);
    let owned: OwnedBinding | undefined;
    try {
      const snapshot = await this.runtime.snapshot();
      await this.observeSnapshot(snapshot, false);
      const record = this.validate(this.get(id));
      const running = this.live.get(id);
      if (running) return { pane_id: running.pane_id, workspace_id: running.workspace_id };
      const launched = this.launched.get(id);
      if (launched && snapshot.panes.some((pane) => pane.pane_id === launched.pane_id)) throw new ConversationHistoryError("conversation_unavailable", "resumed pane has not confirmed its session");
      if (record.source !== "omo-transcript") throw new ConversationHistoryError("resume_unsupported", "this agent has no exact resume adapter");
      if (!statSync(record.cwd).isDirectory()) throw new ConversationUnavailable("conversation_cwd_unavailable");
      owned = await this.runtime.create(record.cwd, record.title);
      this.active();
      // File or cwd may have changed while Herdr created the workspace.
      this.validate(record);
      if (!statSync(record.cwd).isDirectory()) throw new ConversationUnavailable("conversation_cwd_unavailable");
      // Persist the owned pane before launch: a bridge restart must not start a second copy
      // while the first process is still publishing its exact native-session identity.
      this.entries.set(id, { ...this.get(id), binding: owned, observedBoot: this.runtime.bootIdentity(), desiredOpen: true,
        restoreState: "started", error: "resumed pane has not confirmed its session" });
      this.persist();
      await this.runtime.start(owned.pane_id, ["--session", record.path]);
      this.live.set(id, owned);
      this.launched.set(id, owned);
      this.entries.set(id, { ...this.get(id), binding: owned, observedBoot: this.runtime.bootIdentity(), desiredOpen: true, restoreState: "started", error: null });
      this.persist();
      return { pane_id: owned.pane_id, workspace_id: owned.workspace_id };
    } catch (error) {
      let message = errorText(error);
      if (owned) {
        this.live.delete(id);
        this.launched.delete(id);
        try { await this.runtime.close(owned.workspace_id); } catch (cleanup) { message += `; workspace cleanup: ${errorText(cleanup)}`; }
      }
      this.entries.set(id, { ...this.get(id), error: message });
      this.persist();
      if (error instanceof ConversationHistoryError) throw error;
      throw new ConversationHistoryError("resume_failed", message);
    }
  }
}
