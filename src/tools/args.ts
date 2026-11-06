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
function recoverSerializedArgs(args: unknown, parameters: unknown): unknown {
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

/** Declared value types for one tool parameter, following anyOf unions. */
function declaredTypes(schema: unknown): Set<string> {
  const types = new Set<string>();
  if (!isRecord(schema)) return types;
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
  for (const variant of variants) {
    if (isRecord(variant) && typeof variant.type === "string") types.add(variant.type);
  }
  return types;
}

/**
 * Coerce unambiguous serialization artifacts using the tool's own schema.
 * Weak models emit absent optionals as the string "null" (or "undefined")
 * and numbers as strings. For a field whose declared type is not string
 * those values can never be legitimate input, so drop/coerce them before
 * validation instead of failing the call. String-typed fields are left
 * alone here — only the owning tool knows whether "null" is meaningful.
 */
function coerceScalarArtifacts(
  args: Record<string, unknown>,
  parameters: unknown,
): Record<string, unknown> | null {
  if (!isRecord(parameters)) return null;
  const properties = isRecord(parameters.properties)
    ? (parameters.properties as Record<string, unknown>)
    : null;
  if (!properties) return null;
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const schema = isRecord(properties[key]) ? properties[key] : null;
    if (!schema) continue;
    const types = declaredTypes(schema);
    if (types.size === 0 || types.has("string")) continue;
    const trimmed = value.trim();
    if (trimmed === "null" || trimmed === "undefined") {
      out ??= { ...args };
      delete out[key];
      continue;
    }
    if ((types.has("number") || types.has("integer")) && trimmed !== "" && Number.isFinite(Number(trimmed))) {
      out ??= { ...args };
      out[key] = Number(trimmed);
    }
  }
  return out;
}

/**
 * Repair weak-model serialization defects before schema validation. Handles
 * provider-leaked attribute syntax first, then schema-aware scalar coercion.
 * Returns the original reference when nothing changed so callers can tell a
 * repair happened.
 */
export function repairToolArguments(args: unknown, parameters: unknown): unknown {
  const recovered = recoverSerializedArgs(args, parameters);
  if (!isRecord(recovered)) return recovered;
  return coerceScalarArtifacts(recovered, parameters) ?? recovered;
}
