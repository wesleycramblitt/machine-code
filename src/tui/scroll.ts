/**
 * Scroll-window math for cursor-driven TUI lists.
 *
 * Selection is a line index, not a selectable-row index: group headings and
 * section labels occupy lines too. When the cursor moves above the current
 * viewport we keep one line of context visible above it, so the heading for the
 * first item in a group does not disappear just as the user scrolls back up.
 */
/**
 * Lowest scroll that still keeps `selectedIndex` visible in a `height` window.
 * Scroll is a line index: headings occupy lines, so a group header counts as
 * the first stop of its group.
 */
export function minScrollFor(
  lines: readonly unknown[],
  selectedIndex: number,
  height: number,
): number {
  const viewport = Math.max(1, height);
  const last = Math.max(0, lines.length - 1);
  const selected = Math.max(0, Math.min(selectedIndex, last));
  return Math.max(0, Math.min(selected, Math.max(0, lines.length - viewport)));
}

/** Free-scrolling window for sections that have no cursor row. */
export function scrollLines(
  lines: readonly string[],
  scroll: number,
  height: number,
): { lines: string[]; scroll: number } {
  const viewport = Math.max(1, height);
  const max = Math.max(0, lines.length - viewport);
  const top = Math.max(0, Math.min(scroll, max));
  return { lines: lines.slice(top, top + viewport), scroll: top };
}

export function selectableLines(
  lines: readonly string[],
  selectedIndex: number,
  scroll: number,
  height: number,
): { lines: string[]; scroll: number } {
  const viewport = Math.max(1, height);
  const last = Math.max(0, lines.length - 1);
  const selected = Math.max(0, Math.min(selectedIndex, last));

  let top = Math.max(0, Math.min(scroll, Math.max(0, lines.length - viewport)));
  if (selected < top) {
    // Reveal the selected line plus the heading/context immediately above it.
    top = Math.max(0, selected - 1);
  }
  if (selected >= top + viewport) top = selected - viewport + 1;
  top = Math.max(0, Math.min(top, Math.max(0, lines.length - viewport)));
  return { lines: lines.slice(top, top + viewport), scroll: top };
}
