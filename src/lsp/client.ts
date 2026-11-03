/**
 * machine_code — thin LSP client over vscode-jsonrpc.
 *
 * Spawns a language server with --stdio, runs the initialize handshake,
 * and exposes diagnostics, rename, and semantic-navigation requests. Every
 * public method returns null when the server is unavailable or over budget,
 * so callers can fall back to ast-grep/rg without special-casing.
 */
import { spawn } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { pathToFileURL } from "node:url";
import type {
  Diagnostic,
  DocumentSymbol,
  Location,
  LocationLink,
  Position,
  SymbolInformation,
  Hover,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";

export interface LspClientOptions {
  binary: string;
  args: string[];
  root: string;
  /** Default LSP languageId when the path has no better mapping. */
  languageId?: string;
  /** Map a file path to its LSP languageId (TSX vs TS, SCSS vs CSS, ...). */
  languageIdForPath?: (path: string) => string;
  /** Passed to initialize.initializationOptions. */
  initializationOptions?: Record<string, unknown>;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Optional run supervisor for lifecycle visibility. */
  processes?: import("../processes/supervisor.js").ProcessSupervisor;
}

export class LspClient {
  private process: ReturnType<typeof spawn> | null = null;
  private connection: ReturnType<typeof createMessageConnection> | null = null;
  private initialized = false;
  private starting: Promise<boolean> | null = null;
  private diagnostics = new Map<string, Diagnostic[]>();
  private opened = new Map<string, number>();
  private readonly timeoutMs: number;

  constructor(private readonly options: LspClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get available(): boolean {
    return this.initialized && this.connection !== null;
  }

  async ensureStarted(): Promise<boolean> {
    if (this.initialized && this.connection) return true;
    if (this.starting) return this.starting;
    this.starting = this.start();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }

  private async start(): Promise<boolean> {
    try {
      const child = spawn(this.options.binary, this.options.args, {
        cwd: this.options.root,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        // Language servers need the user's toolchain env (JAVA_HOME, GOPATH,
        // CARGO_HOME, ...), not just PATH/HOME.
        env: process.env,
      });
      this.process = child;
      this.options.processes?.attach(child, {
        origin: "lsp",
        name: `lsp:${this.options.binary}`,
      });
      const reader = new StreamMessageReader(child.stdout);
      const writer = new StreamMessageWriter(child.stdin);
      const conn = createMessageConnection(reader, writer);
      this.connection = conn;

      conn.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
        this.diagnostics.set(params.uri, params.diagnostics);
      });

      conn.listen();

      const initResult = await withTimeout(
        conn.sendRequest("initialize", {
          processId: process.pid,
          clientInfo: { name: "machine_code", version: "0.0.0" },
          rootUri: pathToFileURL(this.options.root).href,
          capabilities: {
            textDocument: {
              publishDiagnostics: {},
              definition: { linkSupport: true },
              references: {},
              hover: { contentFormat: ["markdown", "plaintext"] },
              rename: { prepareSupport: true },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            },
            workspace: { symbol: {} },
          },
          ...(this.options.initializationOptions
            ? { initializationOptions: this.options.initializationOptions }
            : {}),
          workspaceFolders: [{ uri: pathToFileURL(this.options.root).href, name: "root" }],
        }),
        this.timeoutMs,
      );
      if (!initResult) {
        this.dispose();
        return false;
      }
      conn.sendNotification("initialized", {});
      this.initialized = true;
      return true;
    } catch {
      this.dispose();
      return false;
    }
  }

  private dispose(): void {
    try {
      this.connection?.dispose();
    } catch {
      // ignore
    }
    this.connection = null;
    this.initialized = false;
    this.opened.clear();
    try {
      if (this.process && !this.process.killed) this.process.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.process = null;
  }

  /** Synchronous best-effort kill for process-exit cleanup. */
  kill(): void {
    this.dispose();
  }

  async shutdown(): Promise<void> {
    if (this.connection) {
      try {
        await withTimeout(this.connection.sendRequest("shutdown"), 5_000);
      } catch {
        // ignore
      }
      try {
        this.connection.sendNotification("exit");
      } catch {
        // ignore
      }
    }
    this.dispose();
  }

  // ---- text document sync ----

  async openDocument(filePath: string, content: string, languageId?: string): Promise<string> {
    const uri = pathToFileURL(filePath).href;
    if (!this.connection) return uri;
    const resolved =
      languageId ??
      this.options.languageIdForPath?.(filePath) ??
      this.options.languageId ??
      "plaintext";
    try {
      const version = (this.opened.get(uri) ?? 0) + 1;
      if (this.opened.has(uri)) {
        this.connection.sendNotification("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text: content }],
        });
      } else {
        this.connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: resolved,
            version,
            text: content,
          },
        });
      }
      this.opened.set(uri, version);
    } catch {
      // ignore
    }
    return uri;
  }

  // ---- diagnostics ----

  async diagnosticsFor(filePath: string, content: string): Promise<Diagnostic[] | null> {
    if (!(await this.ensureStarted())) return null;
    const uri = await this.openDocument(filePath, content);
    // wait briefly for publishDiagnostics
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const d = this.diagnostics.get(uri);
      if (d !== undefined) return d;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.diagnostics.get(uri) ?? [];
  }

  // ---- rename ----

  async rename(filePath: string, position: Position, newName: string): Promise<WorkspaceEdit | null> {
    if (!(await this.ensureStarted())) return null;
    const { readFileSync } = await import("node:fs");
    let content = "";
    try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    await this.openDocument(filePath, content);
    const uri = pathToFileURL(filePath).href;
    try {
      const result = (await withTimeout(
        this.connection!.sendRequest("textDocument/rename", {
          textDocument: { uri },
          position,
          newName,
        }),
        this.timeoutMs,
      )) as WorkspaceEdit | null;
      return result ?? null;
    } catch {
      return null;
    }
  }

  // ---- navigation ----

  async definition(filePath: string, position: Position): Promise<Location[] | null> {
    if (!(await this.ensureStarted())) return null;
    const { readFileSync } = await import("node:fs");
    let content = "";
    try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    await this.openDocument(filePath, content);
    const uri = pathToFileURL(filePath).href;
    try {
      const result = (await withTimeout(
        this.connection!.sendRequest("textDocument/definition", {
          textDocument: { uri },
          position,
        }),
        this.timeoutMs,
      )) as Location | LocationLink | Array<Location | LocationLink> | null;
      if (result === null) return [];
      const items = Array.isArray(result) ? result : [result];
      // Servers may return LocationLink (targetUri/targetRange) instead of
      // Location. Normalize so callers only see Location.
      return items.map((item) =>
        "targetUri" in item
          ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }
          : item,
      );
    } catch {
      return null;
    }
  }

  async references(filePath: string, position: Position): Promise<Location[] | null> {
    if (!(await this.ensureStarted())) return null;
    const { readFileSync } = await import("node:fs");
    let content = "";
    try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    await this.openDocument(filePath, content);
    const uri = pathToFileURL(filePath).href;
    try {
      const result = (await withTimeout(
        this.connection!.sendRequest("textDocument/references", {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        }),
        this.timeoutMs,
      )) as Location[] | null;
      return result ?? [];
    } catch {
      return null;
    }
  }

  async hover(filePath: string, position: Position): Promise<Hover | null> {
    if (!(await this.ensureStarted())) return null;
    const { readFileSync } = await import("node:fs");
    let content = "";
    try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    await this.openDocument(filePath, content);
    const uri = pathToFileURL(filePath).href;
    try {
      const result = (await withTimeout(
        this.connection!.sendRequest("textDocument/hover", {
          textDocument: { uri },
          position,
        }),
        this.timeoutMs,
      )) as Hover | null;
      return result ?? null;
    } catch {
      return null;
    }
  }

  /** Hierarchical symbols for one open document. More reliable than workspace/symbol. */
  async documentSymbols(filePath: string): Promise<Array<DocumentSymbol | SymbolInformation> | null> {
    if (!(await this.ensureStarted())) return null;
    const { readFileSync } = await import("node:fs");
    let content = "";
    try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    const uri = await this.openDocument(filePath, content);
    try {
      const result = (await withTimeout(
        this.connection!.sendRequest("textDocument/documentSymbol", {
          textDocument: { uri },
        }),
        this.timeoutMs,
      )) as Array<DocumentSymbol | SymbolInformation> | null;
      return result ?? [];
    } catch {
      return null;
    }
  }

  async workspaceSymbols(query: string): Promise<SymbolInformation[] | null> {
    if (!(await this.ensureStarted())) return null;
    try {
      const result = (await withTimeout(
        this.connection!.sendRequest("workspace/symbol", { query }),
        this.timeoutMs,
      )) as SymbolInformation[] | null;
      return result ?? [];
    } catch {
      return null;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}
