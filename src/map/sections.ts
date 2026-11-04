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

export function sectionHeadings(text: string): SectionHeading[] {
  const found: SectionHeading[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (SECTION_LINE.test(line)) found.push({ line: i + 1, text: line });
  }
  return found;
}

/** Strip comment chrome and separator runs so a heading becomes search terms. */
export function sectionTitle(text: string): string {
  return text
    .replace(/^\/[\*\/]+/, "")
    .replace(/\*\/$/, "")
    .replace(/[-_=*]{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
