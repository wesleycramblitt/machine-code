/**
 * machine_code — content-addressed run artifacts.
 *
 * Tool bodies are stored once and referenced by facts. A recall re-injects the
 * exact bytes; an edited or deleted file makes the old ref stale instead.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Artifact {
  id: string;
  bytes: number;
  hash: string;
}

function dir(runDir: string): string {
  return join(runDir, "artifacts");
}

function file(runDir: string, id: string): string {
  return join(dir(runDir), `${id}.txt`);
}

export function putArtifact(runDir: string, text: string): Artifact {
  const hash = createHash("sha256").update(text).digest("hex");
  const id = `art_${hash.slice(0, 16)}`;
  const target = file(runDir, id);
  mkdirSync(dir(runDir), { recursive: true });
  if (!existsSync(target)) writeFileSync(target, text, "utf8");
  return { id, bytes: Buffer.byteLength(text, "utf8"), hash };
}

export function getArtifact(runDir: string, id: string): string | null {
  if (!/^art_[a-f0-9]{16}$/.test(id)) return null;
  try {
    return readFileSync(file(runDir, id), "utf8");
  } catch {
    return null;
  }
}

export function artifactBytes(runDir: string, id: string): number {
  try {
    return Buffer.byteLength(readFileSync(file(runDir, id), "utf8"), "utf8");
  } catch {
    return 0;
  }
}
