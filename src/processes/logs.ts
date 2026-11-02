/** Bounded tail read for process logs; never loads a large log into memory. */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export function readLogTail(path: string, maxBytes = 4_000): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  if (size === 0) return "";
  const start = Math.max(0, size - Math.max(1, maxBytes));
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
