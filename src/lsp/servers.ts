/**
 * machine_code — language-server registry.
 *
 * A server spec is the static part: binary, args, file extensions, LSP
 * language IDs, and an install hint. Clients stay lazy and bounded; a missing
 * server is a normal state, not an error.
 */
import { extname } from "node:path";

export interface LspServerSpec {
  /** Stable id used by tools and config, e.g. "typescript". */
  id: string;
  name: string;
  binary: string;
  /** Alternative binaries accepted as present. */
  binaries?: string[];
  /** Fixed args, or a function for servers that need a per-root data dir. */
  args: string[] | ((root: string) => string[]);
  /** Lowercase extensions, including the dot. */
  extensions: string[];
  /** Exact basenames such as Dockerfile or CMakeLists.txt. */
  filenames?: string[];
  /** Extension -> LSP languageId. Use "*" for a default. */
  languageIds: Record<string, string>;
  /** Human install hint. */
  install: string;
  /** Probe args used to confirm the binary actually runs. [] skips the probe. */
  versionArgs?: string[];
  /** Passed to initialize.initializationOptions. */
  initializationOptions?: Record<string, unknown>;
}

export const LSP_SERVERS: readonly LspServerSpec[] = [
  {
    id: "typescript",
    name: "TypeScript / JavaScript",
    binary: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    install: "npm i -g typescript-language-server typescript",
  },
  {
    id: "python",
    name: "Python",
    binary: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageIds: { "*": "python" },
    install: "npm i -g pyright",
    versionArgs: [],
  },
  {
    id: "rust",
    name: "Rust",
    binary: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    languageIds: { "*": "rust" },
    install: "rustup component add rust-analyzer",
  },
  {
    id: "go",
    name: "Go",
    binary: "gopls",
    args: [],
    extensions: [".go"],
    languageIds: { "*": "go" },
    install: "go install golang.org/x/tools/gopls@latest",
    versionArgs: ["version"],
  },
  {
    id: "clangd",
    name: "C / C++",
    binary: "clangd",
    args: [],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
    languageIds: {
      ".c": "c",
      ".h": "c",
      ".cc": "cpp",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".hpp": "cpp",
      ".hh": "cpp",
      ".hxx": "cpp",
    },
    install: "apt install clangd | pacman -S clang | brew install llvm",
  },
  {
    id: "java",
    name: "Java",
    binary: "jdtls",
    args: (root) => ["-data", `${root}/.machine_code/local/cache/lsp/jdtls`],
    extensions: [".java"],
    languageIds: { "*": "java" },
    install: "https://github.com/eclipse-jdtls/eclipse.jdt.ls (or your package manager)",
    versionArgs: [],
  },
  {
    id: "bash",
    name: "Bash / Shell",
    binary: "bash-language-server",
    args: ["start"],
    extensions: [".sh", ".bash"],
    languageIds: { "*": "shellscript" },
    install: "npm i -g bash-language-server",
  },
  {
    id: "lua",
    name: "Lua",
    binary: "lua-language-server",
    args: [],
    extensions: [".lua"],
    languageIds: { "*": "lua" },
    install: "pacman -S lua-language-server | brew install lua-language-server",
  },
  {
    id: "yaml",
    name: "YAML",
    binary: "yaml-language-server",
    args: ["--stdio"],
    extensions: [".yaml", ".yml"],
    languageIds: { "*": "yaml" },
    install: "npm i -g yaml-language-server",
  },
  {
    id: "json",
    name: "JSON",
    binary: "vscode-json-language-server",
    args: ["--stdio"],
    extensions: [".json", ".jsonc"],
    languageIds: { ".json": "json", ".jsonc": "jsonc" },
    install: "npm i -g vscode-langservers-extracted",
    versionArgs: [],
  },
  {
    id: "html",
    name: "HTML",
    binary: "vscode-html-language-server",
    args: ["--stdio"],
    extensions: [".html", ".htm"],
    languageIds: { "*": "html" },
    install: "npm i -g vscode-langservers-extracted",
    versionArgs: [],
  },
  {
    id: "css",
    name: "CSS / SCSS / Less",
    binary: "vscode-css-language-server",
    args: ["--stdio"],
    extensions: [".css", ".scss", ".less"],
    languageIds: { ".css": "css", ".scss": "scss", ".less": "less" },
    install: "npm i -g vscode-langservers-extracted",
    versionArgs: [],
  },
  {
    id: "vue",
    name: "Vue",
    binary: "vue-language-server",
    args: ["--stdio"],
    extensions: [".vue"],
    languageIds: { "*": "vue" },
    install: "npm i -g @vue/language-server",
  },
  {
    id: "svelte",
    name: "Svelte",
    binary: "svelteserver",
    args: ["--stdio"],
    extensions: [".svelte"],
    languageIds: { "*": "svelte" },
    install: "npm i -g svelte-language-server",
  },
  {
    id: "ruby",
    name: "Ruby",
    binary: "ruby-lsp",
    args: [],
    extensions: [".rb", ".rake"],
    languageIds: { "*": "ruby" },
    install: "gem install ruby-lsp",
  },
  {
    id: "php",
    name: "PHP",
    binary: "intelephense",
    args: ["--stdio"],
    extensions: [".php"],
    languageIds: { "*": "php" },
    install: "npm i -g intelephense",
  },
  {
    id: "csharp",
    name: "C#",
    binary: "omnisharp",
    args: ["--languageserver"],
    extensions: [".cs"],
    languageIds: { "*": "csharp" },
    install: "https://github.com/OmniSharp/omnisharp-roslyn",
  },
  {
    id: "kotlin",
    name: "Kotlin",
    binary: "kotlin-language-server",
    args: [],
    extensions: [".kt", ".kts"],
    languageIds: { "*": "kotlin" },
    install: "https://github.com/Kotlin/kotlin-lsp",
  },
  {
    id: "swift",
    name: "Swift",
    binary: "sourcekit-lsp",
    args: [],
    extensions: [".swift"],
    languageIds: { "*": "swift" },
    install: "apt install sourcekit-lsp (or the Swift toolchain)",
  },
  {
    id: "zig",
    name: "Zig",
    binary: "zls",
    args: [],
    extensions: [".zig"],
    languageIds: { "*": "zig" },
    install: "pacman -S zls | brew install zls",
  },
  {
    id: "terraform",
    name: "Terraform",
    binary: "terraform-ls",
    args: ["serve"],
    extensions: [".tf", ".tfvars"],
    languageIds: { "*": "terraform" },
    install: "https://github.com/hashicorp/terraform-ls",
    versionArgs: ["version"],
  },
  {
    id: "dockerfile",
    name: "Dockerfile",
    binary: "docker-langserver",
    args: ["--stdio"],
    filenames: ["Dockerfile"],
    extensions: [],
    languageIds: { "*": "dockerfile" },
    install: "npm i -g dockerfile-language-server-nodejs",
    versionArgs: [],
  },
  {
    id: "nix",
    name: "Nix",
    binary: "nil",
    args: [],
    extensions: [".nix"],
    languageIds: { "*": "nix" },
    install: "nix-env -iA nixpkgs.nil",
  },
  {
    id: "cmake",
    name: "CMake",
    binary: "cmake-language-server",
    args: [],
    extensions: [".cmake"],
    filenames: ["CMakeLists.txt"],
    languageIds: { "*": "cmake" },
    install: "pip install cmake-language-server",
  },
  {
    id: "latex",
    name: "LaTeX",
    binary: "texlab",
    args: [],
    extensions: [".tex", ".bib"],
    languageIds: { "*": "latex" },
    install: "cargo install texlab | pacman -S texlab",
  },
  {
    id: "markdown",
    name: "Markdown",
    binary: "marksman",
    args: ["server"],
    extensions: [".md", ".markdown"],
    languageIds: { "*": "markdown" },
    install: "brew install marksman (or download a release)",
  },
  {
    id: "clojure",
    name: "Clojure",
    binary: "clojure-lsp",
    args: [],
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    languageIds: { "*": "clojure" },
    install: "brew install clojure-lsp",
  },
  {
    id: "dart",
    name: "Dart",
    binary: "dart",
    args: ["language-server"],
    extensions: [".dart"],
    languageIds: { "*": "dart" },
    install: "install the Dart SDK or Flutter",
  },
];

export function allServers(): readonly LspServerSpec[] {
  return LSP_SERVERS;
}

export function serverForLanguage(language: string): LspServerSpec | null {
  return LSP_SERVERS.find((spec) => spec.id === language) ?? null;
}

/** Pick the server for a path by exact basename, then extension. */
export function serverForPath(path: string): LspServerSpec | null {
  const normalized = path.replaceAll("\\", "/");
  const base = (normalized.split("/").pop() ?? normalized).toLowerCase();
  for (const spec of LSP_SERVERS) {
    for (const name of spec.filenames ?? []) {
      const lower = name.toLowerCase();
      if (base === lower || base.startsWith(`${lower}.`)) return spec;
    }
  }
  const ext = extname(base);
  if (!ext) return null;
  return LSP_SERVERS.find((spec) => spec.extensions.includes(ext)) ?? null;
}

export function languageForPath(path: string): string | null {
  return serverForPath(path)?.id ?? null;
}

export function languageIdForPath(path: string): string {
  const spec = serverForPath(path);
  if (!spec) return "plaintext";
  const ext = extname(path.toLowerCase());
  return spec.languageIds[ext] ?? spec.languageIds["*"] ?? "plaintext";
}

export function argsFor(spec: LspServerSpec, root: string): string[] {
  return typeof spec.args === "function" ? spec.args(root) : spec.args;
}
