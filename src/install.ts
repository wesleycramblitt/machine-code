/**
 * machine_code — base-CLI installer.
 *
 * `machine_code install` installs missing base-palette CLIs. Default method is
 * a pinned static binary downloaded from the project's GitHub releases into a
 * user-writable bin dir — no root, no compiler, works on most any Linux box.
 * Package managers (pacman/apt/dnf/zypper/apk) and cargo are explicit opt-in
 * methods. Every installed binary is verified by running it.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface CliSpec {
  /** Canonical name used on the command line. */
  name: string;
  /** Binary names accepted as "present". */
  binaries: string[];
  purpose: string;
  /** Static download from GitHub releases, per arch. */
  download?: (arch: "x86_64" | "aarch64") => { url: string; kind: "raw" | "tar.gz" | "zip"; member: string };
  cargo?: string;
  /** Package names per manager; absent = no mapping (use download). */
  pacman?: string;
  apt?: string;
  dnf?: string;
}

const V = { jq: "1.8.2", yq: "4.54.1", sd: "1.1.0", sg: "0.51.0", rg: "15.2.0" } as const;

export const BASE_CLIS: CliSpec[] = [
  {
    name: "git",
    binaries: ["git"],
    purpose: "worktrees, branches, status, diff, history",
    // No sane static build: package manager only.
    pacman: "git",
    apt: "git",
    dnf: "git",
  },
  {
    name: "rg",
    binaries: ["rg"],
    purpose: "text search and filtered file listing",
    download: (arch) => ({
      url: `https://github.com/BurntSushi/ripgrep/releases/download/${V.rg}/ripgrep-${V.rg}-${arch}-unknown-linux-musl.tar.gz`,
      kind: "tar.gz",
      member: `ripgrep-${V.rg}-${arch}-unknown-linux-musl/rg`,
    }),
    pacman: "ripgrep",
    apt: "ripgrep",
    dnf: "ripgrep",
  },
  {
    name: "ast-grep",
    binaries: ["sg", "ast-grep"],
    purpose: "structural code search and rewrites",
    download: (arch) => ({
      url: `https://github.com/ast-grep/ast-grep/releases/download/${V.sg}/app-${arch}-unknown-linux-gnu.zip`,
      kind: "zip",
      // The `sg` shim is deprecated and errors without its sibling; install
      // the real binary. `ast-grep` also satisfies the sg presence check.
      member: "ast-grep",
    }),
    cargo: "ast-grep",
    pacman: "ast-grep",
  },
  {
    name: "jq",
    binaries: ["jq"],
    purpose: "JSON queries",
    download: (arch) => ({
      url: `https://github.com/jqlang/jq/releases/download/jq-${V.jq}/jq-linux-${arch === "x86_64" ? "amd64" : "arm64"}`,
      kind: "raw",
      member: "jq",
    }),
    pacman: "jq",
    apt: "jq",
    dnf: "jq",
  },
  {
    name: "yq",
    binaries: ["yq"],
    purpose: "YAML queries",
    download: (arch) => ({
      url: `https://github.com/mikefarah/yq/releases/download/v${V.yq}/yq_linux_${arch === "x86_64" ? "amd64" : "arm64"}`,
      kind: "raw",
      member: "yq",
    }),
    pacman: "go-yq",
    apt: "yq",
    dnf: "yq",
  },
  {
    name: "sd",
    binaries: ["sd"],
    purpose: "regex-by-default / literal bulk replacement",
    download: (arch) => ({
      url: `https://github.com/chmln/sd/releases/download/v${V.sd}/sd-v${V.sd}-${arch}-unknown-linux-musl.tar.gz`,
      kind: "tar.gz",
      member: `sd-v${V.sd}-${arch}-unknown-linux-musl/sd`,
    }),
    cargo: "sd",
    pacman: "sd",
    dnf: "sd",
  },
];

export function machineArch(): "x86_64" | "aarch64" {
  const m = process.arch;
  if (m === "x64") return "x86_64";
  if (m === "arm64") return "aarch64";
  throw new Error(`unsupported architecture: ${process.platform}/${m} (machine_code is Linux x86_64/aarch64 only)`);
}

export function findOnPath(binaries: string[], pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const name of binaries) {
    for (const dir of pathEnv.split(":")) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

/** First user-writable bin dir already on PATH, else ~/.machine_code/bin. */
export function installDir(home: string): { dir: string; onPath: boolean } {
  const pathDirs = (process.env.PATH ?? "").split(":");
  const homeDir = process.env.HOME ?? "";
  for (const candidate of [join(homeDir, ".local", "bin"), join(homeDir, "bin")]) {
    if (pathDirs.includes(candidate)) {
      mkdirSync(candidate, { recursive: true });
      return { dir: candidate, onPath: true };
    }
  }
  const fallback = join(home, "bin");
  mkdirSync(fallback, { recursive: true });
  return { dir: fallback, onPath: false };
}

function run(cmd: string, args: string[], opts: { sudo?: boolean } = {}): { ok: boolean; output: string } {
  const argv = opts.sudo ? ["sudo", "-n", cmd, ...args] : [cmd, ...args];
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 600_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

function verify(binaryPath: string): string | null {
  const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}`.trim().split("\n")[0] ?? null;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(300_000),
    redirect: "follow",
    headers: { "user-agent": "machine_code-installer" },
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(dest, bytes);
}

/** Move a file, falling back to copy+unlink across filesystems. */
function move(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(src, dest);
    unlinkSync(src);
  }
}

function extract(archive: string, kind: "raw" | "tar.gz" | "zip", member: string, outDir: string): string {
  if (kind === "raw") {
    const target = join(outDir, basename(member));
    move(archive, target);
    return target;
  }
  if (kind === "tar.gz") {
    const result = run("tar", ["-xzf", archive, "-C", outDir, member]);
    if (!result.ok) throw new Error(`tar extract failed: ${result.output}`);
    return join(outDir, member);
  }
  // zip: try unzip, then python3, then busybox
  for (const attempt of [
    () => run("unzip", ["-o", "-j", archive, member, "-d", outDir]),
    () => run("python3", ["-c", `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])`, archive, member, outDir]),
    () => run("busybox", ["unzip", "-o", "-j", archive, member, "-d", outDir]),
  ]) {
    const result = attempt();
    if (result.ok) return join(outDir, member);
  }
  throw new Error("cannot extract .zip: no unzip, python3, or busybox available");
}

export type InstallMethod = "download" | "pacman" | "apt" | "dnf" | "zypper" | "apk" | "cargo";

export interface InstallOutcome {
  name: string;
  status: "present" | "installed" | "failed" | "no-method";
  detail: string;
}

async function installOne(spec: CliSpec, method: InstallMethod, binDir: string): Promise<InstallOutcome> {
  if (method === "cargo") {
    if (!spec.cargo) return { name: spec.name, status: "no-method", detail: "no cargo package mapping" };
    if (!findOnPath(["cargo"])) return { name: spec.name, status: "failed", detail: "cargo not installed" };
    const result = run("cargo", ["install", "--locked", spec.cargo]);
    return result.ok
      ? { name: spec.name, status: "installed", detail: `cargo install ${spec.cargo}` }
      : { name: spec.name, status: "failed", detail: result.output.slice(-300) };
  }

  if (method !== "download") {
    const pkg = (spec as unknown as Record<string, string | undefined>)[method];
    if (!pkg) {
      return { name: spec.name, status: "no-method", detail: `no ${method} package mapping; use --method download` };
    }
    const args =
      method === "pacman" ? ["-S", "--needed", "--noconfirm", pkg]
      : method === "apt" ? ["install", "-y", pkg]
      : method === "dnf" ? ["install", "-y", pkg]
      : method === "zypper" ? ["--non-interactive", "install", pkg]
      : ["add", pkg]; // apk
    const needsRoot = method !== "apk" || true;
    const sudo = process.getuid !== undefined && process.getuid() !== 0;
    if (sudo && needsRoot) {
      const check = run("sudo", ["-n", "true"]);
      if (!check.ok) {
        return { name: spec.name, status: "failed", detail: "needs root; run with sudo or use --method download" };
      }
    }
    const result = run(method === "apt" ? "apt-get" : method, args, { sudo: sudo && needsRoot });
    return result.ok
      ? { name: spec.name, status: "installed", detail: `${method}: ${pkg}` }
      : { name: spec.name, status: "failed", detail: result.output.slice(-300) };
  }

  if (!spec.download) {
    return { name: spec.name, status: "no-method", detail: "no static build; install via your package manager" };
  }
  const arch = machineArch();
  const dl = spec.download(arch);
  const tmp = mkdtempSync(join(tmpdir(), "machine_code-install-"));
  try {
    const archivePath = join(tmp, `asset${dl.kind === "tar.gz" ? ".tar.gz" : dl.kind === "zip" ? ".zip" : ""}`);
    await downloadFile(dl.url, archivePath);
    const extracted = extract(archivePath, dl.kind, dl.member, tmp);
    const target = join(binDir, basename(dl.member));
    chmodSync(extracted, 0o755);
    move(extracted, target);
    const version = verify(target);
    if (version === null) {
      rmSync(target, { force: true });
      return { name: spec.name, status: "failed", detail: "downloaded binary does not run (wrong libc? try --method pacman or cargo)" };
    }
    return { name: spec.name, status: "installed", detail: `${target} (${version})` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface InstallOptions {
  method: InstallMethod;
  home: string;
  only?: string[];
}

export async function installClis(options: InstallOptions): Promise<number> {
  const arch = machineArch();
  const { dir: binDir, onPath } = installDir(options.home);
  const specs = BASE_CLIS.filter((s) => !options.only || options.only.includes(s.name));
  const unknown = (options.only ?? []).filter((n) => !BASE_CLIS.some((s) => s.name === n));
  if (unknown.length > 0) {
    process.stderr.write(`unknown CLI(s): ${unknown.join(", ")} (known: ${BASE_CLIS.map((s) => s.name).join(", ")})\n`);
    return 1;
  }

  process.stdout.write(`machine_code install — method ${options.method}, arch ${arch}, bin dir ${binDir}\n\n`);
  const outcomes: InstallOutcome[] = [];
  for (const spec of specs) {
    const present = findOnPath(spec.binaries);
    if (present) {
      outcomes.push({ name: spec.name, status: "present", detail: present });
      continue;
    }
    process.stdout.write(`installing ${spec.name}...\n`);
    try {
      outcomes.push(await installOne(spec, options.method, binDir));
    } catch (error) {
      outcomes.push({ name: spec.name, status: "failed", detail: (error as Error).message });
    }
  }

  process.stdout.write("\n");
  let failures = 0;
  for (const outcome of outcomes) {
    const mark =
      outcome.status === "present" ? "present  " :
      outcome.status === "installed" ? "installed" :
      outcome.status === "no-method" ? "no-method" : "FAILED   ";
    if (outcome.status === "failed") failures += 1;
    process.stdout.write(`  ${mark}  ${outcome.name.padEnd(10)} ${outcome.detail}\n`);
  }
  if (!onPath) {
    process.stdout.write(`\n${binDir} is not on PATH; add it:\n  export PATH="${binDir}:$PATH"\n`);
  }
  return failures > 0 ? 1 : 0;
}
