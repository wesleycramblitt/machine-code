/**
 * machine_code — catalogue loading.
 */
import { existsSync, readFileSync } from "node:fs";
import { CAPABILITY_AXES } from "../config.js";
import { capabilityFrom, scoresFromMetadata } from "./scoring.js";
import type { CatalogueDocument, CatalogueRow } from "./types.js";

/**
 * Recompute metadata-derived axes with the current prior so scoring fixes apply
 * to an already-generated catalogue without forcing a full refresh. Axes with
 * benchmark or curated provenance are left untouched.
 */
function refreshMetadataScores(row: CatalogueRow): void {
  const sources = row.provenance?.scoreSources;
  const estimated = row.provenance?.estimated === true;
  if (!sources && !estimated) return;
  const prior = scoresFromMetadata({
    id: row.canonicalID ?? row.id,
    name: row.name,
    family: row.family,
    releaseDate: row.releaseDate,
    knowledge: "",
    context: row.context,
    capabilities: { reasoning: row.reasoning, toolCall: row.toolCall, image: row.image },
  });
  let changed = false;
  for (const axis of CAPABILITY_AXES) {
    // An absent axis in score_sources means metadata (see snapshot.ts).
    const source = sources ? (sources[axis] ?? "metadata") : estimated ? "metadata" : undefined;
    if (source !== "metadata") continue;
    if (Math.abs(row.scores[axis] - prior[axis]) > 0.005) changed = true;
    row.scores[axis] = prior[axis];
  }
  if (changed) row.scores.capability = capabilityFrom(row.scores, row.context);
}

export function loadCatalogue(file: string): CatalogueDocument | null {
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as CatalogueDocument;
    if (!Array.isArray(doc.models)) return null;
    for (const row of doc.models) refreshMetadataScores(row);
    return doc;
  } catch {
    return null;
  }
}

export function catalogueRows(doc: CatalogueDocument): readonly CatalogueRow[] {
  return doc.models;
}
