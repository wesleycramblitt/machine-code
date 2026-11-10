/**
 * machine_code — app chrome: header tabs/back bar and footer command rows.
 *
 * Pure builders for the two frame chrome bands. The TUI root owns data
 * (run counts, model counts, repo paths) and the terminal contract
 * (exact-row frame assembly, painting, cursor placement); these return
 * lines. Shared by every page so navigation looks identical everywhere.
 */
import { B, C, D, G, GR, R, W, Y, background, command, fit, joinCommands, trunc, visible, wrapCommands, wrapPlain, wrapTokenList, type UiTheme } from "../format.js";

export interface PageTab {
  id: string;
  label: string;
  key: string;
}

export const TABS: PageTab[] = [
  { id: "runs", label: "Runs", key: "1" },
  { id: "models", label: "Models", key: "2" },
  { id: "spend", label: "Spend", key: "3" },
  { id: "settings", label: "Settings", key: "4" },
];

export interface HeaderProps {
  cols: number;
  theme: UiTheme;
  page: string;
  screen: string;
  toast: string;
  runIndicators: string[];
  statusTokens: string[];
  modelCount: number;
  modelFilter: string;
  newRunRepo: string;
  runsList: boolean;
}

export interface HeaderFrame {
  header: string[];
  headerTone: string;
  backHeader: boolean;
  runDetailHeader: boolean;
}

export function renderHeader(props: HeaderProps): HeaderFrame {
  const { cols, theme, page, screen, toast, runIndicators, statusTokens, modelCount, modelFilter, newRunRepo, runsList } = props;
  const tabTokens = TABS.map((tab) =>
    tab.id === page
      ? `${theme.tabActiveBg}${theme.tabActiveFg}${B} ${tab.key}:${tab.label} ${R}`
      : `${theme.headerFg}${D}${tab.key}:${tab.label}${R}`,
  );
  // Detail screens replace the whole header (tabs included) with a Back bar.
  const runDetailHeader = page === "runs" && screen === "run";
  const backHeader =
    runDetailHeader ||
    (page === "runs" && (screen === "newrun" || screen === "answer" || screen === "correct" || screen === "issue")) ||
    (page === "models" && screen === "model");
  // Tabs stay visible on every other screen. Runs and models replace the
  // blank separator with a live summary line; other pages keep the blank.
  const backTitle =
    page === "runs" && screen === "newrun"
      ? `  ${B}${theme.headerFg}New Run${R}`
      : runDetailHeader
        ? `  ${B}${theme.headerFg}Run Details${R}`
        : page === "runs" && screen === "issue"
          ? `  ${B}${theme.headerFg}Issue Details${R}`
          : page === "models" && screen === "model"
            ? `  ${B}${theme.headerFg}Model Details${R}`
            : "";
  const backLine = `${theme.backBg}${theme.backFg}${B} Back[Esc] ${R}${backTitle}`;
  const headerSubLines = runsList
    ? wrapTokenList([...runIndicators, ...statusTokens], cols, "  ").map((line) => ` ${line}`)
    : page === "models" && screen === "list"
      ? [` ${D}${modelCount} model(s)${modelFilter ? ` · “${modelFilter}”` : ""}${toast ? ` · ${Y}${toast}${R}` : ""}${R}`]
      : [""];
  const rightHeaderPath = (path: string): string => {
    const text = trunc(path, Math.max(10, cols - 2));
    return `${" ".repeat(Math.max(0, cols - visible(text) - 1))}${GR}${text}${R}`;
  };
  const backSubLine = page === "runs" && screen === "newrun" ? rightHeaderPath(newRunRepo) : "";
  const header: string[] = backHeader
    ? [backLine, backSubLine]
    : [...wrapTokenList(tabTokens, cols, " "), ...headerSubLines];
  // The header shares the body surface; only the Back label keeps its own tone.
  const headerTone = theme.bodyBg;
  return { header, headerTone, backHeader, runDetailHeader };
}

export interface FooterProps {
  cols: number;
  narrow: boolean;
  theme: UiTheme;
  screen: string;
  hideFooter: boolean;
  runDetailHeader: boolean;
  runHints: string;
  extraActions: string;
  actions: string;
  secondary: string;
  secondaryStyled: boolean;
  footerCtx: string;
  footerMapTokens: string[];
}

export interface FooterFrame {
  commandRows: string[];
  secondaryRows: string[];
  bottomLines: string[];
  defaultActions: string;
}

export function renderFooterRows(props: FooterProps): FooterFrame {
  const {
    cols, narrow, theme, screen, hideFooter, runDetailHeader,
    runHints, extraActions, actions, secondary, secondaryStyled,
    footerCtx, footerMapTokens,
  } = props;
  const defaultActions = joinCommands([
    command("1-4", "Pages", undefined, C),
    command("q", "Quit", undefined, GR),
  ]);
  const commandRows = hideFooter
    ? []
    : runDetailHeader
      ? [
          ...(runHints ? wrapCommands(runHints, cols) : []),
          ...(extraActions ? wrapCommands(extraActions, cols) : []),
        ]
      : [
          ...wrapCommands(actions || defaultActions, cols),
          ...(extraActions ? wrapCommands(extraActions, cols) : []),
        ];
  const secondaryRows = runDetailHeader
    ? []
    : secondaryStyled
      ? wrapCommands(secondary, cols).slice(0, 2)
      : wrapPlain(secondary, cols).slice(0, narrow ? 2 : 1);
  const rightFooter = footerMapTokens.join("  ");
  const mapFooterLine = (() => {
    if (!footerCtx && !rightFooter) return "";
    if (!rightFooter) return ` ${footerCtx}`;
    if (!footerCtx) return `${" ".repeat(Math.max(0, cols - visible(rightFooter)))}${rightFooter}`;
    const left = ` ${footerCtx}`;
    const gap = Math.max(1, cols - visible(left) - visible(rightFooter));
    return `${left}${" ".repeat(gap)}${rightFooter}`;
  })();
  const mapFooterSurface = runDetailHeader ? theme.sectionBg : screen === "newrun" ? theme.bodyBg : "";
  const styledMapFooterLine =
    mapFooterLine && mapFooterSurface ? background(mapFooterLine, mapFooterSurface) : mapFooterLine;
  const bottomLines = styledMapFooterLine ? [styledMapFooterLine] : [];
  return { commandRows, secondaryRows, bottomLines, defaultActions };
}

/** Right-aligned path for the header's second row (run cwd, composer repo). */
export function rightHeaderPath(cols: number, path: string): string {
  const text = trunc(path, Math.max(10, cols - 2));
  return `${" ".repeat(Math.max(0, cols - visible(text) - 1))}${GR}${text}${R}`;
}
