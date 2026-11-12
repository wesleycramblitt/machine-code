/**
 * machine_code — turn ingestion.
 *
 * Parses one completed assistant/tool step into facts and holdings. Kept
 * separate from the state ledger so parsing rules and memory rules can be
 * read and tested independently.
 */
import type { Artifact } from "./artifacts.js";
import type { HoldingStore } from "./holding-store.js";
import type { Ref } from "./state.js";
import { editRange, excerpt, inline, lineCount, str, textOf, toolCalls } from "./text.js";

export interface IngestHost {
  repoRoot?: string;
  putArtifact(text: string): Artifact;
  holdings: HoldingStore;
  addReadFact(ref: Ref, turn: number, excerptText?: string): void;
  addSearchFact(query: string, refs: Ref[], turn: number, hits?: string): void;
  addCommandFact(name: string, ok: boolean, turn: number, excerptText?: string): void;
  addChangeFact(
    path: string,
    ref: Ref,
    turn: number,
    summary: string,
    change?: { agent?: string; model?: string; tool?: string; detail?: string },
  ): void;
  setPhase(phase: "orient" | "target" | "act" | "verify" | "done"): void;
  appendTurn(turn: number): void;
  activeFacts(): number;
  event(type: string, data?: Record<string, unknown>): void;
  save(): void;
}

export function ingestTurn(
  host: IngestHost,
  input: readonly unknown[],
  turn: number,
  actor?: { agent?: string; model?: string },
): { changed: boolean } {
    const messages = input as readonly Record<string, unknown>[];
    let assistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        assistantIndex = i;
        break;
      }
    }
    if (assistantIndex < 0) return { changed: false };
    const assistant = messages[assistantIndex]!;
    // Keep assistant prose for change intent, but do not store it as a state
    // finding. Models write orientation chatter ("I'll start by...") that
    // crowds out the tool evidence in the state block.
    const assistantText = textOf(assistant).replace(/\s+/g, " ").trim();

    const calls = toolCalls(assistant);
    let changed = false;
    let commandRan = false;
    let commandName = "";
    let verified = false;
    let artifacts = 0;

    for (const message of messages.slice(assistantIndex + 1)) {
      if (message.role !== "toolResult") continue;
      const toolName = str(message.toolName) ?? "tool";
      const call = calls.get(str(message.toolCallId) ?? "");
      const args = call?.args ?? {};
      if (toolName === "context") continue;
      // Harness guard errors are not research evidence. Ingesting them would
      // turn warning text into working-set paths and artifacts.
      if (message.isError === true && toolName !== "command") continue;
      const resultText = textOf(message);
      const artifact = host.putArtifact(resultText);
      artifacts += 1;
      const path = str(args.path);
      const hash = artifact.hash.slice(0, 16);

      if (toolName === "search" || toolName === "map") {
        const action = str(args.action) ?? "overview";
        const mode =
          toolName === "map"
            ? action === "overview"
              ? "map"
              : action === "outline" || action === "sections"
                ? "outline"
                : action
            : str(args.mode) ?? "text";
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((item): item is string => typeof item === "string").join(",")
          : "";
        const query = str(args.pattern) ?? str(args.path) ?? paths;
        const found: Ref[] = [];
        if (mode === "files") {
          for (const line of resultText.split("\n")) {
            const path = line.trim();
            if (!path || path.startsWith("no ") || path.startsWith("[")) continue;
            found.push({ path });
            if (found.length >= 10) break;
          }
        } else if (mode === "outline") {
          const match = /^(.+?) \(\d+ lines\)/.exec(resultText.trimStart());
          if (match) found.push({ path: match[1]!.trim() });
        } else if (mode === "map") {
          let root = "";
          for (const line of resultText.split("\n")) {
            const dir = /^(\S+\/) \(\d+ files\)/.exec(line.trim());
            if (dir) {
              root = dir[1]!;
              found.push({ path: root });
            } else {
              const file = /^\s+(\S+) \(\d+\)/.exec(line);
              if (file && root) found.push({ path: `${root}${file[1]}` });
            }
            if (found.length >= 10) break;
          }
        } else {
          for (const line of resultText.split("\n")) {
            const match = /^([^:\n]+):(\d+)(?::\d+)?/.exec(line.trim());
            if (!match) continue;
            found.push({ path: match[1]!, range: [Number(match[2]), Number(match[2])] });
            if (found.length >= 10) break;
          }
        }
        const hits = found
          .slice(0, 3)
          .map((ref) => `${ref.path}${ref.range ? `:${ref.range[0]}` : ""}`)
          .join(", ");
        host.addSearchFact(mode === "text" ? query : `${mode} ${query}`.trim(), found, turn, hits);
      } else if (toolName === "inspect") {
        const query = str(args.query) ?? str(args.name) ?? str(args.path) ?? "";
        const mode = /mode="(file|symbol|directory|find)"/.exec(resultText)?.[1] ?? "find";
        const artifactId = /\[artifact: ([^\]]+)\]/.exec(resultText)?.[1] ?? artifact.id;
        const found: Ref[] = [];
        let current: string | null = null;
        for (const line of resultText.split("\n")) {
          const header = /^### (.+?): (\d+)-(\d+) of \d+ lines/.exec(line.trim());
          if (header) {
            current = header[1]!;
            const ref = { path: current, range: [Number(header[2]), Number(header[3])] as [number, number] };
            found.push(ref);
            host.holdings.addHolding(current, ref.range, artifactId, false, turn);
            if (mode === "symbol" && query && !query.includes("/") && !query.includes(" ")) {
              host.holdings.addSymbol(current, query, ref.range, turn);
            }
            continue;
          }
          const section = /^## (.+?) — .*\[match: /.exec(line.trim());
          if (section) {
            current = section[1]!;
            found.push({ path: current });
            continue;
          }
          const evidence = /^  "[^"]+" → \S+ (\S+) \((\d+)-(\d+)\)/.exec(line);
          if (evidence && current) {
            const range: [number, number] = [Number(evidence[2]), Number(evidence[3])];
            host.holdings.addHolding(current, range, artifactId, false, turn);
            host.holdings.addSymbol(current, evidence[1]!, range, turn);
            continue;
          }
          const relations = /^  (imports: .+|imported by: .+)(\s+·\s+(imports: .+|imported by: .+))?$/.exec(line);
          if (relations && current) {
            const parts = line.trim().split(/\s+·\s+/);
            const imports: string[] = [];
            const importedBy: string[] = [];
            for (const part of parts) {
              if (part.startsWith("imports:")) imports.push(...part.slice("imports:".length).split(","));
              else if (part.startsWith("imported by:")) importedBy.push(...part.slice("imported by:".length).split(","));
            }
            host.holdings.addConnections(current, imports, importedBy);
          }
        }
        if ((mode === "file" || mode === "symbol") && found.length === 0 && str(args.path)) {
          const ref = { path: str(args.path)! };
          found.push(ref);
          host.holdings.addHolding(ref.path, undefined, artifactId, false, turn);
        }
        if (mode === "file" || mode === "symbol") {
          const ref = found[0];
          if (ref) host.addReadFact({ ...ref, hash, artifact: artifact.id, bytes: artifact.bytes }, turn, excerpt(resultText));
        } else if (found.length > 0) {
          const hits = found.slice(0, 3).map((ref) => `${ref.path}${ref.range ? `:${ref.range[0]}` : ""}`).join(", ");
          host.addSearchFact(query || mode, found.slice(0, 10), turn, hits);
        }
      } else if (toolName === "command") {
        // describe/list are reads. Only run executes a gate or mutates the
        // tree; treating introspection as verification put runs into a test
        // loop before they made a single edit.
        if ((str(args.action) ?? "run") !== "run") continue;
        commandRan = true;
        commandName = str(args.name) ?? "command";
        host.addCommandFact(commandName, message.isError !== true, turn, excerpt(resultText));
        verified = true;
      } else if ((toolName === "edit" || toolName === "write") && path) {
        if (message.isError === true) continue;
        const oldText = str(args.oldString) ?? "";
        const newText = str(args.newString) ?? "";
        const content = str(args.content) ?? "";
        const range = toolName === "edit" ? editRange(host.repoRoot, path, newText) : undefined;
        const ref: Ref = { path, ...(range ? { range } : {}) };
        const delta =
          toolName === "edit"
            ? `edit ${lineCount(oldText)}->${lineCount(newText)} lines (${oldText.length}->${newText.length} chars)`
            : `write ${Buffer.byteLength(content, "utf8")} bytes`;
        const intent = assistantText ? ` · intent: ${inline(assistantText)}` : "";
        host.addChangeFact(path, ref, turn, resultText, {
          ...actor,
          tool: toolName,
          detail: `${resultText} · ${delta}${intent}`,
        });
        changed = true;
      }
    }

    // Workspace changes are rendered by the workspace block from git diff
    // at prompt time. No parallel git change fact tracking needed.

    if (changed) host.setPhase("act");
    else if (verified) host.setPhase("verify");
    host.appendTurn(turn);
    host.event("context_ingested", {
      turn,
      facts: host.activeFacts(),
      holdings: host.holdings.map.size,
      artifacts,
    });
    host.save();
    return { changed };
  }
