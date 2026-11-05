/**
 * Repair tool arguments that a provider serialized as XML-ish text.
 *
 * Some models return one JSON object whose only value contains the rest of the
 * call as attribute syntax. Example:
 *
 *   { "action": "note\">\nkind: next\">\nRead src/a.ts" }
 *
 * The intent is clear, but the object fails schema validation. Repair the
 * fields the tool declares before validation. This is not a text tool protocol:
 * the repaired object must still pass the normal schema.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Field names from a TypeBox object schema. */
function parameterNames(parameters: unknown): Set<string> {
  if (!isRecord(parameters)) return new Set();
  const properties = parameters.properties;
  return isRecord(properties) ? new Set(Object.keys(properties)) : new Set();
}

function cleanValue(value: string): string {
  return value.replace(/"\s*>?\s*$/, "").replace(/^"+|"+$/g, "").trim();
}

/** True when a provider leaked attribute syntax into one argument value. */
export function looksLikeSerializedArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const values = Object.values(args);
  if (values.length !== 1) return false;
  const value = values[0];
  return typeof value === "string" && /^\s*[^"\n>]+?\s*"\s*>/.test(value);
}

/**
 * Recover `{ key: value, ... }` from a single leaked value such as
 * `note">\nkind: next">\nRead src/a.ts`. Unknown fields are ignored; the
 * normal schema still decides whether the repaired call is valid.
 */
export function repairToolArguments(args: unknown, parameters: unknown): unknown {
  if (!looksLikeSerializedArgs(args)) return args;
  const record = args as Record<string, unknown>;
  const firstKey = Object.keys(record)[0]!;
  const value = record[firstKey] as string;
  const fields = parameterNames(parameters);
  if (!fields.has(firstKey)) return args;

  const first = /^\s*([^"\n>]+?)\s*"\s*>\s*/.exec(value);
  if (!first) return args;

  const out: Record<string, unknown> = { [firstKey]: first[1]!.trim() };
  let pending: string | null = null;
  let fallback = "";

  for (const raw of value.slice(first[0].length).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair && fields.has(pair[1]!)) {
      out[pair[1]!] = cleanValue(pair[2]!);
      pending = null;
      continue;
    }
    const open = /^([A-Za-z_][\w-]*)\s*"\s*>?\s*$/.exec(line);
    if (open && fields.has(open[1]!)) {
      pending = open[1]!;
      continue;
    }
    if (pending) {
      out[pending] = cleanValue(line);
      pending = null;
      continue;
    }
    fallback = fallback ? `${fallback}\n${line}` : line;
  }

  // An unlabelled tail is the usual `text` field on context note calls.
  if (fallback && fields.has("text") && out.text === undefined) out.text = cleanValue(fallback);
  return out;
}
