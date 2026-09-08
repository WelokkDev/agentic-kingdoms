import { stripAnsi, BOLD, RESET, DIM } from "./colors.js";

// ─── Terminal Dimensions ──────────────────────────────────────────────────

export function getTerminalDimensions(): { width: number; height: number } {
  return {
    width: process.stdout.columns || 100,
    height: process.stdout.rows || 40,
  };
}

// ─── Panel Widths ─────────────────────────────────────────────────────────

const MIN_LEFT_WIDTH = 36;

export function getPanelWidths(
  terminalWidth: number,
): { left: number; right: number } {
  // 2 chars for outer borders, 1 for middle divider
  const inner = terminalWidth - 3;
  let left = Math.max(MIN_LEFT_WIDTH, Math.floor(inner * 0.38));
  let right = inner - left;
  if (right < 20) {
    left = inner - 20;
    right = 20;
  }
  return { left, right };
}

// ─── String Utilities ─────────────────────────────────────────────────────

/** Visible length of a string ignoring ANSI escape codes. */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/** Truncates with \u2026 if over length. ANSI-safe. */
export function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  const vis = stripAnsi(str);
  if (vis.length <= maxLen) return str;

  // Walk through the original string, tracking visible char count
  let visCount = 0;
  let i = 0;
  while (i < str.length && visCount < maxLen - 1) {
    if (str[i] === "\x1b") {
      // Skip entire escape sequence
      const end = str.indexOf("m", i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    visCount++;
    i++;
  }
  // Collect any trailing escape sequences at position i
  let tail = "";
  while (i < str.length && str[i] === "\x1b") {
    const end = str.indexOf("m", i);
    if (end === -1) break;
    tail += str.slice(i, end + 1);
    i = end + 1;
  }
  return str.slice(0, i - (i - str.length === 0 ? 0 : 0)) + tail + "\u2026";
}

/** Right-pads to width. ANSI-safe (pads based on visible length). */
export function padRight(str: string, width: number): string {
  const vis = visibleLength(str);
  if (vis >= width) return str;
  return str + " ".repeat(width - vis);
}

/** Left-pads to width. ANSI-safe. */
export function padLeft(str: string, width: number): string {
  const vis = visibleLength(str);
  if (vis >= width) return str;
  return " ".repeat(width - vis) + str;
}

// ─── Box Drawing ──────────────────────────────────────────────────────────

/**
 * Wraps content lines in a box with Unicode box-drawing characters.
 * Returns array of lines including the border.
 */
export function drawBox(
  lines: string[],
  width: number,
  title?: string,
): string[] {
  const innerWidth = width - 2; // minus left and right border chars
  const result: string[] = [];

  // Top border
  if (title) {
    const titleStr = ` ${title} `;
    const titleLen = stripAnsi(titleStr).length;
    const remaining = Math.max(0, innerWidth - titleLen - 1); // -1: leading "─"
    result.push(
      `\u250C\u2500 ${title} ` + "\u2500".repeat(remaining) + "\u2510",
    );
  } else {
    result.push("\u250C" + "\u2500".repeat(innerWidth) + "\u2510");
  }

  // Content
  for (const line of lines) {
    const padded = padRight(line, innerWidth);
    // Truncate if content overflows
    const vis = visibleLength(padded);
    if (vis > innerWidth) {
      result.push("\u2502" + truncate(padded, innerWidth) + "\u2502");
    } else {
      result.push("\u2502" + padded + "\u2502");
    }
  }

  // Bottom border
  result.push("\u2514" + "\u2500".repeat(innerWidth) + "\u2518");

  return result;
}

// ─── Morale Bar ───────────────────────────────────────────────────────────

/**
 * Maps morale (0.2\u20131.5) to a 6-char bar of \u2588 (filled) and \u2591 (empty).
 * Returns the bare 6-char string (no color codes).
 */
export function drawMoraleBar(morale: number): string {
  const clamped = Math.max(0.2, Math.min(1.5, morale));
  // Linear map: 0.2 -> 0 blocks, 1.5 -> 6 blocks
  const filled = Math.round(((clamped - 0.2) / (1.5 - 0.2)) * 6);
  return "\u2588".repeat(filled) + "\u2591".repeat(6 - filled);
}

// ─── Merge Panels ─────────────────────────────────────────────────────────

/**
 * Merges left and right panel line arrays into a single bordered layout.
 * Handles different panel heights by padding the shorter side.
 */
export function mergePanels(
  leftLines: string[],
  rightLines: string[],
  terminalWidth: number,
): string[] {
  const { left: leftWidth, right: rightWidth } = getPanelWidths(terminalWidth);
  const maxLines = Math.max(leftLines.length, rightLines.length);
  const result: string[] = [];

  for (let i = 0; i < maxLines; i++) {
    const l = padRight(leftLines[i] ?? "", leftWidth);
    const r = padRight(rightLines[i] ?? "", rightWidth);
    result.push(`\u2502${l}\u2502${r}\u2502`);
  }

  return result;
}

/**
 * Draws the header bar for the split panel.
 */
export function drawHeader(
  title: string,
  terminalWidth: number,
): string {
  const innerWidth = terminalWidth - 2;
  const titleStr = ` ${title} `;
  const titleLen = stripAnsi(titleStr).length;
  const remaining = Math.max(0, innerWidth - titleLen - 1); // -1: leading "─"
  return `\u250C\u2500${BOLD}${titleStr}${RESET}` + "\u2500".repeat(remaining) + "\u2510";
}

/**
 * Draws the mid-divider between panels and footer.
 */
export function drawMidDivider(
  terminalWidth: number,
  leftWidth: number,
): string {
  const rightWidth = terminalWidth - 3 - leftWidth;
  return "\u251C" + "\u2500".repeat(leftWidth) + "\u2534" + "\u2500".repeat(rightWidth) + "\u2524";
}

/**
 * Draws the footer bar with keybind hints.
 */
export function drawFooter(
  hints: string,
  terminalWidth: number,
): string[] {
  const innerWidth = terminalWidth - 2;
  return [
    "\u2502" + padRight(` ${DIM}${hints}${RESET}`, innerWidth) + "\u2502",
    "\u2514" + "\u2500".repeat(innerWidth) + "\u2518",
  ];
}

/**
 * Draws the column header divider for the split panel.
 */
export function drawColumnHeaders(
  leftHeader: string,
  rightHeader: string,
  terminalWidth: number,
): string {
  const { left: leftWidth, right: rightWidth } = getPanelWidths(terminalWidth);
  const l = padRight(` ${BOLD}${leftHeader}${RESET}`, leftWidth);
  const r = padRight(` ${BOLD}${rightHeader}${RESET}`, rightWidth);
  return `\u2502${l}\u2502${r}\u2502`;
}
