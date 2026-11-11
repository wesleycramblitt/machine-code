/**
 * machine_code — slug rules shared by issues and plan items.
 *
 * Kept in its own module so issue parsing does not import the
 * writer (which imports plan-item rendering back).
 */

/** Lowercase, hyphen-separated, trimmed slug from free text.
 * Always yields a valid (non-empty) slug so symbol/punctuation-only text
 * can never produce an empty identifier that breaks run/lookup paths. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

/** True when the string is already a safe issue slug. */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 48 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug);
}
