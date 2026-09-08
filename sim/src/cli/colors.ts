// ─── ANSI Constants ───────────────────────────────────────────────────────

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const INVERSE = "\x1b[7m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const BLUE = "\x1b[34m";
export const MAGENTA = "\x1b[35m";
export const CYAN = "\x1b[36m";
export const WHITE = "\x1b[37m";

// ─── Kingdom Colors ───────────────────────────────────────────────────────

export const KINGDOM_COLORS: Record<string, string> = {
  Aldrath: YELLOW,
  Verne: GREEN,
  Durath: CYAN,
  Mira: BLUE,
  Thessan: MAGENTA,
};

export const KINGDOM_SYMBOLS: Record<string, string> = {
  Aldrath: "\u25B2",
  Verne: "\u25BC",
  Durath: "\u25CF",
  Mira: "\u25C6",
  Thessan: "\u25A0",
};

// ─── ANSI Utilities ───────────────────────────────────────────────────────

/** Strips all ANSI escape codes from a string. Used for length calculations. */
export function stripAnsi(str: string): string {
  if (typeof str !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Wraps text in the ANSI color assigned to a kingdom, then resets. */
export function colorKingdom(text: string, kingdomName: string): string {
  const color = KINGDOM_COLORS[kingdomName];
  if (!color) return text;
  return `${color}${text}${RESET}`;
}

/** Colors a numeric delta: positive green, negative red, zero dim white. */
export function colorDelta(value: number): string {
  if (value > 0) return `${GREEN}+${value}${RESET}`;
  if (value < 0) return `${RED}${value}${RESET}`;
  return `${DIM}0${RESET}`;
}

/** Colors a pressure label by severity. */
export function colorPressure(pressure: string): string {
  switch (pressure) {
    case "CRITICAL":
      return `${RED}${BOLD}${pressure}${RESET}`;
    case "HIGH":
      return `${YELLOW}${pressure}${RESET}`;
    case "MEDIUM":
      return `${WHITE}${pressure}${RESET}`;
    case "LOW":
      return `${DIM}${pressure}${RESET}`;
    default:
      return pressure;
  }
}

/** Returns !! in RED if stockpile is 0, ! in YELLOW if in deficit, empty string otherwise. */
export function colorDeficitFlag(
  stockpile: number,
  inDeficit: boolean,
): string {
  if (stockpile <= 0 && inDeficit) return `${RED}!!${RESET}`;
  if (inDeficit) return `${YELLOW}!${RESET}`;
  return "";
}
