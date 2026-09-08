import {
  Action,
  ActionType,
  Event,
  EventType,
  GameState,
  Kingdom,
  MapGrid,
  Resources,
  SimConfig,
  TileType,
  DiplomaticStatus,
  TickResult,
} from "../core/types.js";
import {
  RESET,
  BOLD,
  DIM,
  RED,
  GREEN,
  YELLOW,
  CYAN,
  WHITE,
  INVERSE,
  KINGDOM_COLORS,
  KINGDOM_SYMBOLS,
  colorKingdom,
  colorDelta,
  colorDeficitFlag,
  colorPressure,
  stripAnsi,
} from "./colors.js";
import {
  getTerminalDimensions,
  getPanelWidths,
  padRight,
  padLeft,
  visibleLength,
  truncate,
  drawMoraleBar,
  mergePanels,
  drawHeader,
  drawMidDivider,
  drawFooter,
  drawColumnHeaders,
  drawBox,
} from "./layout.js";

// ─── Types ────────────────────────────────────────────────────────────────

export type RenderMode = "normal" | "step" | "fast" | "debug";

interface ViewState {
  mode: RenderMode;
  currentView: "dashboard" | "map" | "kingdom" | "history" | "diplomacy";
  kingdomDetailIndex: number;
  historyScrollOffset: number;
  eventBuffer: Event[];
  perceptions: Record<string, string>;
  agentTimings: Record<string, number>;
}

// ─── Module State ─────────────────────────────────────────────────────────

let viewState: ViewState = {
  mode: "normal",
  currentView: "dashboard",
  kingdomDetailIndex: 0,
  historyScrollOffset: 0,
  eventBuffer: [],
  perceptions: {},
  agentTimings: {},
};

export function getViewState(): ViewState {
  return viewState;
}

export function setRenderMode(mode: RenderMode): void {
  viewState.mode = mode;
}

export function setView(view: ViewState["currentView"]): void {
  viewState.currentView = view;
}

export function cycleKingdomDetail(aliveCount: number): void {
  viewState.kingdomDetailIndex =
    (viewState.kingdomDetailIndex + 1) % Math.max(1, aliveCount);
}

export function scrollHistory(delta: number): void {
  viewState.historyScrollOffset = Math.max(
    0,
    viewState.historyScrollOffset + delta,
  );
}

export function setPerceptions(perceptions: Record<string, string>): void {
  viewState.perceptions = perceptions;
}

export function setAgentTimings(timings: Record<string, number>): void {
  viewState.agentTimings = timings;
}

// ─── Tile Symbols ─────────────────────────────────────────────────────────

const TILE_CHARS: Record<TileType, string> = {
  [TileType.MOUNTAIN]: "^",
  [TileType.WETLAND]: "~",
  [TileType.RIVER]: "\u2666",
  [TileType.FOREST]: "\u2663",
  [TileType.PLAINS]: ".",
  [TileType.FARMLAND]: "#",
  [TileType.COASTAL]: "\u2248",
};

// ─── World State Panel ────────────────────────────────────────────────────

const ACTION_GLYPHS: Record<string, string> = {
  [ActionType.ATTACK]: `${RED}\u2694`,
  [ActionType.EXPAND]: `${GREEN}\u2295`,
  [ActionType.TRADE_OFFER]: `${GREEN}\u21C4`,
  [ActionType.TRADE_ACCEPT]: `${GREEN}\u21C4`,
  [ActionType.TRADE_REJECT]: `${YELLOW}\u21C4`,
  [ActionType.NEGOTIATE]: `${CYAN}\u270E`,
  [ActionType.RECRUIT]: `${CYAN}\u2699`,
  [ActionType.FORTIFY]: `${CYAN}\u2726`,
  [ActionType.THREATEN]: `${YELLOW}\u26A0`,
  [ActionType.AID]: `${GREEN}\u2665`,
  [ActionType.RATION]: `${DIM}\u25CC`,
};

function shortResources(r: Resources | null): string {
  if (!r) return "";
  const parts: string[] = [];
  if (r.food > 0) parts.push(`${r.food}f`);
  if (r.water > 0) parts.push(`${r.water}w`);
  if (r.materials > 0) parts.push(`${r.materials}m`);
  return parts.join(" ");
}

function formatActionLine(
  action: Action | undefined,
  feedback: string | undefined,
): string {
  if (feedback) {
    return `   ${DIM}\u00BB \u25CC RATION (order rejected)${RESET}`;
  }
  if (!action) return "";

  const glyph = ACTION_GLYPHS[action.actionType] ?? "";
  let detail = "";
  switch (action.actionType) {
    case ActionType.ATTACK:
      detail = `${action.targetKingdom} @ ${action.targetTileId}`;
      break;
    case ActionType.EXPAND:
    case ActionType.FORTIFY:
      detail = `${action.targetTileId}`;
      break;
    case ActionType.TRADE_OFFER:
      detail = `\u2192 ${action.targetKingdom} ${shortResources(action.offer)}\u21C4${shortResources(action.request)}`;
      break;
    case ActionType.TRADE_ACCEPT:
    case ActionType.TRADE_REJECT:
    case ActionType.NEGOTIATE:
      detail = `${action.targetKingdom ?? ""}`;
      break;
    case ActionType.THREATEN:
      detail = `${action.targetKingdom} \u2014 demands ${shortResources(action.request)}`;
      break;
    case ActionType.AID:
      detail = `\u2192 ${action.targetKingdom} ${shortResources(action.offer)}`;
      break;
    case ActionType.RECRUIT:
      detail = "+5 soldiers";
      break;
    case ActionType.RATION:
      break;
  }
  return `   ${DIM}\u00BB${RESET} ${glyph} ${action.actionType}${detail ? " " + detail : ""}${RESET}`;
}

function kingdomChips(
  k: Kingdom,
  kingdoms: Record<string, Kingdom>,
  lostTileThisTick: ReadonlySet<string>,
): string {
  const chips: string[] = [];
  const statuses = Object.entries(k.diplomaticMemory).filter(
    ([other]) => kingdoms[other]?.alive,
  );
  if (statuses.some(([, m]) => m.status === DiplomaticStatus.AT_WAR)) {
    chips.push(`${RED}${BOLD}AT_WAR${RESET}`);
  }
  if (lostTileThisTick.has(k.name)) {
    chips.push(`${RED}SIEGE${RESET}`);
  }
  if (
    chips.length === 0 &&
    statuses.some(([, m]) => m.status === DiplomaticStatus.HOSTILE)
  ) {
    chips.push(`${YELLOW}HOSTILE${RESET}`);
  }
  const tp = statuses.filter(
    ([, m]) => m.status === DiplomaticStatus.TRADE_PARTNER,
  ).length;
  if (chips.length < 2 && tp > 0) {
    chips.push(`${GREEN}TP\u00D7${tp}${RESET}`);
  }
  if (k.tileIds.length === 0) {
    chips.push(`${DIM}\u271D landless${RESET}`);
  }
  return chips.slice(0, 2).join(" ");
}

export function renderWorldStatePanel(result: TickResult): string[] {
  const kingdoms = result.gameState.kingdoms;
  const lines: string[] = [];
  const aliveKingdoms = Object.values(kingdoms).filter((k) => k.alive);
  const deadKingdoms = Object.values(kingdoms).filter((k) => !k.alive);

  // Feeds the SIEGE chip below
  const lostTileThisTick = new Set<string>();
  for (const e of result.eventsThisTick) {
    if (e.eventType === EventType.COMBAT && e.data.tileCaptured) {
      lostTileThisTick.add(e.data.defender as string);
    }
  }

  for (const k of aliveKingdoms) {
    const symbol = KINGDOM_SYMBOLS[k.name] ?? "\u25CF";
    const bar = drawMoraleBar(k.morale);
    const nameStr = colorKingdom(k.name.toUpperCase(), k.name);
    const chips = kingdomChips(k, kingdoms, lostTileThisTick);
    lines.push(
      ` ${colorKingdom(symbol, k.name)} ${nameStr}${chips ? " " + chips : ""}  ${bar} ${k.morale.toFixed(1)}`,
    );

    // Pop / army / effectiveness line
    let statLine = `   pop:${Math.round(k.population)} army:${Math.round(k.army)}`;
    if (k.armyEffectiveness < 1.0) {
      statLine += `  eff:${k.armyEffectiveness.toFixed(2)}`;
    }
    lines.push(statLine);

    // Resource lines
    for (const res of ["food", "water", "materials"] as const) {
      const resKey = res === "materials" ? "matls" : res;
      const prod = k.production[res];
      const cons = k.consumption[res];
      const delta = Math.round(prod - cons);
      const stockpile = Math.round(k.stockpile[res]);
      const ticksInDef = (k.ticksInDeficit[res] as number) ?? 0;
      const inDeficit = delta < 0;

      // Omit resource line if delta is 0, stockpile > 0, and no deficit
      if (delta === 0 && stockpile > 0 && ticksInDef === 0) continue;

      const deltaStr = colorDelta(delta);
      const flag = colorDeficitFlag(stockpile, inDeficit);
      let deficitNote = "";
      if (ticksInDef >= 2) {
        deficitNote = ` ${DIM}(${ticksInDef} ticks)${RESET}`;
      }
      lines.push(
        `   ${padRight(resKey, 6)}${padLeft(deltaStr, 10)}/tick ${flag}${deficitNote}`,
      );
    }

    const actionLine = formatActionLine(
      result.actionsThisTick[k.name],
      result.gameState.agentFeedback[k.name],
    );
    if (actionLine) lines.push(actionLine);

    lines.push(""); // blank separator
  }

  // Eliminated kingdoms
  for (const k of deadKingdoms) {
    const eliminatedTick = findEliminationTick(k.name);
    lines.push(
      ` ${DIM}\u2715 ${k.name.toUpperCase()}  collapsed tick ${eliminatedTick}${RESET}`,
    );
  }

  return lines;
}

// Track elimination ticks from events
let _allEvents: Event[] = [];

function findEliminationTick(kingdomName: string): number {
  for (const e of _allEvents) {
    if (
      e.eventType === EventType.KINGDOM_ELIMINATED &&
      e.kingdomsInvolved.includes(kingdomName)
    ) {
      return e.tick;
    }
  }
  return 0;
}

// ─── Events Panel ─────────────────────────────────────────────────────────

export function renderEventsPanel(
  events: Event[],
  kingdoms: Record<string, Kingdom>,
): string[] {
  const lines: string[] = [];

  // Add new events to buffer (newest first), keep last 20
  for (const e of events) {
    viewState.eventBuffer.unshift(e);
  }
  if (viewState.eventBuffer.length > 20) {
    viewState.eventBuffer.length = 20;
  }

  // Truncated to panel width — a long description would break the box border
  const { width: termWidth } = getTerminalDimensions();
  const { right: rightWidth } = getPanelWidths(termWidth);
  const maxLen = Math.max(24, rightWidth - 1);
  for (const e of viewState.eventBuffer) {
    const formatted = formatEvent(e);
    for (const line of formatted) {
      lines.push(truncate(line, maxLen));
    }
  }

  lines.push("");
  lines.push(` ${DIM}${"─".repeat(30)}${RESET}`);
  lines.push(` ${BOLD}PRESSURE${RESET}`);

  const aliveNames = Object.keys(kingdoms).filter((n) => kingdoms[n].alive);

  for (const name of aliveNames) {
    const k = kingdoms[name];
    const symbol = colorKingdom(KINGDOM_SYMBOLS[name] ?? "\u25cf", name);
    const label = colorPressure(pressureLabelFor(k));
    lines.push(
      ` ${symbol} ${padRight(name, 9)}${padRight(label, 10)}${DIM}${pressureReason(k)}${RESET}`,
    );
  }

  return lines;
}

/** Mirrors perception's pressure bands without importing agent code into the CLI. */
function pressureLabelFor(k: Kingdom): string {
  const keys = ["food", "water", "materials"] as const;
  for (const key of keys) {
    if (((k.ticksInDeficit[key] as number) ?? 0) >= 3) return "CRITICAL";
  }
  for (const key of keys) {
    if (k.consumption[key] - k.production[key] > 0) return "HIGH";
  }
  for (const key of keys) {
    if (k.production[key] > 0 && k.consumption[key] >= k.production[key] * 0.8)
      return "MEDIUM";
  }
  return "LOW";
}

/** One short phrase naming the kingdom's most urgent problem. */
function pressureReason(k: Kingdom): string {
  if (k.tileIds.length === 0) {
    return `landless \u00b7 pop ${Math.round(k.population)}`;
  }

  const keys = ["food", "water", "materials"] as const;
  // An empty store in active deficit outranks a short runway
  let worstEmpty: string | null = null;
  let worstEmptyTicks = -1;
  let worstRunway: string | null = null;
  let worstRunwayTicks = Infinity;

  for (const key of keys) {
    const net = k.production[key] - k.consumption[key];
    if (net >= 0) continue;
    const stock = k.stockpile[key];
    const label = key === "materials" ? "matls" : key;
    if (stock <= 0) {
      const ticks = (k.ticksInDeficit[key] as number) ?? 0;
      if (ticks > worstEmptyTicks) {
        worstEmptyTicks = ticks;
        worstEmpty = ticks > 0 ? `${label} deficit ${ticks}t` : `${label} store empty`;
      }
    } else {
      const runway = Math.ceil(stock / -net);
      if (runway < worstRunwayTicks) {
        worstRunwayTicks = runway;
        worstRunway = `${label} dry in ~${runway}t`;
      }
    }
  }

  return worstEmpty ?? worstRunway ?? "stable";
}

function formatEvent(e: Event): string[] {
  const lines: string[] = [];
  const tickStr = `${e.tick}`;

  switch (e.eventType) {
    case EventType.COMBAT: {
      const attacker = e.data.attacker as string;
      const defender = e.data.defender as string;
      const outcome = e.data.outcome as string;
      const tileCaptured = e.data.tileCaptured as string | null;
      const targetTileId = e.data.targetTileId as string;
      const attackerLosses = e.data.attackerLosses as number;

      const attackerColored = colorKingdom(attacker.toUpperCase(), attacker);
      const defenderColored = colorKingdom(defender.toUpperCase(), defender);

      if (tileCaptured) {
        lines.push(
          ` ${DIM}${tickStr}${RESET} ${RED}⚔${RESET} ${attackerColored} captured ${targetTileId} from ${defenderColored}`,
        );
        lines.push(
          `       ${DIM}${outcome} · attacker lost ${Math.round(attackerLosses)} troops${RESET}`,
        );
      } else {
        lines.push(
          ` ${DIM}${tickStr}${RESET} ${RED}⚔${RESET} ${attackerColored} attacked ${defenderColored}`,
        );
        lines.push(
          `       ${DIM}${outcome === "repelled" ? "repelled" : "contested"} at ${targetTileId} · lost ${Math.round(attackerLosses)} troops${RESET}`,
        );
      }
      break;
    }

    case EventType.TRADE: {
      const offerer = (e.data.offerer ?? e.kingdomsInvolved[0]) as string;
      const accepter = (e.data.accepter ?? e.kingdomsInvolved[1]) as string;
      const offered = e.data.offered as
        | { food: number; water: number; materials: number }
        | undefined;
      const received = e.data.received as
        | { food: number; water: number; materials: number }
        | undefined;

      const offererColored = colorKingdom(offerer.toUpperCase(), offerer);
      const accepterColored = colorKingdom(accepter.toUpperCase(), accepter);

      lines.push(
        ` ${DIM}${tickStr}${RESET} ${GREEN}\u21c4${RESET} ${offererColored} / ${accepterColored} trade agreed`,
      );
      if (offered && received) {
        const offeredStr = describeResources(offered);
        const receivedStr = describeResources(received);
        lines.push(`       ${DIM}${offeredStr} \u21c4 ${receivedStr}${RESET}`);
      }
      break;
    }

    case EventType.TILE_EXPANDED: {
      const kingdom = e.kingdomsInvolved[0];
      const tileId = e.data.tileId as string;
      const tileType = e.data.tileType as string;
      const colored = colorKingdom(kingdom.toUpperCase(), kingdom);
      lines.push(
        ` ${DIM}${tickStr}${RESET} ${GREEN}⊕${RESET} ${colored} claims ${tileType.toLowerCase()} ${tileId}`,
      );
      break;
    }

    case EventType.RESOURCE_CRISIS: {
      const kingdom = e.kingdomsInvolved[0];
      const resource = e.data.resource as string;
      const ticks = e.data.ticksInDeficit as number;
      lines.push(
        ` ${RED}\u26A0  TENSION: ${kingdom.toUpperCase()} ${resource} deficit ${ticks} ticks${RESET}`,
      );
      break;
    }

    case EventType.KINGDOM_ELIMINATED: {
      const kingdom = e.kingdomsInvolved[0];
      lines.push(
        `${RED} \u2554${"═".repeat(40)}\u2557${RESET}`,
      );
      lines.push(
        `${RED} \u2551  ${kingdom.toUpperCase()} HAS COLLAPSED  \u00B7  tick ${e.tick}${padRight("", 40 - kingdom.length - 28)}\u2551${RESET}`,
      );
      lines.push(
        `${RED} \u2551  Lands lie unclaimed.${padRight("", 19)}\u2551${RESET}`,
      );
      lines.push(
        `${RED} \u255A${"═".repeat(40)}\u255D${RESET}`,
      );
      break;
    }

    case EventType.DIPLOMACY: {
      const source = e.kingdomsInvolved[0];
      const target = e.kingdomsInvolved[1];
      const rawMsg = e.data.message;
      const msg = typeof rawMsg === "string" ? rawMsg : e.description;
      const sourceColored = source ? colorKingdom(source.toUpperCase(), source) : "";
      // \u26a0 ultimatum \u00b7 \u2709 trade offer \u00b7 \u270e message
      const glyph = e.description.includes("ultimatum")
        ? `${YELLOW}\u26a0${RESET}`
        : e.description.includes("offers")
          ? `${CYAN}\u2709${RESET}`
          : `${CYAN}\u270e${RESET}`;
      if (target) {
        const targetColored = colorKingdom(target.toUpperCase(), target);
        lines.push(` ${DIM}${tickStr}${RESET} ${glyph} ${sourceColored} \u2192 ${targetColored}`);
      } else {
        lines.push(` ${DIM}${tickStr}${RESET} ${glyph} ${sourceColored}`);
      }
      lines.push(`       ${DIM}"${truncate(msg, 50)}"${RESET}`);
      break;
    }

    case EventType.MORALE_CHANGE:
      lines.push(` ${DIM}${tickStr} \u25cc ${e.description}${RESET}`);
      break;

    default:
      lines.push(` ${DIM}${tickStr}${RESET} ${e.description}`);
      break;
  }

  return lines;
}

function describeResources(res: {
  food: number;
  water: number;
  materials: number;
}): string {
  const parts: string[] = [];
  if (res.food > 0) parts.push(`${res.food} food`);
  if (res.water > 0) parts.push(`${res.water} water`);
  if (res.materials > 0) parts.push(`${res.materials} materials`);
  return parts.join(", ");
}

// ─── Main Render ──────────────────────────────────────────────────────────

export function renderTick(result: TickResult): void {
  if (viewState.mode === "fast") return;

  _allEvents = result.gameState.events;

  switch (viewState.currentView) {
    case "dashboard":
      renderDashboard(result);
      break;
    case "map":
      renderMapView(result);
      break;
    case "kingdom":
      renderKingdomDetail(result.gameState);
      break;
    case "history":
      renderHistoryView(result.gameState.events);
      break;
    case "diplomacy":
      renderDiplomacyView(result.gameState);
      break;
  }
}

// ─── Ticker ───────────────────────────────────────────────────────────────

/** Single most consequential event of the tick, for the dashboard's top line. */
function tickerLine(result: TickResult): string | null {
  const evs = result.eventsThisTick;

  const elim = evs.find((e) => e.eventType === EventType.KINGDOM_ELIMINATED);
  if (elim) return `${RED}${BOLD}☠ ${elim.description}${RESET}`;

  const combat = evs.filter((e) => e.eventType === EventType.COMBAT);
  if (combat.length > 0) {
    const e = combat[0];
    const attacker = e.data.attacker as string;
    const defender = e.data.defender as string;
    const captured = e.data.tileCaptured as string | null;
    if (captured) {
      // gameState.events already includes this tick, so this counts the war to date
      const warTiles = result.gameState.events.filter(
        (x) =>
          x.eventType === EventType.COMBAT &&
          x.data.attacker === attacker &&
          x.data.defender === defender &&
          x.data.tileCaptured,
      ).length;
      return `${RED}${BOLD}⚔ WAR${RESET}  ${RED}${attacker} captures ${defender}'s ${captured}${RESET}  ${DIM}· tile ${warTiles} of this war${RESET}`;
    }
    return `${RED}${BOLD}⚔ WAR${RESET}  ${RED}${attacker} attacks ${defender} — ${String(e.data.outcome)}${RESET}`;
  }

  const threat = evs.find((e) => e.description.includes("ultimatum"));
  if (threat) return `${YELLOW}${BOLD}⚠${RESET} ${YELLOW}${threat.description}${RESET}`;

  const crisis = evs.find((e) => e.eventType === EventType.RESOURCE_CRISIS);
  if (crisis) return `${YELLOW}⚠ ${crisis.description}${RESET}`;

  return null;
}

function renderDashboard(result: TickResult): void {
  const { width } = getTerminalDimensions();

  const aliveCount = Object.values(result.gameState.kingdoms).filter(
    (k) => k.alive,
  ).length;
  const names = Object.keys(result.gameState.kingdoms);
  let warCount = 0;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const mem = result.gameState.kingdoms[names[i]].diplomaticMemory[names[j]];
      if (mem?.status === DiplomaticStatus.AT_WAR) warCount++;
    }
  }
  const warStr = warCount > 0 ? ` \u00B7 ${warCount} war${warCount > 1 ? "s" : ""}` : "";
  const title = `AGENTIC KINGDOMS \u00B7 tick ${result.tick} \u00B7 ${aliveCount} alive${warStr}`;

  const leftLines = renderWorldStatePanel(result);
  const rightLines = renderEventsPanel(
    result.eventsThisTick,
    result.gameState.kingdoms,
  );

  if (width < 100) {
    // Stacked layout for narrow terminals
    renderStackedLayout(title, leftLines, rightLines, width);
    return;
  }

  const { left: leftWidth } = getPanelWidths(width);

  const output: string[] = [];
  output.push(drawHeader(title, width));
  const ticker = tickerLine(result);
  if (ticker) {
    output.push("│" + padRight(" " + truncate(ticker, width - 3), width - 2) + "│");
  }
  output.push(drawColumnHeaders("WORLD STATE", "EVENTS", width));
  // An overlong left line would shift the panel divider
  const truncatedLeft = leftLines.map((l) => truncate(l, leftWidth - 1));
  output.push(...mergePanels(truncatedLeft, rightLines, width));
  output.push(drawMidDivider(width, leftWidth));

  const hints =
    viewState.mode === "step"
      ? "[space] next tick  [m] map  [d] diplomacy  [k] kingdom  [h] history  [q] quit"
      : "[m] map  [d] diplomacy  [k] kingdom  [h] history  [q] quit";
  output.push(...drawFooter(hints, width));

  // Clear screen and write
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(output.join("\n") + "\n");
}

function renderStackedLayout(
  title: string,
  leftLines: string[],
  rightLines: string[],
  width: number,
): void {
  const output: string[] = [];
  const innerWidth = width - 2;

  output.push(drawHeader(title, width));
  output.push(
    "\u2502" + padRight(` ${BOLD}WORLD STATE${RESET}`, innerWidth) + "\u2502",
  );
  for (const line of leftLines) {
    output.push("\u2502" + padRight(line, innerWidth) + "\u2502");
  }
  output.push(
    "\u251C" + "\u2500".repeat(innerWidth) + "\u2524",
  );
  output.push(
    "\u2502" + padRight(` ${BOLD}EVENTS${RESET}`, innerWidth) + "\u2502",
  );
  for (const line of rightLines) {
    output.push("\u2502" + padRight(line, innerWidth) + "\u2502");
  }
  output.push("\u2514" + "\u2500".repeat(innerWidth) + "\u2518");

  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(output.join("\n") + "\n");
}

// ─── Map View ─────────────────────────────────────────────────────────────

export function renderMapView(result: TickResult): void {
  const { width } = getTerminalDimensions();
  const map = result.gameState.map;
  const kingdoms = result.gameState.kingdoms;
  const title = `MAP VIEW \u00B7 tick ${result.tick}`;

  const capturedThisTick = new Set<string>();
  for (const e of result.eventsThisTick) {
    if (e.eventType === EventType.COMBAT && e.data.tileCaptured) {
      capturedThisTick.add(e.data.tileCaptured as string);
    }
  }

  // Active wars, oriented attacker\u2192defender by who has attacked more
  const wars: Array<{ attacker: string; defender: string }> = [];
  const names = Object.keys(kingdoms);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const aMem = kingdoms[a].diplomaticMemory[b];
      const bMem = kingdoms[b].diplomaticMemory[a];
      if (aMem?.status !== DiplomaticStatus.AT_WAR) continue;
      if ((aMem?.timesWeAttacked ?? 0) >= (bMem?.timesWeAttacked ?? 0)) {
        wars.push({ attacker: a, defender: b });
      } else {
        wars.push({ attacker: b, defender: a });
      }
    }
  }

  // Defender tiles bordering the attacker are the war front
  const atRisk = new Set<string>();
  for (const war of wars) {
    for (const tileId of kingdoms[war.defender].tileIds) {
      if (
        map.adjacency[tileId]?.some(
          (adj) => map.tiles[adj].owner === war.attacker,
        )
      ) {
        atRisk.add(tileId);
      }
    }
  }

  const mapLines: string[] = [];
  mapLines.push("");

  // Render 7x7 grid
  for (let r = 0; r < map.grid.length; r++) {
    let row = "   ";
    for (let c = 0; c < map.grid[r].length; c++) {
      const tileId = map.grid[r][c];
      const tile = map.tiles[tileId];
      const ch = TILE_CHARS[tile.tileType] ?? "?";

      if (tile.owner) {
        const symbol = KINGDOM_SYMBOLS[tile.owner] ?? ch;
        const color = KINGDOM_COLORS[tile.owner] ?? "";
        if (capturedThisTick.has(tileId)) {
          row += `${INVERSE}${RED}${symbol}${RESET} `;
        } else if (atRisk.has(tileId)) {
          row += `${color}${BOLD}${symbol}${RESET} `;
        } else {
          row += colorKingdom(symbol, tile.owner) + " ";
        }
      } else {
        row += `${DIM}${ch}${RESET} `;
      }
    }

    // Legend on right side
    if (r === 1) {
      row += `         ^ mountain   ~ wetland   \u2666 river`;
    } else if (r === 2) {
      row += `         \u2663 forest     . plains    # farmland`;
    } else if (r === 3) {
      row += `         \u2248 coastal`;
    } else if (r === 5) {
      const neutralCount = Object.values(map.tiles).filter(
        (t) => t.owner === null,
      ).length;
      row += `         Neutral tiles: ${neutralCount}`;
    }

    mapLines.push(row);
  }

  mapLines.push("");

  mapLines.push(`   ${BOLD}FORCES${RESET}`);
  const ranked = Object.values(kingdoms).sort(
    (a, b) => b.tileIds.length - a.tileIds.length,
  );
  for (const k of ranked) {
    const symbol = KINGDOM_SYMBOLS[k.name] ?? "\u25CF";
    if (!k.alive) {
      mapLines.push(`   ${DIM}${symbol} ${padRight(k.name, 9)}eliminated${RESET}`);
      continue;
    }
    if (k.tileIds.length === 0) {
      mapLines.push(
        `   ${DIM}${symbol} ${padRight(k.name, 9)} 0 tiles \u00B7 \u271D landless${RESET}`,
      );
      continue;
    }
    const bar =
      (KINGDOM_COLORS[k.name] ?? "") +
      "\u2586".repeat(Math.max(1, Math.min(10, Math.round(k.army / 2)))) +
      RESET;
    const warNote = wars.some((w) => w.attacker === k.name)
      ? `  ${RED}\u2694 attacking${RESET}`
      : wars.some((w) => w.defender === k.name)
        ? `  ${RED}under siege${RESET}`
        : "";
    mapLines.push(
      `   ${colorKingdom(symbol, k.name)} ${padRight(k.name, 9)}${padLeft(String(k.tileIds.length), 2)} tiles  army ${padLeft(String(Math.round(k.army)), 2)} ${bar}${warNote}`,
    );
  }

  mapLines.push("");
  mapLines.push(
    `   ${INVERSE}${RED} ${RESET} ${DIM}captured this tick${RESET}   ${BOLD}bold${RESET} ${DIM}= border tile at risk${RESET}`,
  );
  for (const w of wars) {
    const riskIds = [...atRisk]
      .filter((id) => map.tiles[id].owner === w.defender)
      .slice(0, 5)
      .join(", ");
    mapLines.push(
      `   ${RED}\u2694${RESET} ${DIM}WAR FRONT ${w.attacker}\u2192${w.defender}${riskIds ? " \u00B7 at risk next: " + riskIds : ""}${RESET}`,
    );
  }

  mapLines.push("");
  mapLines.push(`  ${DIM}[m] return to dashboard${RESET}`);

  const output = drawBox(mapLines, width, title);
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(output.join("\n") + "\n");
}

// ─── Diplomacy View ───────────────────────────────────────────────────────

function statusCell(mem: { status: DiplomaticStatus; tradeDealsCompleted: number } | undefined): string {
  if (!mem) return `${DIM}···${RESET}`;
  switch (mem.status) {
    case DiplomaticStatus.AT_WAR:
      return `${RED}${BOLD}WAR${RESET}`;
    case DiplomaticStatus.HOSTILE:
      return `${YELLOW}HOS${RESET}`;
    case DiplomaticStatus.ALLIED:
      return `${GREEN}${BOLD}ALL${RESET}`;
    case DiplomaticStatus.TRADE_PARTNER:
      return `${GREEN}TP${mem.tradeDealsCompleted}${RESET}`;
    default:
      return `${DIM}···${RESET}`;
  }
}

export function renderDiplomacyView(gameState: GameState): void {
  const { width } = getTerminalDimensions();
  const kingdoms = gameState.kingdoms;
  const tick = gameState.tick;
  const names = Object.keys(kingdoms);
  const lines: string[] = [];

  // ── Relationship matrix ──
  lines.push("");
  let header = padRight("", 13);
  for (const n of names) {
    header += padRight(`${colorKingdom((KINGDOM_SYMBOLS[n] ?? "●") + n.slice(0, 4), n)}`, 8);
  }
  lines.push(" " + header);
  for (const a of names) {
    const rowLabel = kingdoms[a].alive
      ? colorKingdom(`${KINGDOM_SYMBOLS[a] ?? "●"} ${a}`, a)
      : `${DIM}${KINGDOM_SYMBOLS[a] ?? "●"} ${a}${RESET}`;
    let row = padRight(rowLabel, 13);
    for (const b of names) {
      if (a === b) {
        row += padRight(`${DIM} ─ ${RESET}`, 8);
      } else {
        row += padRight(statusCell(kingdoms[a].diplomaticMemory[b]), 8);
      }
    }
    lines.push(" " + row);
  }

  const escrows: string[] = [];
  for (const offererName of names) {
    for (const [targetName, mem] of Object.entries(kingdoms[offererName].diplomaticMemory)) {
      const offer = mem.outstandingOffer;
      if (!offer || !offer.offer || !offer.request) continue;
      const remaining = Math.max(0, 3 - (tick - mem.lastInteractionTick));
      escrows.push(
        `   ${colorKingdom(KINGDOM_SYMBOLS[offererName] ?? "●", offererName)} ${padRight(offererName, 8)}→ ${padRight(targetName, 8)} ${GREEN}${shortResources(offer.offer)}${RESET} ⇄ ${shortResources(offer.request)}   ${DIM}expires in ${remaining}t${RESET}`,
      );
    }
  }
  lines.push("");
  lines.push(` ${BOLD}ESCROW${RESET} ${DIM}(${escrows.length} open — goods locked until accepted, rejected, or expired)${RESET}`);
  lines.push(...(escrows.length > 0 ? escrows : [`   ${DIM}none${RESET}`]));

  const warLines: string[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const mem = kingdoms[a].diplomaticMemory[b];
      if (mem?.status !== DiplomaticStatus.AT_WAR) continue;
      const ticksAtWar = Math.max(mem.ticksAtWar, kingdoms[b].diplomaticMemory[a]?.ticksAtWar ?? 0);
      const tilesTaken = gameState.events.filter(
        (e) =>
          e.eventType === EventType.COMBAT &&
          e.data.tileCaptured &&
          ((e.data.attacker === a && e.data.defender === b) ||
            (e.data.attacker === b && e.data.defender === a)),
      ).length;
      warLines.push(
        `   ${RED}⚔${RESET} ${colorKingdom(a, a)} ↔ ${colorKingdom(b, b)}   ${DIM}${ticksAtWar} ticks · ${tilesTaken} tiles taken · exhaustion -0.05 morale/tick${RESET}`,
      );
    }
  }
  lines.push("");
  lines.push(` ${BOLD}ACTIVE WARS${RESET}${warLines.length === 0 ? ` ${DIM}(none)${RESET}` : ""}`);
  lines.push(...warLines);

  const threatLines: string[] = [];
  for (const sourceName of names) {
    for (const [targetName, mem] of Object.entries(kingdoms[sourceName].diplomaticMemory)) {
      const threat = mem.outstandingThreat;
      if (!threat || !threat.request) continue;
      const remaining = Math.max(0, 3 - (tick - mem.lastInteractionTick));
      threatLines.push(
        `   ${YELLOW}⚠${RESET} ${colorKingdom(sourceName, sourceName)} demands ${shortResources(threat.request)} from ${colorKingdom(targetName, targetName)}   ${DIM}${remaining}t to respond${RESET}`,
      );
    }
  }
  lines.push("");
  lines.push(` ${BOLD}THREATS${RESET}${threatLines.length === 0 ? ` ${DIM}(none outstanding)${RESET}` : ""}`);
  lines.push(...threatLines);

  const trades = gameState.events.filter((e) => e.eventType === EventType.TRADE);
  const pairCounts: Record<string, number> = {};
  for (const t of trades) {
    const key = [...t.kingdomsInvolved].sort().join(" ⇄ ");
    pairCounts[key] = (pairCounts[key] ?? 0) + 1;
  }
  const topPair = Object.entries(pairCounts).sort((x, y) => y[1] - x[1])[0];
  lines.push("");
  lines.push(
    ` ${BOLD}LEDGER${RESET} ${DIM}· ${trades.length} trades completed${topPair ? ` · most active: ${topPair[0]} (${topPair[1]})` : ""}${RESET}`,
  );

  lines.push("");
  lines.push(`  ${DIM}[d] return to dashboard${RESET}`);

  const output = drawBox(lines, width, `DIPLOMACY · tick ${tick}`);
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(output.join("\n") + "\n");
}

// ─── Kingdom Detail View ──────────────────────────────────────────────────

export function renderKingdomDetail(gameState: GameState): void {
  const { width } = getTerminalDimensions();
  const aliveKingdoms = Object.values(gameState.kingdoms).filter(
    (k) => k.alive,
  );
  if (aliveKingdoms.length === 0) return;

  const idx = viewState.kingdomDetailIndex % aliveKingdoms.length;
  const k = aliveKingdoms[idx];
  const title = `KINGDOM DETAIL \u00B7 ${k.name.toUpperCase()} \u00B7 tick ${gameState.tick}`;

  const lines: string[] = [];
  lines.push("");
  lines.push(
    ` Population: ${Math.round(k.population)}      Army: ${Math.round(k.army)}      Morale: ${k.morale.toFixed(1)}      Effectiveness: ${k.armyEffectiveness.toFixed(2)}`,
  );
  lines.push("");

  // Stockpile table
  lines.push(
    ` ${BOLD}STOCKPILE          PRODUCTION       CONSUMPTION      DEFICIT TICKS${RESET}`,
  );
  for (const res of ["food", "water", "materials"] as const) {
    const stock = Math.round(k.stockpile[res]);
    const prod = Math.round(k.production[res]);
    const cons = Math.round(k.consumption[res]);
    const defTicks = (k.ticksInDeficit[res] as number) ?? 0;
    const flag = defTicks >= 2 ? (stock <= 0 ? ` ${RED}!!${RESET}` : ` ${RED}!${RESET}`) : "";

    const defStr = defTicks > 0 ? `${defTicks} ticks${flag}` : `\u2014`;
    lines.push(
      ` ${padRight(res + ":", 11)}${padLeft(String(stock), 5)}        ${padRight("+" + prod + "/tick", 13)}  ${padRight("-" + cons + "/tick", 13)}  ${defStr}`,
    );
  }

  lines.push("");

  // Tiles
  const tileCounts: Record<string, number> = {};
  for (const tileId of k.tileIds) {
    const tile = gameState.map.tiles[tileId];
    if (tile) {
      const tt = tile.tileType.toLowerCase();
      tileCounts[tt] = (tileCounts[tt] ?? 0) + 1;
    }
  }
  const tileStr = Object.entries(tileCounts)
    .map(([t, c]) => `${t}\u00D7${c}`)
    .join("   ");
  lines.push(` ${BOLD}TILES (${k.tileIds.length})${RESET}`);
  lines.push(` ${tileStr}`);
  lines.push("");

  // Borders
  lines.push(` ${BOLD}BORDERS${RESET}`);
  const adjacentTiles = new Map<string, string[]>();
  for (const tileId of k.tileIds) {
    const neighbors = gameState.map.adjacency[tileId] ?? [];
    for (const nId of neighbors) {
      const nTile = gameState.map.tiles[nId];
      if (nTile && nTile.owner !== k.name) {
        const owner = nTile.owner ?? "neutral";
        if (!adjacentTiles.has(owner)) adjacentTiles.set(owner, []);
        const arr = adjacentTiles.get(owner)!;
        if (!arr.includes(nId)) arr.push(nId);
      }
    }
  }
  for (const [owner, tiles] of adjacentTiles) {
    const tileList = tiles.slice(0, 4).join(", ");
    const extra = tiles.length > 4 ? ` +${tiles.length - 4}` : "";
    if (owner === "neutral") {
      lines.push(` \u2192 ${DIM}neutral:${RESET}          ${tileList}${extra}`);
    } else {
      const status = k.diplomaticMemory[owner]?.status ?? "NEUTRAL";
      lines.push(
        ` \u2192 ${colorKingdom(owner, owner)} [${status}]:   ${tileList}${extra}`,
      );
    }
  }
  lines.push("");

  // Diplomatic Memory
  lines.push(` ${BOLD}DIPLOMATIC MEMORY${RESET}`);
  for (const [other, mem] of Object.entries(k.diplomaticMemory)) {
    const status = padRight(mem.status, 14);
    const lastTick =
      mem.lastInteractionTick > 0 ? `tick:${mem.lastInteractionTick}` : "tick:never";
    lines.push(
      ` ${colorKingdom(padRight(other + ":", 10), other)} ${status} | trades:${mem.tradeDealsCompleted}  attacked_us:${mem.timesAttackedUs}  we_attacked:${mem.timesWeAttacked}  ${lastTick}`,
    );
  }
  lines.push("");

  // Perception string (debug mode or always in detail view)
  const perception = viewState.perceptions[k.name];
  if (perception) {
    lines.push(` ${BOLD}LAST PERCEPTION STRING${RESET}`);
    lines.push(` ${DIM}${"┄".repeat(60)}${RESET}`);
    const perceptionLines = perception.split("\n");
    for (const pl of perceptionLines.slice(0, 20)) {
      lines.push(` ${DIM}${pl}${RESET}`);
    }
    if (perceptionLines.length > 20) {
      lines.push(` ${DIM}... (${perceptionLines.length - 20} more lines)${RESET}`);
    }
    lines.push(` ${DIM}${"┄".repeat(60)}${RESET}`);
    lines.push("");
  }

  // Agent timing (debug mode)
  if (viewState.mode === "debug" && viewState.agentTimings[k.name]) {
    lines.push(
      ` ${DIM}LLM response time: ${viewState.agentTimings[k.name]}ms${RESET}`,
    );
    lines.push("");
  }

  lines.push(
    ` ${DIM}[k] next kingdom  [m] map  [space] next tick  [q] quit${RESET}`,
  );

  const output = drawBox(lines, width, title);
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(output.join("\n") + "\n");
}

// ─── History View ─────────────────────────────────────────────────────────

export function renderHistoryView(events: Event[]): void {
  const { width, height } = getTerminalDimensions();
  const title = "HISTORY \u00B7 all ticks";

  // Clamp scroll offset
  const maxScroll = Math.max(0, events.length - (height - 6));
  viewState.historyScrollOffset = Math.min(
    viewState.historyScrollOffset,
    maxScroll,
  );

  const lines: string[] = [];
  lines.push(` ${DIM}[\u2191\u2193] scroll  [h] return to dashboard${RESET}`);
  lines.push("");

  // Events newest first
  const sorted = [...events].reverse();
  const start = viewState.historyScrollOffset;
  const visibleCount = Math.max(1, height - 8);
  const visible = sorted.slice(start, start + visibleCount);

  for (const e of visible) {
    const formatted = formatEventOneLine(e);
    lines.push(` ${formatted}`);
  }

  if (visible.length === 0) {
    lines.push(` ${DIM}No events yet.${RESET}`);
  }

  const output = drawBox(lines, width, title);
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(output.join("\n") + "\n");
}

function formatEventOneLine(e: Event): string {
  const tick = String(e.tick).padStart(3);

  switch (e.eventType) {
    case EventType.COMBAT: {
      const attacker = e.data.attacker as string;
      const defender = e.data.defender as string;
      const outcome = e.data.outcome as string;
      return `${tick}  ${colorKingdom(attacker, attacker)} attacked ${colorKingdom(defender, defender)} \u2014 ${outcome}`;
    }
    case EventType.TRADE: {
      const offerer = (e.data.offerer ?? e.kingdomsInvolved[0]) as string;
      const accepter = (e.data.accepter ?? e.kingdomsInvolved[1]) as string;
      return `${tick}  ${colorKingdom(offerer, offerer)} / ${colorKingdom(accepter, accepter)} trade agreed`;
    }
    case EventType.TILE_EXPANDED: {
      const kingdom = e.kingdomsInvolved[0];
      const tileId = e.data.tileId as string;
      return `${tick}  ${colorKingdom(kingdom, kingdom)} expanded to ${tileId}`;
    }
    case EventType.RESOURCE_CRISIS: {
      const kingdom = e.kingdomsInvolved[0];
      const resource = e.data.resource as string;
      return `${tick}  ${RED}${kingdom} ${resource} crisis${RESET}`;
    }
    case EventType.KINGDOM_ELIMINATED: {
      const kingdom = e.kingdomsInvolved[0];
      return `${tick}  ${RED}${BOLD}${kingdom} COLLAPSED${RESET}`;
    }
    case EventType.DIPLOMACY: {
      const src = e.kingdomsInvolved[0];
      const tgt = e.kingdomsInvolved[1];
      return `${tick}  ${colorKingdom(src, src)} \u2192 ${colorKingdom(tgt, tgt)} (negotiate)`;
    }
    default:
      return `${tick}  ${e.description}`;
  }
}

// ─── Elimination Banner ───────────────────────────────────────────────────

export async function renderElimination(
  kingdomName: string,
  tick: number,
): Promise<void> {
  if (viewState.mode === "fast") return;

  const { width } = getTerminalDimensions();
  const bannerWidth = Math.min(50, width - 4);
  const innerWidth = bannerWidth - 4;

  const nameStr = `${kingdomName.toUpperCase()} HAS COLLAPSED`;
  const tickStr = `tick ${tick}`;
  const line1 = `  ${nameStr}  \u00B7  ${tickStr}`;
  const line2 = "  Lands lie unclaimed.";

  const output: string[] = [];
  output.push("");
  output.push(`${RED}${BOLD}`);
  output.push(
    ` \u2554${"═".repeat(innerWidth + 2)}\u2557`,
  );
  output.push(
    ` \u2551${padRight(line1, innerWidth + 2)}\u2551`,
  );
  output.push(
    ` \u2551${padRight(line2, innerWidth + 2)}\u2551`,
  );
  output.push(
    ` \u255A${"═".repeat(innerWidth + 2)}\u255D`,
  );
  output.push(`${RESET}`);
  output.push("");

  process.stdout.write(output.join("\n") + "\n");

  // Pause 1500ms
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));
}

// ─── End Summary ──────────────────────────────────────────────────────────

export function renderEndSummary(
  gameState: GameState,
  simConfig: SimConfig,
): void {
  const bar = "━".repeat(70);
  const output: string[] = [];

  output.push("");
  output.push(`${BOLD}${bar}${RESET}`);
  output.push(`${BOLD}${"━".repeat(20)} SIMULATION COMPLETE ${"━".repeat(30)}${RESET}`);
  output.push(`${BOLD}${bar}${RESET}`);

  // Survivors and eliminated
  const alive = Object.values(gameState.kingdoms).filter((k) => k.alive);
  const dead = Object.values(gameState.kingdoms).filter((k) => !k.alive);

  if (alive.length > 0) {
    const survivors = alive
      .map((k) => `${colorKingdom(k.name, k.name)}  (${gameState.tick} ticks)`)
      .join(", ");
    output.push(`Survivor:    ${survivors}`);
  }

  if (dead.length > 0) {
    const eliminated = dead.map((k) => {
      const tick = findEliminationTick(k.name);
      return `${k.name} tick:${tick}`;
    });
    output.push(`Eliminated:  ${eliminated.join(" \u00B7 ")}`);
  }

  output.push("");

  // Notable events
  output.push(`${BOLD}NOTABLE EVENTS${RESET}`);
  const notableEvents = computeNotableEvents(gameState);
  for (const note of notableEvents) {
    output.push(`  \u00B7 ${note}`);
  }

  output.push("");

  // Trade summary
  output.push(`${BOLD}TRADE SUMMARY${RESET}`);
  const trades = gameState.events.filter(
    (e) => e.eventType === EventType.TRADE,
  );
  output.push(`  Total trades completed: ${trades.length}`);

  if (trades.length > 0) {
    // Most active pair
    const pairCounts: Record<string, number> = {};
    for (const t of trades) {
      const pair = t.kingdomsInvolved.sort().join(" \u2194 ");
      pairCounts[pair] = (pairCounts[pair] ?? 0) + 1;
    }
    const topPair = Object.entries(pairCounts).sort((a, b) => b[1] - a[1])[0];
    if (topPair) {
      output.push(`  Most active pair: ${topPair[0]} (${topPair[1]} trades)`);
    }

    const firstTrade = trades[0];
    output.push(`  First trade: tick ${firstTrade.tick} (${firstTrade.kingdomsInvolved.join(" \u2192 ")})`);
  }

  output.push("");

  // Military summary
  output.push(`${BOLD}MILITARY SUMMARY${RESET}`);
  const battles = gameState.events.filter(
    (e) => e.eventType === EventType.COMBAT,
  );
  output.push(`  Total battles: ${battles.length}`);

  if (battles.length > 0) {
    let decisive = 0;
    let marginal = 0;
    let contested = 0;
    let repelled = 0;
    const attackCounts: Record<string, number> = {};
    let tilesCaptured = 0;

    for (const b of battles) {
      const outcome = b.data.outcome as string;
      if (outcome === "decisive_win") decisive++;
      else if (outcome === "marginal_win") marginal++;
      else if (outcome === "contested") contested++;
      else if (outcome === "repelled") repelled++;

      const attacker = b.data.attacker as string;
      attackCounts[attacker] = (attackCounts[attacker] ?? 0) + 1;

      if (b.data.tileCaptured) tilesCaptured++;
    }

    output.push(
      `  Decisive wins: ${decisive}  Marginal wins: ${marginal}  Contested: ${contested}  Repelled: ${repelled}`,
    );

    const topAttacker = Object.entries(attackCounts).sort(
      (a, b) => b[1] - a[1],
    )[0];
    if (topAttacker) {
      output.push(
        `  Most aggressive: ${topAttacker[0]} (${topAttacker[1]} attacks)`,
      );
    }

    output.push(`  Tiles captured: ${tilesCaptured}`);
  }

  output.push("");
  output.push(
    `${DIM}Simulation log exported \u2192 sim_log_${simConfig.seed}_${Date.now()}.json${RESET}`,
  );
  output.push(`${BOLD}${bar}${RESET}`);
  output.push("");

  process.stdout.write(output.join("\n") + "\n");
}

function computeNotableEvents(gameState: GameState): string[] {
  const notes: string[] = [];

  // First trade ever
  const trades = gameState.events.filter(
    (e) => e.eventType === EventType.TRADE,
  );
  if (trades.length > 0) {
    const first = trades[0];
    notes.push(
      `First trade on tick ${first.tick}: ${first.kingdomsInvolved.join(" and ")}`,
    );
  }

  // Kingdom that collapsed from resource deficit (not military defeat)
  for (const e of gameState.events) {
    if (e.eventType !== EventType.KINGDOM_ELIMINATED) continue;
    const kName = e.kingdomsInvolved[0];
    // Check if there were resource crises shortly before
    const crises = gameState.events.filter(
      (c) =>
        c.eventType === EventType.RESOURCE_CRISIS &&
        c.kingdomsInvolved.includes(kName) &&
        c.tick <= e.tick &&
        c.tick >= e.tick - 5,
    );
    if (crises.length > 0) {
      const resource = crises[crises.length - 1].data.resource as string;
      notes.push(
        `${kName} collapsed from sustained ${resource} deficit`,
      );
    }
  }

  // Kingdom that never went to war
  for (const [name, k] of Object.entries(gameState.kingdoms)) {
    if (!k.alive) continue;
    const wasAttacker = gameState.events.some(
      (e) => e.eventType === EventType.COMBAT && e.data.attacker === name,
    );
    const wasDefender = gameState.events.some(
      (e) => e.eventType === EventType.COMBAT && e.data.defender === name,
    );
    if (!wasAttacker && !wasDefender) {
      notes.push(`${name} never went to war \u2014 survived through diplomacy`);
    }
  }

  // Diplomatic betrayal (ALLIED/TRADE_PARTNER → AT_WAR)
  const combats = gameState.events.filter(
    (e) => e.eventType === EventType.COMBAT,
  );
  for (const c of combats) {
    const attacker = c.data.attacker as string;
    const defender = c.data.defender as string;
    // Check if they had trades before this attack
    const priorTrades = trades.filter(
      (t) =>
        t.tick < c.tick &&
        t.kingdomsInvolved.includes(attacker) &&
        t.kingdomsInvolved.includes(defender),
    );
    if (priorTrades.length >= 2) {
      notes.push(
        `${attacker} attacked ${defender} on tick ${c.tick} after ${priorTrades.length} completed trades \u2014 diplomatic betrayal`,
      );
      break; // Only report first betrayal
    }
  }

  // Longest alliance/trade partnership
  const pairTicks: Record<string, number[]> = {};
  for (const t of trades) {
    const pair = t.kingdomsInvolved.sort().join("\u2194");
    if (!pairTicks[pair]) pairTicks[pair] = [];
    pairTicks[pair].push(t.tick);
  }

  let longestPair = "";
  let longestSpan = 0;
  for (const [pair, ticks] of Object.entries(pairTicks)) {
    if (ticks.length < 2) continue;
    const span = ticks[ticks.length - 1] - ticks[0];
    if (span > longestSpan) {
      longestSpan = span;
      longestPair = pair;
    }
  }
  if (longestPair && longestSpan > 0) {
    const ticks = pairTicks[longestPair];
    notes.push(
      `Longest trade relationship: ${longestPair.replace("\u2194", " \u2194 ")}, ${ticks.length} trades over ticks ${ticks[0]}\u2013${ticks[ticks.length - 1]}`,
    );
  }

  if (notes.length === 0) {
    notes.push("No notable events this simulation.");
  }

  return notes;
}

// ─── JSON Log Export ──────────────────────────────────────────────────────

export function buildSimLog(
  gameState: GameState,
  simConfig: SimConfig,
): Record<string, unknown> {
  const trades = gameState.events.filter(
    (e) => e.eventType === EventType.TRADE,
  );
  const battles = gameState.events.filter(
    (e) => e.eventType === EventType.COMBAT,
  );

  // Find diplomatic betrayals
  const betrayals: string[] = [];
  for (const c of battles) {
    const attacker = c.data.attacker as string;
    const defender = c.data.defender as string;
    const priorTrades = trades.filter(
      (t) =>
        t.tick < c.tick &&
        t.kingdomsInvolved.includes(attacker) &&
        t.kingdomsInvolved.includes(defender),
    );
    if (priorTrades.length >= 2) {
      betrayals.push(`${attacker}\u2194${defender}`);
    }
  }

  const kingdoms: Record<
    string,
    { survived: boolean; eliminatedTick: number | null; finalState: Kingdom }
  > = {};
  for (const [name, k] of Object.entries(gameState.kingdoms)) {
    kingdoms[name] = {
      survived: k.alive,
      eliminatedTick: k.alive ? null : findEliminationTick(name),
      finalState: k,
    };
  }

  return {
    seed: simConfig.seed,
    totalTicks: gameState.tick,
    config: simConfig,
    kingdoms,
    events: gameState.events,
    summary: {
      totalTrades: trades.length,
      totalBattles: battles.length,
      firstTrade: trades.length > 0 ? trades[0] : null,
      diplomaticBetrayals: betrayals,
    },
  };
}
