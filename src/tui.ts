/**
 * machine_code — TUI
 *
 * Rendering contract: every frame is exactly `rows` lines. Header is always
 * the first 2 lines and footer the last 2; content is clipped/scrolled to
 * `rows - 4` lines. Because the frame never exceeds the terminal height, the
 * screen never scrolls and the tabs can never be pushed off the top.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { layout } from "./paths.js";
import { listAllRuns, readRun, listProjects, type RunSummary, type RunEvent } from "./state/runs.js";
import { listInstances } from "./state/instances.js";
import { loadMachineConfig } from "./config.js";
import { readSpendSummary } from "./spend.js";
import { loadAvailability } from "./availability.js";

const ALT = "\x1b[?1049h";
const ALT_L = "\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_BELOW = "\x1b[J";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

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

// Selected tab: cyan background, black text (the look that was liked).
const TAB_ON = "\x1b[46m\x1b[30m\x1b[1m";
const TAB_OFF = "\x1b[40m\x1b[37m";

type Tab = "runs" | "providers" | "spend" | "settings";
type View = "list" | "detail" | "newrun";
type GroupMode = "directory" | "status";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
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

/** Truncate to at most `n` visible columns, ANSI-aware. */
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

/** Pad/truncate to exactly `n` visible columns. */
function fit(s: string, n: number): string {
  const v = stripAnsi(s).length;
  if (v > n) return trunc(s, n);
  if (v < n) return s + " ".repeat(n - v);
  return s;
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

export async function runTui(): Promise<void> {
  const l = layout();
  const cwd = process.cwd();
  mkdirSync(l.localDir, { recursive: true });

  let tab: Tab = "runs";
  let view: View = "list";
  let sel = 0;
  let listTop = 0;
  let evScroll = 0;
  let detSelEvent = 0;
  const expanded = new Set<string>();
  let newrunPrompt = "";
  let newrunMode = "verified";
  let newrunAgent = "general";
  let groupMode: GroupMode = "directory";
  const collapsed = new Set<string>();

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  process.stdout.write(ALT + HIDE);

  const cleanup = () => {
    stdin.setRawMode?.(false);
    process.stdout.write(SHOW + ALT_L);
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

  const selectedRun = (): RunSummary | undefined => {
    const { flat } = buildFlat(listAllRuns(l.home), cwd, groupMode);
    return flat[sel];
  };

  const draw = () => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    const runs = listAllRuns(l.home);
    const { flat, groups, pkeys } = buildFlat(runs, cwd, groupMode);
    if (sel < 0) sel = 0;
    if (sel >= flat.length) sel = flat.length === 0 ? 0 : flat.length - 1;

    // ---- Header (2 lines) -------------------------------------------------
    const tabs: Tab[] = ["runs", "providers", "spend", "settings"];
    let tabBar = "";
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i]!;
      if (tab === t) tabBar += `${TAB_ON} ${i + 1}:${t} ${R}`;
      else tabBar += `${TAB_OFF} ${i + 1}:${t} ${R}`;
      tabBar += " ";
    }
    const instCount = listInstances(l.home).length;
    tabBar += `${D}${instCount} instance${instCount === 1 ? "" : "s"} • ${flat.length} run${flat.length === 1 ? "" : "s"}${R}`;
    const header = [fit(tabBar, cols), `${D}${"━".repeat(cols)}${R}`];

    // ---- Footer (2 lines) -------------------------------------------------
    let keys = "";
    if (tab === "runs" && view === "list") {
      keys = `[n] new run   [g] group: ${groupMode}   [space] fold   [j/k] move   [Enter] open   [i] interrupt   [Tab/1-4] tabs   [q] quit`;
    } else if (tab === "runs" && view === "detail") {
      keys = `[Esc/q] back   [j/k] select event   [space] expand   [i] interrupt`;
    } else if (tab === "runs" && view === "newrun") {
      keys = `[m] mode   [a] agent   [Enter] run   [Esc] cancel`;
    } else {
      keys = `[Tab/1-4] switch tab   [q] quit`;
    }
    const footer = [`${D}${"─".repeat(cols)}${R}`, `${D}${fit(keys, cols)}${R}`];

    const bodyH = Math.max(1, rows - header.length - footer.length);
    let body: string[] = [];

    // ---- Runs: list ------------------------------------------------------
    if (tab === "runs" && view === "list") {
      type Row = { kind: "group"; key: string; text: string } | { kind: "run"; fi: number; text: string };
      const rowList: Row[] = [];
      let fi = 0;
      for (const pk of pkeys) {
        const isCollapsed = collapsed.has(pk);
        if (groupMode === "directory") {
          const isCur = pk === cwd;
          const pn = basename(pk);
          const title = ` ${isCur ? C : GR}${isCollapsed ? "▸" : "▾"} ${B}${W}${pn}${R}${isCur ? ` ${C}(cwd)${R}` : ""} ${D}${pk} (${groups.get(pk)?.length || 0})${R}`;
          rowList.push({ kind: "group", key: pk, text: title });
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
          const avail = Math.max(16, cols - 60);
          const line = `  ${mrk} ${icon(r.status)} ${BL}${r.id.slice(-8)}${R} ${D}${ago(r.startedAt)}${R}  ${M}${r.agent}${R}/${r.mode}  ${W}${trunc(reqClean, avail)}${R}  ${D}│${R} ${stats}`;
          rowList.push({ kind: "run", fi, text: selr ? `\x1b[48;5;236m${line}${R}` : line });
          fi++;
        }
      }

      // Keep the selected run row visible.
      const selRow = rowList.findIndex((r) => r.kind === "run" && r.fi === sel);
      if (selRow >= 0) {
        if (selRow < listTop) listTop = selRow;
        if (selRow >= listTop + bodyH) listTop = selRow - bodyH + 1;
      }
      listTop = Math.max(0, Math.min(listTop, Math.max(0, rowList.length - bodyH)));
      body = rowList.slice(listTop, listTop + bodyH).map((r) => r.text);
    }

    // ---- Runs: detail ----------------------------------------------------
    else if (tab === "runs" && view === "detail") {
      const r = flat[sel];
      if (!r) {
        view = "list";
        return draw();
      }
      const rd = detailFor(r);
      if (rd) {
        const s = rd.summary;
        const ev = rd.events;
        if (detSelEvent >= ev.length) detSelEvent = Math.max(0, ev.length - 1);

        // Preamble (fixed): identity + status + request.
        const pre: string[] = [];
        pre.push(` ${icon(s.status)} ${B}${BL}${s.id}${R}  ${D}${s.repoRoot}${R}`);
        pre.push(` ${statusColor(s.status)}${B}${s.status.toUpperCase()}${R}  ${M}${s.agent}${R}/${s.mode}  ${G}${s.modelCalls}${R} calls  ${C}${s.usage.totalTokens.toLocaleString()}${R} tok  ${Y}$${s.cost.actual.toFixed(6)}${R}  ${D}pid ${s.pid}${R}`);
        if (s.error) pre.push(` ${RED}ERROR: ${s.error}${R}`);
        pre.push(` ${D}request:${R} ${W}${(s.request || "").replace(/\s+/g, " ").trim()}${R}`);
        pre.push(` ${D}${"─".repeat(Math.max(0, cols - 2))}${R}`);

        // Flatten events into lines with per-event start offsets.
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
                    const sc = c.score != null ? Number(c.score).toFixed(4) : "?";
                    const terms = c.terms ? ` cap ${Number(c.terms.capability ?? 0).toFixed(2)} cost ${Number(c.terms.cost ?? 0).toFixed(3)} speed ${Number(c.terms.speed ?? 0).toFixed(2)}` : "";
                    evFlat.push(`    ${chosen}${D}score ${R}${sc}${D}${terms}${R}  ${W}${c.key}${R}`);
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
                const inTok = (u.input ?? 0).toLocaleString();
                const outTok = (u.output ?? 0).toLocaleString();
                evFlat.push(`    ${D}input ${R}${inTok}  ${D}output ${R}${outTok}  ${D}cache_r ${R}${u.cacheRead ?? 0}  ${D}cache_w ${R}${u.cacheWrite ?? 0}`);
                const txt = typeof e.text === "string" ? e.text : "";
                if (txt) {
                  evFlat.push(`    ${D}response:${R}`);
                  for (const ln of wrapText(txt, Math.max(40, cols - 6))) evFlat.push(`    ${W}${ln}${R}`);
                }
              }
              break;
            }
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
                  for (const ln of s.finalText.split("\n")) evFlat.push(`    ${W}${ln}${R}`);
                }
              }
              break;
            }
            default:
              evFlat.push(`${p} ${GR}${t}${R} ${D}${et}${R}`);
          }
        }

        const preLen = pre.length;
        const viewport = Math.max(1, bodyH - preLen);
        const maxScroll = Math.max(0, evFlat.length - viewport);
        const selStart = evStart[detSelEvent] ?? 0;
        if (selStart < evScroll) evScroll = selStart;
        if (selStart >= evScroll + viewport) evScroll = selStart - viewport + 1;
        evScroll = Math.max(0, Math.min(evScroll, maxScroll));
        body = [...pre, ...evFlat.slice(evScroll, evScroll + viewport)];
      } else {
        body = [` ${RED}run not found${R}`];
      }
    }

    // ---- Runs: new run ---------------------------------------------------
    else if (tab === "runs" && view === "newrun") {
      const modes = ["solo", "direct", "verified", "redundant"];
      const agents = ["general", "sudo"];
      body = [
        ` ${B}${W}New Run${R}`,
        "",
        ` ${B}Mode${R}   ${modes.map((m) => (m === newrunMode ? `${TAB_ON} ${m} ${R}` : `${D}${m}${R}`)).join("  ")}`,
        ` ${B}Agent${R}  ${agents.map((a) => (a === newrunAgent ? `${TAB_ON} ${a} ${R}` : `${D}${a}${R}`)).join("  ")}${newrunMode !== "solo" ? `  ${D}(packet modes use architect/build/review)${R}` : ""}`,
        "",
        ` ${B}Prompt${R}`,
        "",
        `   ${newrunPrompt ? W + newrunPrompt + R : D + "(type the task, then press Enter)" + R}`,
      ];
    }

    // ---- Providers -------------------------------------------------------
    else if (tab === "providers") {
      const avail = loadAvailability(l.home);
      const provs = ["openrouter", "opencode-go", "anthropic", "openai", "google", "deepinfra", "sambanova", "groq", "cerebras", "vercel"];
      body = [
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
        body.push(` ${fit(W + p + R, 20)}${fit(cfg, 16)}${fit(h, 18)}${fit(src, 26)}`);
      }
    }

    // ---- Spend -----------------------------------------------------------
    else if (tab === "spend") {
      const s = readSpendSummary(l.home);
      body = [
        ` ${B}${W}Spend (machine-wide)${R}`,
        ` ${B}actual ${Y}$${s.totalActual.toFixed(6)}${R}   ${D}estimated $${s.totalEstimated.toFixed(6)}${R}`,
        "",
        ` ${B}${C}By provider${R}`,
      ];
      for (const [k, v] of Object.entries(s.byProvider).sort((a: any, b: any) => b[1].actual - a[1].actual)) {
        body.push(`   ${fit(W + k + R, 28)} ${G}${v.calls}${R} calls  ${Y}$${v.actual.toFixed(6)}${R}`);
      }
      body.push("", ` ${B}${C}By model${R}`);
      for (const [k, v] of Object.entries(s.byModel).sort((a: any, b: any) => b[1].actual - a[1].actual).slice(0, 20)) {
        body.push(`   ${fit(W + k + R, 44)} ${G}${v.calls}${R} calls  ${Y}$${v.actual.toFixed(6)}${R}`);
      }
      body.push("", ` ${B}${C}By day${R}`);
      for (const [k, v] of Object.entries(s.byDay).sort((a: any, b: any) => b[0].localeCompare(a[0])).slice(0, 10)) {
        body.push(`   ${W}${k}${R}  ${G}${v.calls}${R} calls  ${Y}$${v.actual.toFixed(6)}${R}`);
      }
    }

    // ---- Settings --------------------------------------------------------
    else if (tab === "settings") {
      let m;
      try { m = loadMachineConfig(l); } catch { m = undefined; }
      body = [
        ` ${B}${W}Settings${R}`,
        "",
        ` ${B}${C}Machine${R} ${D}~/.machine_code/config.toml${R}`,
        m
          ? `   default mode: ${m.defaultMode ? M + m.defaultMode + R : D + "-" + R}   max output: ${m.maxOutputTokens ? C + m.maxOutputTokens + R : D + "-" + R}`
          : `   ${RED}config error${R}`,
        m ? `   price caps: ${Y}in $${m.priceCaps.input}${R} ${Y}out $${m.priceCaps.output}${R}   vetoes: ${m.vetoes.length ? RED + m.vetoes.join(", ") + R : D + "-" + R}` : "",
        "",
        ` ${B}${C}Environment${R}`,
        `   OPENROUTER_API_KEY ${process.env.OPENROUTER_API_KEY ? G + "set" + R : D + "unset" + R}   OPENCODE_API_KEY ${process.env.OPENCODE_API_KEY ? G + "set" + R : D + "unset" + R}`,
        `   ANTHROPIC_API_KEY  ${process.env.ANTHROPIC_API_KEY ? G + "set" + R : D + "unset" + R}   OPENAI_API_KEY   ${process.env.OPENAI_API_KEY ? G + "set" + R : D + "unset" + R}`,
        "",
        ` ${B}${C}Paths${R}`,
        `   home ${l.home}`,
        `   repo ${l.repoRoot}`,
        `   runs ${l.runsDir}`,
      ];
    }

    // ---- Compose: exactly `rows` lines, never more -----------------------
    if (body.length > bodyH) body = body.slice(0, bodyH);
    while (body.length < bodyH) body.push("");
    const lines = [...header, ...body, ...footer].slice(0, rows).map((ln) => fit(ln, cols));
    while (lines.length < rows) lines.push(" ".repeat(cols));
    process.stdout.write(HOME + lines.join("\n") + CLEAR_BELOW);
  };

  stdin.on("data", (data: string) => {
    // New-run input mode
    if (view === "newrun") {
      if (data === "\x1b") { view = "list"; draw(); return; }
      if (data === "\r" || data === "\n") { view = "list"; draw(); return; }
      if (data === "m") {
        const modes = ["solo", "direct", "verified", "redundant"];
        newrunMode = modes[(modes.indexOf(newrunMode) + 1) % modes.length]!;
        if (newrunMode !== "solo") newrunAgent = "general";
        draw();
        return;
      }
      if (data === "a") {
        const agents = ["general", "sudo"];
        newrunAgent = agents[(agents.indexOf(newrunAgent) + 1) % agents.length]!;
        draw();
        return;
      }
      if (data === "\x7f" || data === "\b") { newrunPrompt = newrunPrompt.slice(0, -1); draw(); return; }
      if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
        newrunPrompt += data;
        draw();
        return;
      }
      draw();
      return;
    }

    // Tab switching
    if (data === "\t") {
      const t: Tab[] = ["runs", "providers", "spend", "settings"];
      tab = t[(t.indexOf(tab) + 1) % t.length]!;
      view = "list";
      draw();
      return;
    }
    if (data === "1") { tab = "runs"; view = "list"; draw(); return; }
    if (data === "2") { tab = "providers"; view = "list"; draw(); return; }
    if (data === "3") { tab = "spend"; view = "list"; draw(); return; }
    if (data === "4") { tab = "settings"; view = "list"; draw(); return; }

    // Quit / back
    if (data === "\x03") { cleanup(); process.exit(0); }
    if (data === "q") {
      if (tab === "runs" && view === "detail") { view = "list"; draw(); return; }
      cleanup();
      process.exit(0);
    }
    if (data === "\x1b") {
      if (tab === "runs" && view === "detail") { view = "list"; draw(); return; }
      cleanup();
      process.exit(0);
    }

    // Runs list navigation
    if (tab === "runs" && view === "list") {
      const { flat } = buildFlat(listAllRuns(l.home), cwd, groupMode);
      if (data === "\x1b[A" || data === "k") { sel = (sel - 1 + flat.length) % (flat.length || 1); draw(); return; }
      if (data === "\x1b[B" || data === "j") { sel = (sel + 1) % (flat.length || 1); draw(); return; }
      if (data === "\r" || data === "\n") {
        if (flat[sel]) { view = "detail"; detSelEvent = 0; evScroll = 0; }
        draw();
        return;
      }
      if (data === "i") { const r = flat[sel]; if (r) interruptRun(r); draw(); return; }
      if (data === "n") { view = "newrun"; newrunPrompt = ""; draw(); return; }
      if (data === "g") { groupMode = groupMode === "directory" ? "status" : "directory"; sel = 0; listTop = 0; draw(); return; }
      if (data === " ") {
        const { pkeys } = buildFlat(listAllRuns(l.home), cwd, groupMode);
        // Find the group the selected run belongs to.
        const r = flat[sel];
        const key = r ? (groupMode === "directory" ? (r.repoRoot || "unknown") : r.status) : pkeys[0];
        if (key) { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); }
        draw();
        return;
      }
      draw();
      return;
    }

    // Runs detail navigation
    if (tab === "runs" && view === "detail") {
      const r = selectedRun();
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
      if (data === "i") { if (r) interruptRun(r); draw(); return; }
      draw();
      return;
    }

    draw();
  });

  draw();
  setInterval(draw, 1000);
  process.stdout.on("resize", draw);
  await new Promise(() => { /* run until exit */ });
}
