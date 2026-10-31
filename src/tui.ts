/**
 * machine_code — TUI
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { layout } from "./paths.js";
import { listAllRuns, readRun, listProjects, type RunSummary, type RunEvent } from "./state/runs.js";
import { listInstances } from "./state/instances.js";
import { loadMachineConfig } from "./config.js";
import { readSpendSummary } from "./spend.js";
import { loadAvailability } from "./availability.js";

const ALT = "\x1b[?1049h";
const ALT_L = "\x1b[?1049l";
const CLR = "\x1b[2J\x1b[H";
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
const BG = "\x1b[48;5;236m";

type Tab = "runs" | "providers" | "spend" | "settings";
type View = "list" | "detail" | "newrun";
type GroupMode = "directory" | "status";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function trunc(s: string, n: number): string {
  if (!s) return "";
  const plain = stripAnsi(s);
  if (plain.length <= n) return s;
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

function padRight(s: string, n: number): string {
  const v = stripAnsi(s).length;
  if (v >= n) return trunc(s, n);
  return s + " ".repeat(n - v);
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

function buildFlat(runs: RunSummary[], cwd: string, groupMode: GroupMode): { flat: RunSummary[], groups: Map<string, RunSummary[]>, pkeys: string[] } {
  const groups = new Map<string, RunSummary[]>();
  if (groupMode === "directory") {
    for (const r of runs) {
      const k = r.repoRoot || "unknown";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    const pkeys = [...groups.keys()].sort((a, b) => {
      if (a === cwd) return -1;
      if (b === cwd) return 1;
      return basename(a).localeCompare(basename(b));
    });
    const flat: RunSummary[] = [];
    for (const pk of pkeys) {
      const arr = groups.get(pk);
      if (arr) for (const r of arr) flat.push(r);
    }
    return { flat, groups, pkeys };
  } else {
    const order = ["running", "blocked", "failed", "interrupted", "done"];
    for (const r of runs) {
      const k = r.status;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    const pkeys = order.filter(k => groups.has(k));
    const flat: RunSummary[] = [];
    for (const pk of pkeys) {
      const arr = groups.get(pk);
      if (arr) for (const r of arr) flat.push(r);
    }
    return { flat, groups, pkeys };
  }
}

export async function runTui(): Promise<void> {
  const l = layout();
  const cwd = process.cwd();
  mkdirSync(l.localDir, { recursive: true });

  let tab: Tab = "runs";
  let view: View = "list";
  let sel = 0;
  let detScroll = 0;
  let detSelEvent = 0;
  let expandedEvents = new Set<number>();
  let newrunPrompt = "";
  let newrunMode = "verified";
  let newrunAgent = "architect";
  let groupMode: GroupMode = "directory";
  const collapsed = new Set<string>();

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  process.stdout.write(HIDE);

  const cleanup = () => {
    stdin.setRawMode?.(false);
    process.stdout.write(SHOW);
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
    } catch { }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(cf, JSON.stringify({ seq, action: "interrupt", from: process.pid }) + "\n", "utf8");
    } catch { }
  };

  const draw = () => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    const runs = listAllRuns(l.home);
    const { flat, groups, pkeys } = buildFlat(runs, cwd, groupMode);
    if (sel < 0) sel = 0;
    if (sel >= flat.length) sel = flat.length === 0 ? 0 : flat.length - 1;

    let out = CLR;

    // Header (anchored top) - 3 lines
    const tabs: Tab[] = ["runs", "providers", "spend", "settings"];
    let header = "TABS: ";
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i]!;
      if (tab === t) {
        header += ">>[" + (i + 1) + ":" + t.toUpperCase() + "]<< ";
      } else {
        header += "[" + (i + 1) + ":" + t + "] ";
      }
    }
    out += B + header + R + "\n";
    out += D + "━".repeat(cols) + R + "\n";

    const FOOTER_H = 1;
    const CONTENT_H = rows - 3; // header(2) + footer(1)

    if (tab === "runs") {
      if (view === "list") {
        out += " " + B + "RUNS" + R + " " + D + "• grouped by " + groupMode + R + "\n";
        let lineCount = 0;
        const maxLines = CONTENT_H - 4;
        let fi = 0;
        for (const pk of pkeys) {
          if (lineCount >= maxLines) break;
          const isCollapsed = collapsed.has(pk);
          if (groupMode === "directory") {
            const isCur = pk === cwd;
            const pn = basename(pk);
            const projLine = " " + (isCur ? C : GR) + (isCollapsed ? "▸" : "▾") + " " + B + W + pn + R + (isCur ? " " + C + "(cwd)" + R : "") + " " + D + pk + " (" + (groups.get(pk)?.length || 0) + ")" + R;
            out += padRight(projLine, cols) + "\n";
            lineCount++;
            if (isCollapsed) continue;
          } else {
            const sc = statusColor(pk);
            const grpLine = " " + sc + (isCollapsed ? "▸" : "▾") + " " + B + sc + pk.toUpperCase() + R + " " + D + "(" + (groups.get(pk)?.length || 0) + ")" + R;
            out += padRight(grpLine, cols) + "\n";
            lineCount++;
            if (isCollapsed) continue;
          }
          const arr = groups.get(pk) || [];
          for (const r of arr) {
            if (lineCount >= maxLines) break;
            const selr = fi === sel;
            const mrk = selr ? C + "▸" + R : "  ";
            const ic = icon(r.status);
            const shortId = r.id.slice(-8);
            const tm = ago(r.startedAt);
            const am = M + r.agent + R + "/" + r.mode;
            const reqClean = (r.request || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
            const stats = G + r.modelCalls + R + "c " + C + r.usage.totalTokens + R + "tok " + Y + "$" + r.cost.actual.toFixed(4) + R;
            const line = "    " + mrk + " " + ic + " " + BL + shortId + R + " " + D + tm + R + "  " + am + "  " + W + trunc(reqClean, Math.max(20, cols - 95)) + R + "  " + D + "│" + R + " " + stats;
            if (selr) {
              out += "\x1b[48;5;236m" + padRight(line, cols) + "\x1b[0m\n";
            } else {
              out += padRight(line, cols) + "\n";
            }
            lineCount++;
            fi++;
          }
        }
        // Pad remaining lines
        while (lineCount < maxLines) {
          out += " ".repeat(cols) + "\n";
          lineCount++;
        }
        // Footer anchored at bottom
        out += D + "─".repeat(cols) + R + "\n";
        out += D + "[n] new  [g] group:" + groupMode + "  [space] collapse  [j/k] navigate  [Enter] details  [i] interrupt  [Tab/1-4] switch  [q] quit" + R + "\n";
      } else if (view === "detail") {
        const r = flat[sel];
        if (!r) { view = "list"; draw(); return; }
        const rd2 = r.repoRoot ? readRun(layout(r.repoRoot), r.id) : null;
        const rd = rd2 || findRun(l.home, r.id);
        out += " " + B + icon(r.status) + " Run" + R + " " + BL + r.id + R + " " + D + "│  " + r.repoRoot + R + "\n";
        out += D + "━".repeat(cols) + R + "\n";
        if (rd) {
          const s = rd.summary;
          out += " " + statusColor(s.status) + B + s.status.toUpperCase() + R + "  " + M + s.agent + R + "/" + s.mode + "  •  " + G + s.modelCalls + R + " calls  •  " + C + s.usage.totalTokens.toLocaleString() + R + " tok  •  " + Y + "$" + s.cost.actual.toFixed(6) + R + "  •  " + D + "pid:" + s.pid + R + "\n";
          if (s.error) out += " " + RED + B + "ERROR:" + R + " " + RED + s.error + R + "\n";
          out += "\n " + B + W + "Request" + R + "\n";
          for (const ln of (s.request || "").split("\n").slice(0, 4)) out += "   " + ln + "\n";
          out += "\n " + B + W + "Event Stream" + R + " " + D + "(" + rd.events.length + " events) • [space] expand • [j/k] scroll" + R + "\n";
          out += " " + D + "─".repeat(cols - 2) + R + "\n";
          const maxEv = Math.max(3, rows - 20);
          // Clamp scroll
          const maxScroll = Math.max(0, rd.events.length - maxEv);
          if (detScroll < 0) detScroll = 0;
          if (detScroll > maxScroll) detScroll = maxScroll;
          const start = detScroll;
          for (let ei = start; ei < rd.events.length && (ei - start) < maxEv; ei++) {
            const e = rd.events[ei]!;
            const t = String(e.t).slice(11, 19);
            const et = String(e.type);
            const isSel = ei === detSelEvent;
            const prefix = isSel ? C + "▸" + R + " " : "  ";
            if (et === "run_start") out += prefix + GR + t + R + " " + C + "▶" + R + " " + B + "START" + R + " " + M + e.agent + R + "/" + e.mode + "\n";
            else if (et === "model_select") {
              if (e.error) out += prefix + GR + t + R + " " + RED + "▸" + R + " " + RED + "SELECT ERR" + R + " " + String(e.error).slice(0, 70) + "\n";
              else out += prefix + GR + t + R + " " + BL + "▸" + R + " " + D + "select" + R + " " + C + e.key + R + "\n";
            } else if (et === "model_call_end") {
              const u: any = e.usage || {};
              out += prefix + GR + t + R + " " + M + "◉" + R + " " + W + e.provider + R + "/" + e.model + " " + statusColor(String(e.stopReason)) + e.stopReason + R + " " + G + (u.totalTokens || 0) + R + "tok " + (e.cost != null ? Y + "$" + Number(e.cost).toFixed(6) + R : "") + "\n";
              if (e.error) out += "   " + RED + String(e.error).slice(0, 100) + R + "\n";
              if (expandedEvents.has(ei)) {
                out += "   " + D + "in:" + R + u.input + " " + D + "out:" + R + u.output + " " + D + "cache_r:" + R + u.cacheRead + " " + D + "cache_w:" + R + u.cacheWrite + "\n";
              }
            } else if (et === "tool_call") {
              out += prefix + GR + t + R + " " + Y + "⚡" + R + " tool " + B + W + e.tool + R + " " + (e.isError ? RED + "ERR" + R : G + "ok" + R) + "\n";
              if (expandedEvents.has(ei) && e.args) out += "   " + D + JSON.stringify(e.args).slice(0, 200) + R + "\n";
            } else if (et === "gates") out += prefix + GR + t + R + " " + B + "⊞" + R + " gates " + (e.passed ? G + B + "PASS" + R : RED + B + "FAIL" + R) + "\n";
            else if (et === "error_classified") out += prefix + GR + t + R + " " + RED + "⚠" + R + " " + Y + e.kind + R + (e.disableProvider ? " " + RED + "[disable]" + R : "") + (e.needsAuth ? " " + Y + "[auth]" + R : "") + "\n";
            else if (et === "retry") out += prefix + GR + t + R + " " + Y + "↻" + R + " " + D + "retry" + R + "\n";
            else if (et === "control") out += prefix + GR + t + R + " " + Y + "⌘" + R + " " + D + "ctrl:" + e.action + R + "\n";
            else if (et === "run_end") {
              const sc = s.status === "done" ? G : RED;
              out += prefix + GR + t + R + " " + sc + "■" + R + " " + B + sc + String(e.status).toUpperCase() + R + (e.error ? " " + RED + String(e.error).slice(0, 70) + R : "") + "\n";
              if (expandedEvents.has(ei)) {
                out += "   " + D + "total:" + R + s.usage.totalTokens + " " + D + "cost:" + R + "$" + s.cost.actual.toFixed(6) + " " + D + "calls:" + R + s.modelCalls + "\n";
              }
            } else out += prefix + GR + t + R + " " + D + et + R + "\n";
          }
        }
        out += "\n" + D + "─".repeat(cols) + R + "\n";
        out += D + "[Esc/q] back  [space] expand  [j/k] scroll  [i] interrupt" + R + "\n";
      } else if (view === "newrun") {
        out += " " + B + W + "New Run" + R + "\n";
        out += D + "━".repeat(cols) + R + "\n";
        out += "\n " + B + "Mode:" + R + " " + (newrunMode === "solo" ? C + "[solo]" + R : D + " solo " + R) + "  " + (newrunMode === "direct" ? C + "[direct]" + R : D + " direct " + R) + "  " + (newrunMode === "verified" ? C + "[verified]" + R : D + " verified " + R) + "  " + (newrunMode === "redundant" ? C + "[redundant]" + R : D + " redundant " + R) + "\n";
        out += " " + B + "Agent:" + R + " " + (newrunAgent === "general" ? C + "[general]" + R : D + " general " + R) + " " + (newrunAgent === "sudo" ? C + "[sudo]" + R : D + " sudo " + R) + "\n";
        out += "\n " + B + "Prompt:" + R + "\n";
        out += " " + W + (newrunPrompt || D + "(type your prompt...)" + R) + R + "\n";
        out += "\n" + D + "─".repeat(cols) + R + "\n";
        out += D + "[m] mode  [a] agent  [Enter] run  [Esc] cancel" + R + "\n";
      }
    } else if (tab === "providers") {
      out += " " + B + W + "Providers" + R + "\n";
      out += D + "━".repeat(cols) + R + "\n";
      try {
        const avail = loadAvailability(l.home);
        out += " " + B + padRight("Provider", 20) + R + padRight("Status", 16) + R + padRight("Source", 22) + R + padRight("Health", 16) + R + "\n";
        out += " " + D + "─".repeat(cols - 4) + R + "\n";
        const provs = ["openrouter", "opencode-go", "anthropic", "openai", "google", "deepinfra", "sambanova", "groq", "cerebras", "vercel"];
        for (const p of provs) {
          const key = p === "openrouter" ? "OPENROUTER_API_KEY" : p === "opencode-go" ? "OPENCODE_API_KEY" : p === "anthropic" ? "ANTHROPIC_API_KEY" : p === "openai" ? "OPENAI_API_KEY" : p === "google" ? "GOOGLE_API_KEY" : "";
          const cfg = key && process.env[key] ? G + "✓ configured" + R : GR + "✗ not configured" + R;
          const ph: any = (avail.providers as any)[p];
          let h = GR + "—" + R;
          if (ph?.disabled) h = RED + "✗ disabled" + R;
          else if (ph?.needsAuth) h = Y + "⚠ needs auth" + R;
          else if (ph?.cooldownUntil && ph.cooldownUntil > Date.now()) h = Y + "⏱ cooling" + R;
          else if (ph) h = G + "✓ ok" + R;
          const src = key && process.env[key] ? C + "env:" + key + R : D + "-" + R;
          out += " " + padRight(W + p + R, 20) + padRight(cfg, 16 + 10) + padRight(src, 22) + h + "\n";
        }
      } catch (e: any) { out += " " + RED + e.message + R + "\n"; }
      out += "\n" + D + "─".repeat(cols) + R + "\n";
      out += D + "[Tab/1-4] switch  [q] quit" + R + "\n";
    } else if (tab === "spend") {
      out += " " + B + W + "Spend (machine-wide)" + R + "\n";
      out += D + "━".repeat(cols) + R + "\n";
      try {
        const s = readSpendSummary(l.home);
        out += " " + B + "Total:" + R + " " + Y + "$" + s.totalActual.toFixed(6) + R + " actual / " + D + "$" + s.totalEstimated.toFixed(6) + R + " estimated\n\n";
        out += " " + B + C + "By Provider" + R + "\n";
        const ps = Object.entries(s.byProvider).sort((a: any, b: any) => b[1].actual - a[1].actual);
        for (const [k, v] of ps.slice(0, 12)) out += "   " + W + k + R + "  " + G + v.calls + R + " calls  " + Y + "$" + v.actual.toFixed(6) + R + "\n";
        out += "\n " + B + C + "By Model" + R + "\n";
        const ms = Object.entries(s.byModel).sort((a: any, b: any) => b[1].actual - a[1].actual);
        for (const [k, v] of ms.slice(0, 14)) out += "   " + W + k + R + "  " + G + v.calls + R + " calls  " + Y + "$" + v.actual.toFixed(6) + R + "\n";
        out += "\n " + B + C + "By Day" + R + "\n";
        const ds = Object.entries(s.byDay).sort((a: any, b: any) => b[0].localeCompare(a[0]));
        for (const [k, v] of ds.slice(0, 8)) out += "   " + W + k + R + "  " + G + v.calls + R + " calls  " + Y + "$" + v.actual.toFixed(6) + R + "\n";
      } catch (e: any) { out += " " + RED + e.message + R + "\n"; }
      out += "\n" + D + "─".repeat(cols) + R + "\n";
      out += D + "[Tab/1-4] switch  [q] quit" + R + "\n";
    } else if (tab === "settings") {
      out += " " + B + W + "Settings" + R + "\n";
      out += D + "━".repeat(cols) + R + "\n";
      try {
        const m = loadMachineConfig(l);
        out += " " + B + C + "Machine" + R + " " + D + "~/.machine_code/config.toml" + R + "\n";
        out += "   defaultMode: " + (m.defaultMode ? M + m.defaultMode + R : D + "-" + R) + "   maxOutputTokens: " + (m.maxOutputTokens ? C + m.maxOutputTokens + R : D + "-" + R) + "\n";
        out += "   priceCaps: " + Y + "in=$" + m.priceCaps.input + R + " " + Y + "out=$" + m.priceCaps.output + R + "   vetoes: " + (m.vetoes.length ? RED + m.vetoes.join(", ") + R : D + "-" + R) + "\n\n";
        out += " " + B + C + "Environment" + R + "\n";
        out += "   OPENROUTER_API_KEY: " + (process.env.OPENROUTER_API_KEY ? G + "✓ set" + R : D + "✗ not set" + R) + "   OPENCODE_API_KEY: " + (process.env.OPENCODE_API_KEY ? G + "✓ set" + R : D + "✗ not set" + R) + "\n";
        out += "   ANTHROPIC_API_KEY: " + (process.env.ANTHROPIC_API_KEY ? G + "✓ set" + R : D + "✗ not set" + R) + "   OPENAI_API_KEY: " + (process.env.OPENAI_API_KEY ? G + "✓ set" + R : D + "✗ not set" + R) + "\n\n";
        out += " " + B + C + "Paths" + R + "\n";
        out += "   " + D + "Home:" + R + " " + l.home + "\n   " + D + "Repo:" + R + " " + l.repoRoot + "\n   " + D + "Runs:" + R + " " + l.runsDir + "\n";
      } catch (e: any) { out += " " + RED + e.message + R + "\n"; }
      out += "\n" + D + "─".repeat(cols) + R + "\n";
      out += D + "[Tab/1-4] switch  [q] quit" + R + "\n";
    }

    process.stdout.write(out);
  };

  stdin.on("data", (data: string) => {
    if (view === "newrun") {
      if (data === "\x1b") { view = "list"; draw(); return; }
      if (data === "\r" || data === "\n") { view = "list"; draw(); return; }
      if (data === "m") { const modes = ["solo", "direct", "verified", "redundant"]; newrunMode = modes[(modes.indexOf(newrunMode) + 1) % modes.length]!; draw(); return; }
      if (data === "a") { const agents = ["general", "sudo"]; newrunAgent = agents[(agents.indexOf(newrunAgent) + 1) % agents.length]!; draw(); return; }
      if (data === "\x7f" || data === "\b") { newrunPrompt = newrunPrompt.slice(0, -1); draw(); return; }
      if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) { newrunPrompt += data; draw(); return; }
      draw();
      return;
    }

    if (data === "\x1b[A" || data === "k") {
      if (tab === "runs" && view === "list") {
        const { flat } = buildFlat(listAllRuns(l.home), cwd, groupMode);
        sel = (sel - 1 + flat.length) % (flat.length || 1);
      } else if (view === "detail") {
        detSelEvent = Math.max(0, detSelEvent - 1);
      }
    } else if (data === "\x1b[B" || data === "j") {
      if (tab === "runs" && view === "list") {
        const { flat } = buildFlat(listAllRuns(l.home), cwd, groupMode);
        sel = (sel + 1) % (flat.length || 1);
      } else if (view === "detail") {
        const r = buildFlat(listAllRuns(l.home), cwd, groupMode).flat[sel];
        if (r) {
          const rd = r.repoRoot ? readRun(layout(r.repoRoot), r.id) : null;
          const d = rd || findRun(l.home, r.id);
          if (d) {
            detSelEvent = Math.min(d.events.length - 1, detSelEvent + 1);
          }
        }
      }
    } else if (data === "\t") {
      const t: Tab[] = ["runs", "providers", "spend", "settings"];
      tab = t[(t.indexOf(tab) + 1) % t.length]!;
      view = "list";
    } else if (data === "1") { tab = "runs"; view = "list"; }
    else if (data === "2") { tab = "providers"; view = "list"; }
    else if (data === "3") { tab = "spend"; view = "list"; }
    else if (data === "4") { tab = "settings"; view = "list"; }
    else if (data === "\r" || data === "\n") {
      if (tab === "runs" && view === "list") view = "detail";
    } else if (data === "\x1b") {
      if (view === "detail") view = "list";
      else { cleanup(); process.exit(0); }
    } else if (data === "q") {
      if (view === "detail") view = "list";
      else { cleanup(); process.exit(0); }
    } else if (data === "i") {
      if (tab === "runs" && view === "list") {
        const { flat } = buildFlat(listAllRuns(l.home), cwd, groupMode);
        if (flat[sel]) interruptRun(flat[sel]!);
      }
    } else if (data === "n") {
      if (tab === "runs" && view === "list") { view = "newrun"; newrunPrompt = ""; }
    } else if (data === "g") {
      if (tab === "runs" && view === "list") { groupMode = groupMode === "directory" ? "status" : "directory"; sel = 0; }
    } else if (data === " ") {
      if (tab === "runs" && view === "list") {
        const { pkeys } = buildFlat(listAllRuns(l.home), cwd, groupMode);
        if (pkeys.length > 0) {
          const curKey = pkeys[Math.min(sel, pkeys.length - 1)] || pkeys[0]!;
          if (collapsed.has(curKey)) collapsed.delete(curKey); else collapsed.add(curKey);
        }
      } else if (tab === "runs" && view === "detail") {
        if (expandedEvents.has(detSelEvent)) expandedEvents.delete(detSelEvent); else expandedEvents.add(detSelEvent);
      }
    }
    draw();
  });

  draw();
  setInterval(draw, 1000);
  await new Promise(() => { });
}
