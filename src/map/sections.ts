/**
 * machine_code — comment section headings inside one file.
 *
 * Large files often keep their useful blocks inside one giant function. A
 * symbol outline cannot see those blocks, but the comment banners can. This is
 * shared by `search sections` and the semantic file index.
 */
export interface SectionHeading {
  line: number;
  text: string;
}

const SECTION_LINE = /^(?:\/\*[-=*_ ]{3,}.*\*\/|\/\/\s*(?:[-=_*]{3,}.*|#?region\b.*))/i;
const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function sectionHeadings(text: string): SectionHeading[] {
  const found: SectionHeading[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (SECTION_LINE.test(line)) found.push({ line: i + 1, text: line });
  }
  return found;
}

/** Markdown headings are sections even though they are not comments. */
export function markdownHeadings(text: string): SectionHeading[] {
  const found: SectionHeading[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (MARKDOWN_HEADING.test(line)) found.push({ line: i + 1, text: line });
  }
  return found;
}

/** Sections for a path: Markdown headings for docs, comment banners otherwise. */
export function documentSections(text: string, path?: string): SectionHeading[] {
  const markdown = /\.(md|markdown|mdx)$/i.test(path ?? "");
  if (!markdown) return sectionHeadings(text);
  const found = [...sectionHeadings(text), ...markdownHeadings(text)];
  found.sort((a, b) => a.line - b.line);
  return found;
}

/** Strip comment chrome and separator runs so a heading becomes search terms. */
export function sectionTitle(text: string): string {
  return text
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\/[\*\/]+/, "")
    .replace(/\*\/$/, "")
    .replace(/[-_=*]{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
