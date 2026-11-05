/**
 * LSP registry: language detection, language IDs, symbol formatting, and
 * repo-coverage status. Server processes are not started here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allServers,
  formatServerList,
  formatSymbols,
  lspStatusForPaths,
} from "../dist/lsp/index.js";
import {
  languageForPath,
  languageIdForPath,
  serverForLanguage,
  serverForPath,
} from "../dist/lsp/servers.js";

test("LSP registry covers common languages beyond TypeScript", () => {
  const ids = new Set(allServers().map((spec) => spec.id));
  for (const id of ["typescript", "python", "rust", "go", "clangd", "java", "bash", "yaml", "json"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.ok(allServers().length >= 20);
});

test("language detection uses basenames and extensions", () => {
  assert.equal(languageForPath("src/a.ts"), "typescript");
  assert.equal(languageForPath("src/a.tsx"), "typescript");
  assert.equal(languageForPath("src/a.jsx"), "typescript");
  assert.equal(languageForPath("app/main.py"), "python");
  assert.equal(languageForPath("src/lib.rs"), "rust");
  assert.equal(languageForPath("cmd/main.go"), "go");
  assert.equal(languageForPath("src/a.c"), "clangd");
  assert.equal(languageForPath("src/a.cpp"), "clangd");
  assert.equal(languageForPath("Dockerfile"), "dockerfile");
  assert.equal(languageForPath("Dockerfile.dev"), "dockerfile");
  assert.equal(languageForPath("CMakeLists.txt"), "cmake");
  assert.equal(languageForPath("notes.txt"), null);
  assert.equal(serverForPath("notes.txt"), null);
  assert.equal(serverForLanguage("nope"), null);
});

test("language IDs distinguish TSX, SCSS, and JSONC", () => {
  assert.equal(languageIdForPath("src/a.ts"), "typescript");
  assert.equal(languageIdForPath("src/a.tsx"), "typescriptreact");
  assert.equal(languageIdForPath("src/a.jsx"), "javascriptreact");
  assert.equal(languageIdForPath("styles/a.scss"), "scss");
  assert.equal(languageIdForPath("data/a.jsonc"), "jsonc");
  assert.equal(languageIdForPath("notes.txt"), "plaintext");
});

test("workspace symbols format as path:line:column kind name", () => {
  const text = formatSymbols([
    {
      name: "RunRecorder",
      kind: 5,
      containerName: "state",
      location: {
        uri: "file:///repo/src/state/runs.ts",
        range: { start: { line: 41, character: 6 } },
      },
    },
  ]);
  assert.deepEqual(text, ["/repo/src/state/runs.ts:42:7 class RunRecorder (state)"]);
});

test("common LSP servers expose structured install commands", () => {
  for (const id of ["typescript", "python", "rust", "go", "bash", "yaml", "json", "ruby", "php"]) {
    const spec = serverForLanguage(id);
    assert.ok(spec, `missing ${id}`);
    assert.ok(spec.installCommand, `missing install command for ${id}`);
    assert.ok((spec.installCommand.args ?? []).length > 0, `empty install command for ${id}`);
  }
  assert.ok(allServers().filter((spec) => spec.installCommand).length >= 10);
});

test("repo coverage lists only matching servers with boolean availability", () => {
  const entries = lspStatusForPaths(["src/a.ts", "app/main.py", "README.md", "notes.txt"]);
  assert.deepEqual(entries.map((entry) => entry.language), ["markdown", "python", "typescript"]);
  for (const entry of entries) {
    assert.equal(typeof entry.available, "boolean");
    assert.ok(entry.install.length > 0);
  }
  assert.match(formatServerList(), /typescript/);
  assert.match(formatServerList(), /python/);
});
