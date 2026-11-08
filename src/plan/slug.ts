/**
 * machine_code — slug rules shared by packets and plan items.
 *
 * Kept in its own module so plan-item parsing does not import the packet
 * writer (which imports plan-item rendering back).
 */

/** Lowercase, hyphen-separated, trimmed slug from free text. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** True when the string is already a safe packet slug. */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 48 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug);
}
