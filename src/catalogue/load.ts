/**
 * machine_code — catalogue loading.
 */
import { existsSync, readFileSync } from "node:fs";
import type { CatalogueDocument, CatalogueRow } from "./types.js";

export function loadCatalogue(file: string): CatalogueDocument | null {
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as CatalogueDocument;
    if (!Array.isArray(doc.models)) return null;
    return doc;
  } catch {
    return null;
  }
}

export function catalogueRows(doc: CatalogueDocument): readonly CatalogueRow[] {
  return doc.models;
}
