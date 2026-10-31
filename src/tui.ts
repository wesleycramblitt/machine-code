/**
 * machine_code — TUI
 *
 * Rendering contract: every frame is exactly `rows` lines. Header is always
 * the first 2 lines and footer the last 2; content is clipped/scrolled to
 * `rows - 4` lines. Because the frame never exceeds the terminal height, the
 * screen never scrolls and the tabs can never be pushed off the top.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "./paths.js";
import { listAllRuns, readRun, listProjects, type RunSummary, type RunEvent } from "./state/runs.js";
import { listInstances } from "./state/instances.js";
import { loadMachineConfig, loadPolicy, type Policy } from "./config.js";
import { readSpendSummary } from "./spend.js";
import { loadAvailability } from "./availability.js";
import { agentDef, type AgentDef, type AgentName } from "./agents.js";
import { loadCatalogue } from "./catalogue/load.js";
import type { CatalogueRow } from "./catalogue/types.js";

const ALT = "\x1b[?1049h";
const ALT_L = "\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_BELOW = "\x1b[J";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
// Synchronized output: terminals that support it paint the frame atomically,
// which removes the flicker of full-screen repaints. Others ignore it.
const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

const B = "\x1b[1m";
const D = "\x1b[2m";
const R = "\x1b[0m";
const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const RED = "\x1b[31m";
const M = "\x1b[35m";
const BL = "\x1b[34m";
const GR = "\x1b[90m";
const W = "\x1b[37m";

const TAB_ON = "\x1b[46m\x1b[30m\x1b[1m";
const TAB_OFF = "\x1b[40m\x1b[37m";

type Tab = "runs" | "agents" | "models" | "providers" | "spend" | "settings";
type View = "list" | "detail" | "newrun";
type GroupMode = "directory" | "status";
type ModelGroup = "provider" | "family";

const TABS: Tab[] = ["runs", "agents", "models", "providers", "spend", "settings"];
const AGENT_NAMES: AgentName[] = ["general", "architect", "build", "review", "sudo"];

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Collapse anything that would emit an extra physical line (or break the
 * cursor) into harmless characters. ESC is preserved so ANSI colours survive.
 */
function sanitizeLine(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

function trunc(s: string, n: number): string {
  if (n <= 0) return "";
  if (stripAnsi(s).length <= n) return s;
  let out = "";
  let v = 0;
  let i = 0;
  while (i < s.length && v < n - 1) {
    if (s[i] === "\x1b") {
      let j = i;
      while (j < s.length && s[j] !== "m") j++;
      if (j < s.length) j++;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += s[i];
    v++;
    i++;
  }
  return out + "…" + R;
}

function fit(s: string, n: number): string {
  const v = stripAnsi(s).length;
  if (v > n) return trunc(s, n);
  if (v < n) return s + " ".repeat(n - v);
  return s;
}

/** Word-wrap plain text to `width` visible columns; collapses blank-line runs. */
function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  let prevBlank = false;
  for (const raw of s.split("\n")) {
    const line = raw.replace(/\t/g, "  ").trimEnd();
    if (line.trim() === "") {
      if (!prevBlank) out.push("");
      prevBlank = true;
      continue;
    }
    prevBlank = false;
    if (line.length <= width) { out.push(line); continue; }
    let i = 0;
    while (i < line.length) {
      out.push(line.slice(i, i + width));
      i += width;
    }
  }
  return out;
}

function icon(s: string): string {
  if (s === "running") return `${C}●${R}`;
  if (s === "done") return `${G}✓${R}`;
  if (s === "blocked") return `${Y}◐${R}`;
  if (s === "failed") return `${RED}✗${R}`;
  if (s === "interrupted") return `${GR}◯${R}`;
  return `${GR}○${R}`;
}

function statusColor(s: string): string {
  if (s === "running") return C;
  if (s === "done") return G;
  if (s === "blocked") return Y;
  if (s === "failed") return RED;
  if (s === "interrupted") return GR;
  return GR;
}

function ago(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(d / 1000);
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

function findRun(home: string, id: string): { summary: RunSummary; events: RunEvent[] } | null {
  for (const p of listProjects(home)) {
    const r = readRun(layout(p), id);
    if (r) return r;
  }
  return null;
}

function buildFlat(
  runs: RunSummary[],
  cwd: string,
  groupMode: GroupMode,
): { flat: RunSummary[]; groups: Map<string, RunSummary[]>; pkeys: string[] } {
  const groups = new Map<string, RunSummary[]>();
  let pkeys: string[];
  if (groupMode === "directory") {
    for (const r of runs) {
      const k = r.repoRoot || "unknown";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    pkeys = [...groups.keys()].sort((a, b) => {
      if (a === cwd) return -1;
      if (b === cwd) return 1;
      return basename(a).localeCompare(basename(b));
    });
  } else {
    const order = ["running", "blocked", "failed", "interrupted", "done"];
    for (const r of runs) {
      if (!groups.has(r.status)) groups.set(r.status, []);
      groups.get(r.status)!.push(r);
    }
    pkeys = order.filter((k) => groups.has(k));
  }
  const flat: RunSummary[] = [];
  for (const pk of pkeys) {
    const arr = groups.get(pk);
    if (arr) for (const r of arr) flat.push(r);
  }
  return { flat, groups, pkeys };
}

/** Agent metadata for the agents tab and the new-run screen. */
const AGENT_META: Record<AgentName, { modes: string[]; blurb: string }> = {
  general: { modes: ["solo"], blurb: "answers questions; read tool only" },
  architect: { modes: ["direct", "verified", "redundant"], blurb: "plans packets; runs Architect → Build → gates" },
  build: { modes: [], blurb: "implements packets; not run directly" },
  review: { modes: [], blurb: "read-only judge; redundant mode only" },
  sudo: { modes: ["solo"], blurb: "full permissions; solo only" },
};

function fmtPrice(p: number): string {
  if (p >= 10) return `$${p.toFixed(0)}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${p.toFixed(2)}`;
}

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export async function runTui(): Promise<void> {
  const l = layout();
  const cwd = process.cwd();
  mkdirSync(l.localDir, { recursive: true });

  let tab: Tab = "runs";
  let view: View = "list";
  let sel = 0; // selection within the active tab's list
  let listTop = 0; // scroll for list views
  let scroll = 0; // scroll for scroll-only views (detail/agents detail/etc.)
  let detSelEvent = 0;
  const expanded = new Set<string>();
  let newrunPrompt = "";
  let newrunAgent: "general" | "sudo" | "architect" = "architect";
  let newrunMode = "verified";
  let groupMode: GroupMode = "directory";
  let modelGroup: ModelGroup = "provider";
  let modelsAll = false; // false = configured providers only
  let modelFilter = ""; // simple substring filter
  const collapsed = new Set<string>();

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  process.stdout.write(ALT + HIDE);

  const cleanup = () => {
    stdin.setRawMode?.(false);
    process.stdout.write(SYNC_OFF + SHOW + ALT_L);
  };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const interruptRun = (r: RunSummary) => {
    if (r.status !== "running") return;
    const dir = join(r.repoRoot, ".machine_code", "local", "runs", r.id);
    const cf = join(dir, "control");
    let seq = 1;
    try {
      const a = readFileSync(join(dir, "control.ack"), "utf8");
      const m = a.match(/"seq":\s*(\d+)/);
      if (m) seq = Number(m[1]) + 1;
    } catch { /* no ack yet */ }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(cf, JSON.stringify({ seq, action: "interrupt", from: process.pid }) + "\n", "utf8");
    } catch { /* ignore */ }
  };

  const detailFor = (r: RunSummary) => {
    const rd = r.repoRoot ? readRun(layout(r.repoRoot), r.id) : null;
    return rd || findRun(l.home, r.id);
  };

  const launchRun = () => {
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const args = ["run", "--mode", newrunMode];
    if (newrunMode === "solo") args.push("--agent", newrunAgent);
    args.push(newrunPrompt);
    try {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
    } catch { /* ignore */ }
  };

  /** Generic grouped list builder: returns rows + flat selectable items. */
  type MRow = { kind: "group"; key: string; text: string } | { kind: "item"; idx: number; text: string };
  function windowRows(rows: MRow[], flatCount: number, selIdx: number, bodyH: number, top: number): { lines: string[]; top: number } {
    // Keep selection visible.
    let selRow = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.kind === "item" && r.idx === selIdx) { selRow = i; break; }
    }
    let t = top;
    if (selRow >= 0) {
      if (selRow < t) t = selRow;
      if (selRow >= t + bodyH) t = selRow - bodyH + 1;
    }
    t = Math.max(0, Math.min(t, Math.max(0, rows.length - bodyH)));
    const lines = rows.slice(t, t + bodyH).map((r) => r.text);
    while (lines.length < bodyH) lines.push("");
    return { lines, top: t };
  }

  const draw = () => {
    // Deliberately leave the final column unused. Writing exactly `columns`
    // cells leaves the terminal in "pending wrap" state, and the newline that
    // follows then scrolls the whole screen up by a line — which pushed the
    // tabs and the run summary off the top on every repaint.
    const cols = Math.max(1, (process.stdout.columns || 120) - 1);
    const rows = process.stdout.rows || 40;
    const runs = listAllRuns(l.home);
    if (sel < 0) sel = 0;

    // ---- Header (2 lines) -------------------------------------------------
    let tabBar = "";
    for (let i = 0; i < TABS.length; i++) {
      const t = TABS[i]!;
      if (tab === t) tabBar += `${TAB_ON} ${i + 1}:${t} ${R}`;
      else tabBar += `${TAB_OFF} ${i + 1}:${t} ${R}`;
      tabBar += " ";
    }
    const instCount = listInstances(l.home).length;
    tabBar += `${D}${instCount} inst${R}`;
    const header = [fit(tabBar, cols), `${D}${"━".repeat(cols)}${R}`];

    // ---- Footer (2 lines) -------------------------------------------------
    // Built after the body so it can carry view-specific progress (e.g. the
    // selected event index). Its height is constant, which is what bodyH
    // depends on.
    const bodyH = Math.max(1, rows - 4);
    let body: string[] = [];
    let detInfo = "";

    const avail = loadAvailability(l.home);
    const isConfigured = (provider: string): boolean => {
      const envKey =
        provider === "openrouter" ? "OPENROUTER_API_KEY" :
        provider === "opencode-go" ? "OPENCODE_API_KEY" :
        provider === "anthropic" ? "ANTHROPIC_API_KEY" :
        provider === "openai" ? "OPENAI_API_KEY" :
        provider === "google" ? "GOOGLE_API_KEY" :
        provider === "deepinfra" ? "DEEPINFRA_API_KEY" :
        provider === "sambanova" ? "SAMBANOVA_API_KEY" :
        provider === "groq" ? "GROQ_API_KEY" :
        provider === "cerebras" ? "CEREBRAS_API_KEY" : "";
      return Boolean(envKey && process.env[envKey]);
    };

    // ---- Runs -------------------------------------------------------------
    if (tab === "runs") {
      if (view === "newrun") {
        const agents: Array<"general" | "sudo" | "architect"> = ["general", "sudo", "architect"];
        const meta = AGENT_META[newrunAgent];
        const modes = meta.modes;
        if (!modes.includes(newrunMode)) newrunMode = modes[0]!;
        const promptLines = wrapText(newrunPrompt || "(type the task, then press Enter)", Math.max(20, cols - 8));
        const boxH = Math.max(1, bodyH - 10);
        body = [
          ` ${B}${W}New Run${R}`,
          "",
          ` ${B}Agent${R}   ${agents.map((a) => (a === newrunAgent ? `${TAB_ON} ${a} ${R}` : `${D}${a}${R}`)).join("  ")}`,
          ` ${B}Mode${R}    ${modes.length === 0 ? `${D}(none)${R}` : modes.map((m) => (m === newrunMode ? `${TAB_ON} ${m} ${R}` : `${D}${m}${R}`)).join("  ")}`,
          `           ${D}${meta.blurb}${R}`,
          "",
          ` ${B}Prompt${R}`,
          ` ${D}${"┌" + "─".repeat(Math.max(10, cols - 4)) + "┐"}${R}`,
        ];
        for (let i = 0; i < boxH; i++) {
          const ln = promptLines[i] ?? "";
          body.push(` ${D}│${R} ${fit(ln, Math.max(10, cols - 8))} ${D}│${R}`);
        }
        body.push(` ${D}${"└" + "─".repeat(Math.max(10, cols - 4)) + "┘"}${R}`);
      } else if (view === "list") {
        const { flat, groups, pkeys } = buildFlat(runs, cwd, groupMode);
        if (sel >= flat.length) sel = flat.length === 0 ? 0 : flat.length - 1;
        type Row = MRow;
        const rowList: Row[] = [];
        let fi = 0;
        for (const pk of pkeys) {
          const isCollapsed = collapsed.has(pk);
          if (groupMode === "directory") {
            const isCur = pk === cwd;
            const pn = basename(pk);
            rowList.push({
              kind: "group",
              key: pk,
              text: ` ${isCur ? C : GR}${isCollapsed ? "▸" : "▾"} ${B}${W}${pn}${R}${isCur ? ` ${C}(cwd)${R}` : ""} ${D}${pk} (${groups.get(pk)?.length || 0})${R}`,
            });
          } else {
            const sc = statusColor(pk);
            rowList.push({
              kind: "group",
              key: pk,
              text: ` ${sc}${isCollapsed ? "▸" : "▾"} ${B}${sc}${pk.toUpperCase()}${R} ${D}(${groups.get(pk)?.length || 0})${R}`,
            });
          }
          if (isCollapsed) continue;
          for (const r of groups.get(pk) || []) {
            const selr = fi === sel;
            const mrk = selr ? `${C}▸${R}` : " ";
            const reqClean = (r.request || "").replace(/\s+/g, " ").trim();
            const stats = `${G}${r.modelCalls}${R}c ${C}${r.usage.totalTokens}${R}tok ${Y}$${r.cost.actual.toFixed(4)}${R}`;
            const availW = Math.max(16, cols - 60);
            const line = `  ${mrk} ${icon(r.status)} ${BL}${r.id.slice(-8)}${R} ${D}${ago(r.startedAt)}${R}  ${M}${r.agent}${R}/${r.mode}  ${W}${trunc(reqClean, availW)}${R}  ${D}│${R} ${stats}`;
            rowList.push({ kind: "item", idx: fi, text: selr ? `\x1b[48;5;236m${line}${R}` : line });
            fi++;
          }
        }
        const w = windowRows(rowList, flat.length, sel, bodyH, listTop);
        listTop = w.top;
        body = w.lines;
      } else if (view === "detail") {
        const r = buildFlat(runs, cwd, groupMode).flat[sel];
        if (!r) { view = "list"; return draw(); }
        const rd = detailFor(r);
        if (rd) {
          const s = rd.summary;
          const ev = rd.events;
          if (detSelEvent >= ev.length) detSelEvent = Math.max(0, ev.length - 1);
          const pre: string[] = [];
          pre.push(` ${icon(s.status)} ${B}${BL}${s.id}${R}  ${D}${s.repoRoot || r.repoRoot || "?"}${R}`);
          pre.push(` ${statusColor(s.status)}${B}${s.status.toUpperCase()}${R}  ${M}${s.agent}${R}/${s.mode}  ${G}${s.modelCalls}${R} calls  ${C}${s.usage.totalTokens.toLocaleString()}${R} tok  ${Y}$${s.cost.actual.toFixed(6)}${R}  ${D}pid ${s.pid}${R}`);
          if (s.error) pre.push(` ${RED}ERROR: ${s.error}${R}`);
          pre.push(` ${D}request:${R} ${W}${(s.request || "").replace(/\s+/g, " ").trim()}${R}`);
          if (s.finalText) pre.push(` ${D}final:${R} ${W}${trunc(s.finalText.replace(/\s+/g, " ").trim(), Math.max(20, cols - 14))}${R}`);
          pre.push(` ${D}${"─".repeat(10)} events ${"─".repeat(Math.max(0, cols - 20))}${R}`);
          const evFlat: string[] = [];
          const evStart: number[] = [];
          for (let ei = 0; ei < ev.length; ei++) {
            evStart[ei] = evFlat.length;
            const e = ev[ei]!;
            const t = String(e.t).slice(11, 19);
            const et = String(e.type);
            const isSel = ei === detSelEvent;
            const p = isSel ? `${C}▸${R}` : " ";
            const exp = expanded.has(`${s.id}:${ei}`);
            switch (et) {
              case "run_start":
                evFlat.push(`${p} ${GR}${t}${R} ${C}▶${R} ${B}start${R} ${M}${e.agent}${R}/${e.mode}`);
                break;
              case "model_select":
                if (e.error) evFlat.push(`${p} ${GR}${t}${R} ${RED}▸ select error${R} ${String(e.error)}`);
                else {
                  evFlat.push(`${p} ${GR}${t}${R} ${BL}▸${R} ${D}select${R} ${C}${e.key}${R}`);
                  if (exp) {
                    const cands = Array.isArray(e.candidates) ? e.candidates : [];
                    for (const c of cands.slice(0, 3)) {
                      const chosen = c.key === e.key ? `${C}${B}✓${R} ` : "  ";
                      const sc2 = c.score != null ? Number(c.score).toFixed(4) : "?";
                      const terms = c.terms ? ` cap ${Number(c.terms.capability ?? 0).toFixed(2)} cost ${Number(c.terms.cost ?? 0).toFixed(3)} speed ${Number(c.terms.speed ?? 0).toFixed(2)}` : "";
                      evFlat.push(`    ${chosen}${D}score ${R}${sc2}${D}${terms}${R}  ${W}${c.key}${R}`);
                    }
                    const est: any = e.estimate || {};
                    if (est.inputTokens != null || est.outputTokens != null) {
                      evFlat.push(`    ${D}estimate:${R} in≈${est.inputTokens ?? "?"} out=${est.outputTokens ?? "?"}`);
                    }
                  }
                }
                break;
              case "model_call_end": {
                const u: any = e.usage || {};
                evFlat.push(
                  `${p} ${GR}${t}${R} ${M}◉${R} ${W}${e.provider}${R}/${e.model} ${statusColor(String(e.stopReason))}${e.stopReason}${R} ${G}${u.totalTokens || 0}${R}tok${e.cost != null ? ` ${Y}$${Number(e.cost).toFixed(6)}${R}` : ""}`,
                );
                if (e.error) evFlat.push(`    ${RED}${String(e.error)}${R}`);
                if (exp) {
                  evFlat.push(`    ${D}input ${R}${(u.input ?? 0).toLocaleString()}  ${D}output ${R}${(u.output ?? 0).toLocaleString()}  ${D}cache_r ${R}${u.cacheRead ?? 0}  ${D}cache_w ${R}${u.cacheWrite ?? 0}`);
                  const txt = typeof e.text === "string" ? e.text : "";
                  if (txt) {
                    evFlat.push(`    ${D}response:${R}`);
                    for (const ln of wrapText(txt, Math.max(40, cols - 6))) evFlat.push(`    ${W}${ln}${R}`);
                  }
                }
                break;
              }
              case "tool_call_start":
                evFlat.push(`${p} ${GR}${t}${R} ${Y}⚡${R} ${B}${e.tool}${R} ${D}calling…${R}`);
                if (exp && e.args) for (const ln of wrapText(JSON.stringify(e.args), Math.max(40, cols - 6))) evFlat.push(`    ${D}args ${R}${ln}`);
                break;
              case "tool_call":
                evFlat.push(`${p} ${GR}${t}${R} ${Y}⚡${R} ${B}${e.tool}${R} ${e.isError ? `${RED}ERR${R}` : `${G}ok${R}`}${typeof e.durationMs === "number" ? ` ${D}${e.durationMs}ms${R}` : ""}`);
                if (exp) {
                  const args = e.args ?? (e as any).call?.args;
                  if (args) for (const ln of wrapText(JSON.stringify(args), Math.max(40, cols - 6))) evFlat.push(`    ${D}args ${R}${ln}`);
                  const res = e.result;
                  if (res !== undefined) {
                    const rs = typeof res === "string" ? res : JSON.stringify(res);
                    const clean = stripAnsi(rs).replace(/\n+/g, " ").trim();
                    for (const ln of wrapText(clean, Math.max(40, cols - 6))) evFlat.push(`    ${G}→${R} ${ln}`);
                  }
                }
                break;
              case "gates":
                evFlat.push(`${p} ${GR}${t}${R} ${B}⊞ gates${R} ${e.passed ? `${G}PASS${R}` : `${RED}FAIL${R}`}`);
                if (exp && Array.isArray(e.results)) {
                  for (const g of e.results as any[]) {
                    evFlat.push(`    ${g.passed ? G + "✓" : RED + "✗"}${R} ${g.command}`);
                  }
                }
                break;
              case "error_classified":
                evFlat.push(`${p} ${GR}${t}${R} ${RED}⚠ ${e.kind}${R}${e.disableProvider ? ` ${RED}[disable provider]${R}` : ""}${e.needsAuth ? ` ${Y}[needs auth]${R}` : ""}`);
                break;
              case "retry":
                evFlat.push(`${p} ${GR}${t}${R} ${Y}↻ retry${R} ${D}from ${e.failedModel}${R}`);
                break;
              case "control":
                evFlat.push(`${p} ${GR}${t}${R} ${Y}⌘ ${e.action}${R}`);
                break;
              case "run_end": {
                const sc = s.status === "done" ? G : s.status === "interrupted" ? GR : RED;
                evFlat.push(`${p} ${GR}${t}${R} ${sc}■ ${String(e.status).toUpperCase()}${R}${e.error ? ` ${RED}${String(e.error)}${R}` : ""}`);
                if (exp) {
                  evFlat.push(`    ${D}tokens ${R}${s.usage.totalTokens.toLocaleString()}  ${D}cost ${R}$${s.cost.actual.toFixed(6)}  ${D}calls ${R}${s.modelCalls}`);
                  if (s.finalText) {
                    evFlat.push(`    ${D}final output:${R}`);
                    for (const ln of wrapText(s.finalText, Math.max(40, cols - 6))) evFlat.push(`    ${W}${ln}${R}`);
                  }
                }
                break;
              }
              default:
                evFlat.push(`${p} ${GR}${t}${R} ${D}${et}${R}`);
            }
          }
          // The summary block is pinned: only the event stream scrolls. Keep at
          // least two summary lines and at least one event row visible.
          const shownPre = pre.slice(0, Math.max(2, Math.min(pre.length, bodyH - 2)));
          const viewport = Math.max(1, bodyH - shownPre.length);
          const maxScroll = Math.max(0, evFlat.length - viewport);
          const selStart = evStart[detSelEvent] ?? 0;
          if (selStart < scroll) scroll = selStart;
          if (selStart >= scroll + viewport) scroll = selStart - viewport + 1;
          const sc3 = Math.max(0, Math.min(scroll, maxScroll));
          scroll = sc3;
          const lastEv = Math.min(evFlat.length, sc3 + viewport);
          detInfo =
            ev.length === 0
              ? "no events"
              : `event ${detSelEvent + 1}/${ev.length}   rows ${sc3 + 1}-${lastEv}/${evFlat.length}`;
          body = [...shownPre, ...evFlat.slice(sc3, sc3 + viewport)];
        } else {
          body = [` ${RED}run not found${R}`];
        }
      }
    }

    // ---- Agents -----------------------------------------------------------
    else if (tab === "agents") {
      if (view === "detail") {
        const name = AGENT_NAMES[Math.min(sel, AGENT_NAMES.length - 1)]!;
        const def = agentDef(l, name);
        let policy: Policy | undefined;
        try { policy = loadPolicy(l); } catch { policy = undefined; }
        const ap = policy?.agents[name];
        const meta = AGENT_META[name];
        const tools = def.tools.join(", ");
        const lines: string[] = [
          ` ${B}${M}${name.toUpperCase()}${R} ${D}│ ${meta.blurb}${R}`,
          "",
          ` ${B}${C}Tools${R}   ${W}${tools}${R}`,
          ` ${B}${C}Access${R}  ${def.readonly ? `${G}read-only${R}` : `${Y}can mutate worktree${R}`}`,
          ` ${B}${C}Modes${R}   ${meta.modes.length ? meta.modes.join(", ") : `${D}(internal only)${R}`}`,
          "",
          ` ${B}${C}Policy${R} ${D}(.machine_code/policy.toml)${R}`,
        ];
        if (ap) {
          lines.push(`   min context ${C}${ap.minContext.toLocaleString()}${R}   expected out ${C}${ap.expectedOutputTokens}${R}   min capability ${C}${ap.minCapability}${R}   tool call ${C}${String(ap.toolCall)}${R}`);
          if (ap.maxOutputTokens != null) lines.push(`   max output ${C}${ap.maxOutputTokens}${R}`);
          if (ap.budgetTokens != null) lines.push(`   budget ${C}${ap.budgetTokens.toLocaleString()}${R} tokens`);
        } else {
          lines.push(`   ${D}(defaults)${R}`);
        }
        lines.push("", ` ${B}${C}Prompt${R} ${D}(${def.prompt.split("\n").length} lines)${R}`, ` ${D}${"─".repeat(Math.max(0, cols - 2))}${R}`);
        for (const ln of wrapText(def.prompt, Math.max(40, cols - 4))) lines.push(` ${W}${ln}${R}`);
        const maxScroll = Math.max(0, lines.length - bodyH);
        scroll = Math.max(0, Math.min(scroll, maxScroll));
        body = lines.slice(scroll, scroll + bodyH);
      } else {
        let policy: Policy | undefined;
        try { policy = loadPolicy(l); } catch { policy = undefined; }
        const rowList: MRow[] = [];
        for (let i = 0; i < AGENT_NAMES.length; i++) {
          const name = AGENT_NAMES[i]!;
          const def = agentDef(l, name);
          const meta = AGENT_META[name];
          const ap = policy?.agents[name];
          const selr = i === sel;
          const line = ` ${selr ? `${C}▸${R}` : " "} ${B}${M}${name.padEnd(10)}${R} ${def.readonly ? `${G}read-only${R}` : `${Y}mutating${R} `} ${D}${String(def.tools.length)} tools${R}  ${W}${meta.blurb}${R}${ap ? `  ${D}cap≥${ap.minCapability}${R}` : ""}`;
          rowList.push({ kind: "item", idx: i, text: selr ? `\x1b[48;5;236m${fit(line, cols)}\x1b[0m` : line });
        }
        const w = windowRows(rowList, AGENT_NAMES.length, sel, bodyH, listTop);
        listTop = w.top;
        body = w.lines;
      }
    }

    // ---- Models -----------------------------------------------------------
    else if (tab === "models") {
      let doc = loadCatalogue(l.catalogueFile);
      const all: CatalogueRow[] = doc?.models ?? [];
      let list = modelsAll ? all : all.filter((m) => isConfigured(m.providerID));
      if (modelFilter) {
        const f = modelFilter.toLowerCase();
        list = list.filter((m) => m.key.toLowerCase().includes(f) || m.name.toLowerCase().includes(f));
      }
      const groups = new Map<string, CatalogueRow[]>();
      for (const m of list) {
        const k = modelGroup === "provider" ? m.providerID : (m.family || "other");
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(m);
      }
      const pkeys = [...groups.keys()].sort((a, b) => {
        const ca = isConfigured(a) ? 0 : 1;
        const cb = isConfigured(b) ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return a.localeCompare(b);
      });
      type MItem = { row: CatalogueRow; idx: number };
      const items: MItem[] = [];
      const rowList: MRow[] = [];
      let fi = 0;
      for (const pk of pkeys) {
        const isCollapsed = collapsed.has(pk);
        const cfg = isConfigured(pk);
        rowList.push({
          kind: "group",
          key: pk,
          text: ` ${cfg ? C : GR}${isCollapsed ? "▸" : "▾"} ${B}${W}${pk}${R} ${D}(${groups.get(pk)?.length || 0})${cfg ? ` ${G}configured${R}` : ""}${R}`,
        });
        if (isCollapsed) continue;
        for (const m of groups.get(pk) || []) {
          const ph = (avail.models as any)[m.key];
          const cooling = ph?.cooldownUntil && ph.cooldownUntil > Date.now();
          const selr = fi === sel;
          const mrk = selr ? `${C}▸${R}` : " ";
          const cap = m.scores?.capability != null ? Number(m.scores.capability).toFixed(1) : "?";
          const price = `${Y}in ${fmtPrice(m.pricing.input)}${R} ${Y}out ${fmtPrice(m.pricing.output)}${R}`;
          const status = cooling ? `${Y}⏱${R}` : "";
          const line = `  ${mrk} ${BL}${trunc(m.name, 34)}${R} ${D}${fmtCtx(m.context)}${R} ${D}cap ${cap}${R} ${price}${status ? " " + status : ""}`;
          rowList.push({ kind: "item", idx: fi, text: selr ? `\x1b[48;5;236m${fit(line, cols)}\x1b[0m` : line });
          items.push({ row: m, idx: fi });
          fi++;
        }
      }
      if (sel >= fi) sel = Math.max(0, fi - 1);
      const w = windowRows(rowList, fi, sel, bodyH, listTop);
      listTop = w.top;
      body = w.lines;
      // Show details of the selected model in the last line? Keep list-only for now.
      void items;
    }

    // ---- Providers --------------------------------------------------------
    else if (tab === "providers") {
      const provs = ["openrouter", "opencode-go", "anthropic", "openai", "google", "deepinfra", "sambanova", "groq", "cerebras", "vercel"];
      const lines: string[] = [
        ` ${B}${W}Providers${R}`,
        ` ${B}${fit("Provider", 20)}${R}${fit("Configured", 16)}${fit("Health", 18)}${fit("Source", 26)}`,
        ` ${D}${"─".repeat(Math.max(0, cols - 2))}${R}`,
      ];
      for (const p of provs) {
        const envKey =
          p === "openrouter" ? "OPENROUTER_API_KEY" :
          p === "opencode-go" ? "OPENCODE_API_KEY" :
          p === "anthropic" ? "ANTHROPIC_API_KEY" :
          p === "openai" ? "OPENAI_API_KEY" :
          p === "google" ? "GOOGLE_API_KEY" : "";
        const set = envKey && process.env[envKey];
        const cfg = set ? `${G}configured${R}` : `${GR}no${R}`;
        const ph: any = (avail.providers as any)[p];
        let h = `${GR}—${R}`;
        if (ph?.disabled) h = `${RED}disabled${R}`;
        else if (ph?.needsAuth) h = `${Y}needs-auth${R}`;
        else if (ph?.cooldownUntil && ph.cooldownUntil > Date.now()) h = `${Y}cooling${R}`;
        else if (ph) h = `${G}ok${R}`;
        const src = set ? `${D}env:${envKey}${R}` : `${D}-${R}`;
        lines.push(` ${fit(W + p + R, 20)}${fit(cfg, 16)}${fit(h, 18)}${fit(src, 26)}`);
      }
      const maxScroll = Math.max(0, lines.length - bodyH);
      scroll = Math.max(0, Math.min(scroll, maxScroll));
      body = lines.slice(scroll, scroll + bodyH);
    }

    // ---- Spend ------------------------------------------------------------
    else if (tab === "spend") {
      const s = readSpendSummary(l.home);
      const lines: string[] = [
        ` ${B}${W}Spend (machine-wide)${R}`,
        ` ${B}actual ${Y}$${s.totalActual.toFixed(6)}${R}   ${D}estimated $${s.totalEstimated.toFixed(6)}${R}`,
        "",
        ` ${B}${C}By provider${R}`,
      ];
      for (const [k, v] of Object.entries(s.byProvider).sort((a: any, b: any) => b[1].actual - a[1].actual)) {
        lines.push(`   ${fit(W + k + R, 28)} ${G}${v.calls}${R} calls  ${Y}$${v.actual.toFixed(6)}${R}`);
      }
      lines.push("", ` ${B}${C}By model${R}`);
      for (const [k, v] of Object.entries(s.byModel).sort((a: any, b: any) => b[1].actual - a[1].actual).slice(0, 20)) {
        lines.push(`   ${fit(W + k + R, 44)} ${G}${v.calls}${R} calls  ${Y}$${v.actual.toFixed(6)}${R}`);
      }
      lines.push("", ` ${B}${C}By month${R}`);
      const byMonth: Record<string, { actual: number; calls: number }> = {};
      for (const [k, v] of Object.entries(s.byDay)) {
        const mo = k.slice(0, 7);
        const cur = byMonth[mo] ?? { actual: 0, calls: 0 };
        cur.actual += v.actual;
        cur.calls += v.calls;
        byMonth[mo] = cur;
      }
      for (const [k, v] of Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]))) {
        lines.push(`   ${W}${k}${R}  ${G}${v.calls}${R} calls  ${Y}$${v.actual.toFixed(6)}${R}`);
      }
      lines.push("", ` ${B}${C}By day${R}`);
      for (const [k, v] of Object.entries(s.byDay).sort((a: any, b: any) => b[0].localeCompare(a[0])).slice(0, 10)) {
        lines.push(`   ${W}${k}${R}  ${G}${v.calls}${R} calls  ${Y}$${v.actual.toFixed(6)}${R}`);
      }
      const maxScroll = Math.max(0, lines.length - bodyH);
      scroll = Math.max(0, Math.min(scroll, maxScroll));
      body = lines.slice(scroll, scroll + bodyH);
    }

    // ---- Settings ---------------------------------------------------------
    else if (tab === "settings") {
      let m;
      try { m = loadMachineConfig(l); } catch { m = undefined; }
      let policy: Policy | undefined;
      try { policy = loadPolicy(l); } catch { policy = undefined; }
      const lines: string[] = [
        ` ${B}${W}Settings${R}`,
        "",
        ` ${B}${C}Machine config${R} ${D}${l.machineConfig}${R}`,
      ];
      if (m) {
        lines.push(`   default mode ${m.defaultMode ? M + m.defaultMode + R : D + "-" + R}   max output ${m.maxOutputTokens ? C + m.maxOutputTokens + R : D + "-" + R}`);
        lines.push(`   price caps ${Y}in $${m.priceCaps.input}${R}/M ${Y}out $${m.priceCaps.output}${R}/M   vetoes ${m.vetoes.length ? RED + m.vetoes.join(", ") + R : D + "-" + R}`);
        lines.push(`   notify ${m.notify.webhookUrl ? G + "webhook" + R : D + "-" + R} ${m.notify.command ? G + "command" + R : ""}`);
      } else {
        lines.push(`   ${RED}config error${R}`);
      }
      lines.push("", ` ${B}${C}Repo policy${R} ${D}${l.policyFile}${R}`);
      if (policy) {
        for (const name of AGENT_NAMES) {
          const ap = policy.agents[name];
          if (ap) lines.push(`   ${M}${name.padEnd(10)}${R} ctx≥${ap.minContext} out≈${ap.expectedOutputTokens} cap≥${ap.minCapability} tools=${String(ap.toolCall)}${ap.budgetTokens ? ` budget=${ap.budgetTokens}` : ""}`);
        }
      } else {
        lines.push(`   ${D}(defaults)${R}`);
      }
      lines.push("", ` ${B}${C}Directories${R}`);
      lines.push(`   home        ${l.home}`);
      lines.push(`   repo        ${l.repoRoot}`);
      lines.push(`   repo state  ${l.repoDir}`);
      lines.push(`   local state ${l.localDir}`);
      lines.push(`   runs        ${l.runsDir}`);
      lines.push(`   tasks       ${join(l.repoDir, "tasks")}`);
      lines.push(`   worktrees   ${join(l.localDir, "worktrees")}`);
      lines.push(`   catalogue   ${l.catalogueFile}`);
      lines.push(`   spend       ${join(l.home, "spend.jsonl")}`);
      lines.push(`   availability ${join(l.home, "availability.json")}`);
      lines.push(`   references  ${join(l.repoDir, "references")}`);
      lines.push("", ` ${B}${C}Environment${R}`);
      lines.push(`   OPENROUTER_API_KEY ${process.env.OPENROUTER_API_KEY ? G + "set" + R : D + "unset" + R}   OPENCODE_API_KEY ${process.env.OPENCODE_API_KEY ? G + "set" + R : D + "unset" + R}`);
      lines.push(`   ANTHROPIC_API_KEY  ${process.env.ANTHROPIC_API_KEY ? G + "set" + R : D + "unset" + R}   OPENAI_API_KEY   ${process.env.OPENAI_API_KEY ? G + "set" + R : D + "unset" + R}`);
      const maxScroll = Math.max(0, lines.length - bodyH);
      scroll = Math.max(0, Math.min(scroll, maxScroll));
      body = lines.slice(scroll, scroll + bodyH);
    }

    // ---- Footer (2 lines) -------------------------------------------------
    let keys: string;
    if (tab === "runs" && view === "detail") {
      keys = `[Esc/q] back   [j/k] select event   [space] expand${detInfo ? `   ${detInfo}` : ""}`;
    } else if (view === "newrun") {
      keys = `[a] agent   [m] mode   [type] prompt   [Enter] launch   [Esc] cancel`;
    } else if (tab === "runs") {
      keys = `[n] new run   [g] group: ${groupMode}   [space] fold   [j/k] move   [Enter] open   [i] interrupt   [Tab/1-6] tabs   [q] quit`;
    } else if (tab === "agents") {
      keys = view === "detail"
        ? `[Esc/q] back   [j/k] scroll`
        : `[j/k] move   [Enter] details   [Tab/1-6] tabs   [q] quit`;
    } else if (tab === "models") {
      keys = `[g] group: ${modelGroup}   [f] ${modelsAll ? "all providers" : "configured only"}   [/] filter${modelFilter ? `: ${modelFilter}` : ""}   [space] fold   [j/k] move   [Tab/1-6] tabs   [q] quit`;
    } else {
      keys = `[Tab/1-6] switch tab   [q] quit`;
    }
    const footer = [`${D}${"─".repeat(cols)}${R}`, `${D}${fit(keys, cols)}${R}`];

    // ---- Compose: exactly `rows` lines ------------------------------------
    // Anything longer than the terminal height makes the terminal scroll, so
    // clip here and never emit a stray newline (see sanitizeLine).
    if (body.length > bodyH) body = body.slice(0, bodyH);
    while (body.length < bodyH) body.push("");
    const frame = [...header, ...body, ...footer].slice(0, rows);
    while (frame.length < rows) frame.push("");
    const lines = frame.map((ln) => fit(sanitizeLine(ln), cols));
    process.stdout.write(SYNC_ON + HOME + lines.join("\n") + CLEAR_BELOW + SYNC_OFF);
  };

  /** Reset per-view scroll state when the view shape changes. */
  const resetScroll = () => { listTop = 0; scroll = 0; };

  const modelsData = () => {
    const doc = loadCatalogue(l.catalogueFile);
    const all: CatalogueRow[] = doc?.models ?? [];
    let list = modelsAll ? all : all.filter((m) => isConfiguredPub(m.providerID));
    if (modelFilter) {
      const f = modelFilter.toLowerCase();
      list = list.filter((m) => m.key.toLowerCase().includes(f) || m.name.toLowerCase().includes(f));
    }
    return list;
  };
  const isConfiguredPub = (provider: string): boolean => {
    const envKey =
      provider === "openrouter" ? "OPENROUTER_API_KEY" :
      provider === "opencode-go" ? "OPENCODE_API_KEY" :
      provider === "anthropic" ? "ANTHROPIC_API_KEY" :
      provider === "openai" ? "OPENAI_API_KEY" :
      provider === "google" ? "GOOGLE_API_KEY" :
      provider === "deepinfra" ? "DEEPINFRA_API_KEY" :
      provider === "sambanova" ? "SAMBANOVA_API_KEY" :
      provider === "groq" ? "GROQ_API_KEY" :
      provider === "cerebras" ? "CEREBRAS_API_KEY" : "";
    return Boolean(envKey && process.env[envKey]);
  };

  stdin.on("data", (data: string) => {
    // New-run input mode
    if (view === "newrun") {
      if (data === "\x1b") { view = "list"; resetScroll(); draw(); return; }
      if (data === "\r" || data === "\n") {
        if (newrunPrompt.trim().length > 0) { launchRun(); view = "list"; newrunPrompt = ""; }
        resetScroll();
        draw();
        return;
      }
      if (data === "a") {
        const agents: Array<"general" | "sudo" | "architect"> = ["general", "sudo", "architect"];
        newrunAgent = agents[(agents.indexOf(newrunAgent) + 1) % agents.length]!;
        const modes = AGENT_META[newrunAgent].modes;
        if (!modes.includes(newrunMode)) newrunMode = modes[0]!;
        draw();
        return;
      }
      if (data === "m") {
        const modes = AGENT_META[newrunAgent].modes;
        if (modes.length > 0) newrunMode = modes[(modes.indexOf(newrunMode) + 1) % modes.length]!;
        draw();
        return;
      }
      if (data === "\x7f" || data === "\b") { newrunPrompt = newrunPrompt.slice(0, -1); draw(); return; }
      // Printable input: single keypress or a pasted/batched chunk. Escape
      // sequences (arrows etc.) start with ESC and are ignored here.
      if (!data.startsWith("\x1b") && /^[\x20-\x7e]+$/.test(data)) {
        newrunPrompt += data;
        if (newrunPrompt.length > 4000) newrunPrompt = newrunPrompt.slice(0, 4000);
        draw();
        return;
      }
      draw();
      return;
    }

    // Tab switching
    if (data === "\t") {
      tab = TABS[(TABS.indexOf(tab) + 1) % TABS.length]!;
      view = "list";
      sel = 0;
      resetScroll();
      draw();
      return;
    }
    const tabNum = Number(data);
    if (data.length === 1 && tabNum >= 1 && tabNum <= TABS.length) {
      tab = TABS[tabNum - 1]!;
      view = "list";
      sel = 0;
      resetScroll();
      draw();
      return;
    }

    // Quit / back
    if (data === "\x03") { cleanup(); process.exit(0); }
    if (data === "q") {
      if (tab === "runs" && view === "detail") { view = "list"; resetScroll(); draw(); return; }
      if (tab === "agents" && view === "detail") { view = "list"; resetScroll(); draw(); return; }
      cleanup();
      process.exit(0);
    }
    if (data === "\x1b") {
      if (view === "detail") { view = "list"; resetScroll(); draw(); return; }
      cleanup();
      process.exit(0);
    }

    // Runs list navigation
    if (tab === "runs" && view === "list") {
      const { flat } = buildFlat(listAllRuns(l.home), cwd, groupMode);
      if (data === "\x1b[A" || data === "k") { sel = (sel - 1 + flat.length) % (flat.length || 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { sel = (sel + 1) % (flat.length || 1); draw(); return; }
      if (data === "\r" || data === "\n") {
        if (flat[sel]) { view = "detail"; detSelEvent = 0; resetScroll(); }
        draw();
        return;
      }
      if (data === "i") { const r = flat[sel]; if (r) interruptRun(r); draw(); return; }
      if (data === "n") { view = "newrun"; newrunPrompt = ""; draw(); return; }
      if (data === "g") { groupMode = groupMode === "directory" ? "status" : "directory"; sel = 0; resetScroll(); draw(); return; }
      if (data === " ") {
        const r = flat[sel];
        const key = r ? (groupMode === "directory" ? (r.repoRoot || "unknown") : r.status) : undefined;
        if (key) { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); }
        draw();
        return;
      }
      draw();
      return;
    }

    // Runs detail navigation
    if (tab === "runs" && view === "detail") {
      const r = buildFlat(listAllRuns(l.home), cwd, groupMode).flat[sel];
      const d = r ? detailFor(r) : null;
      const n = d ? d.events.length : 0;
      if (data === "\x1b[A" || data === "k") { detSelEvent = Math.max(0, detSelEvent - 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { detSelEvent = Math.min(Math.max(0, n - 1), detSelEvent + 1); draw(); return; }
      if (data === " " && r) {
        const key = `${r.id}:${detSelEvent}`;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        draw();
        return;
      }
      draw();
      return;
    }

    // Agents navigation
    if (tab === "agents") {
      if (view === "detail") {
        if (data === "\x1b[A" || data === "k") { scroll = Math.max(0, scroll - 1); draw(); return; }
        if (data === "\x1b[B" || data === "j") { scroll = scroll + 1; draw(); return; }
        draw();
        return;
      }
      if (data === "\x1b[A" || data === "k") { sel = (sel - 1 + AGENT_NAMES.length) % AGENT_NAMES.length; draw(); return; }
      if (data === "\x1b[B" || data === "j") { sel = (sel + 1) % AGENT_NAMES.length; draw(); return; }
      if (data === "\r" || data === "\n") { view = "detail"; resetScroll(); draw(); return; }
      draw();
      return;
    }

    // Models navigation
    if (tab === "models") {
      const list = modelsData();
      const count = list.length;
      if (data === "\x1b[A" || data === "k") { sel = (sel - 1 + count) % (count || 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { sel = (sel + 1) % (count || 1); draw(); return; }
      if (data === "g") { modelGroup = modelGroup === "provider" ? "family" : "provider"; sel = 0; resetScroll(); draw(); return; }
      if (data === "f") { modelsAll = !modelsAll; sel = 0; resetScroll(); draw(); return; }
      if (data === "/") {
        // simple filter: next keypresses append; Enter clears. Minimal v1: cycle nothing.
        draw();
        return;
      }
      if (data === " ") {
        const row = list[sel];
        const key = row ? (modelGroup === "provider" ? row.providerID : (row.family || "other")) : "";
        if (key) { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); }
        draw();
        return;
      }
      draw();
      return;
    }

    // Scroll-only tabs
    if (data === "\x1b[A" || data === "k") { scroll = Math.max(0, scroll - 1); draw(); return; }
    if (data === "\x1b[B" || data === "j") { scroll = scroll + 1; draw(); return; }
    draw();
  });

  draw();
  setInterval(draw, 1000);
  process.stdout.on("resize", draw);
  await new Promise(() => { /* run until exit */ });
}
