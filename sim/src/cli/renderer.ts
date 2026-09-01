import {
  Event,
  EventType,
  GameState,
  Kingdom,
  MapGrid,
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
  WHITE,
  KINGDOM_COLORS,
  KINGDOM_SYMBOLS,
  colorKingdom,
  colorDelta,
  colorDeficitFlag,
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
  currentView: "dashboard" | "map" | "kingdom" | "history";
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

export function renderWorldStatePanel(
  kingdoms: Record<string, Kingdom>,
  tick: number,
): string[] {
  const lines: string[] = [];
  const aliveKingdoms = Object.values(kingdoms).filter((k) => k.alive);
  const deadKingdoms = Object.values(kingdoms).filter((k) => !k.alive);

  for (const k of aliveKingdoms) {
    const symbol = KINGDOM_SYMBOLS[k.name] ?? "\u25CF";
    const bar = drawMoraleBar(k.morale);
    const nameStr = colorKingdom(k.name.toUpperCase(), k.name);
    lines.push(
      ` ${colorKingdom(symbol, k.name)} ${nameStr}      morale ${bar}  ${k.morale.toFixed(1)}`,
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

  // Render events
  for (const e of viewState.eventBuffer) {
    const formatted = formatEvent(e);
    for (const line of formatted) {
      lines.push(line);
    }
  }

  // Diplomacy subsection at bottom
  lines.push("");
  lines.push(` ${DIM}${"─".repeat(30)}${RESET}`);
  lines.push(` ${BOLD}DIPLOMACY${RESET}`);

  const aliveNames = Object.keys(kingdoms).filter((n) => kingdoms[n].alive);
  let hasNonNeutral = false;

  for (let i = 0; i < aliveNames.length; i++) {
    for (let j = i + 1; j < aliveNames.length; j++) {
      const a = aliveNames[i];
      const b = aliveNames[j];
      const mem = kingdoms[a].diplomaticMemory[b];
      if (!mem) continue;
      if (mem.status === DiplomaticStatus.NEUTRAL) continue;

      hasNonNeutral = true;
      const aAbbr = colorKingdom(a.slice(0, 2).toUpperCase(), a);
      const bAbbr = colorKingdom(b.slice(0, 2).toUpperCase(), b);
      const statusStr = padRight(mem.status, 14);

      let detail = "";
      if (
        mem.status === DiplomaticStatus.AT_WAR ||
        mem.status === DiplomaticStatus.HOSTILE
      ) {
        detail = `${DIM}(tick ${mem.lastInteractionTick})${RESET}`;
      } else if (mem.status === DiplomaticStatus.TRADE_PARTNER) {
        detail = `${DIM}(${mem.tradeDealsCompleted} trades)${RESET}`;
      } else if (mem.status === DiplomaticStatus.ALLIED) {
        detail = `${DIM}(allied)${RESET}`;
      }

      lines.push(` ${aAbbr}\u2194${bAbbr}  ${statusStr} ${detail}`);
    }
  }

  if (!hasNonNeutral) {
    lines.push(` ${DIM}all kingdoms: NEUTRAL${RESET}`);
  }

  return lines;
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
          ` ${tickStr} ${attackerColored} attacked ${defenderColored}`,
        );
        lines.push(
          `       Captured ${targetTileId}. Lost ${Math.round(attackerLosses)} troops.`,
        );
      } else {
        lines.push(
          ` ${tickStr} ${attackerColored} attacked ${defenderColored}`,
        );
        lines.push(
          `       ${outcome === "repelled" ? "Repelled" : "Contested"} at ${targetTileId}. Lost ${Math.round(attackerLosses)} troops.`,
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

      lines.push(` ${tickStr} ${offererColored} / ${accepterColored} trade agreed`);
      if (offered && received) {
        const offeredStr = describeResources(offered);
        const receivedStr = describeResources(received);
        lines.push(`       ${offerer}: ${offeredStr} \u2192 ${accepter}: ${receivedStr}`);
      }
      break;
    }

    case EventType.TILE_EXPANDED: {
      const kingdom = e.kingdomsInvolved[0];
      const tileId = e.data.tileId as string;
      const tileType = e.data.tileType as string;
      const colored = colorKingdom(kingdom.toUpperCase(), kingdom);
      lines.push(` ${tickStr} ${colored} claims ${tileType.toLowerCase()} ${tileId}`);
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
      if (target) {
        const targetColored = colorKingdom(target.toUpperCase(), target);
        lines.push(` ${tickStr} ${sourceColored} \u2192 ${targetColored}`);
      } else {
        lines.push(` ${tickStr} ${sourceColored}`);
      }
      lines.push(`       ${DIM}"${truncate(msg, 50)}"${RESET}`);
      break;
    }

    default:
      lines.push(` ${tickStr} ${e.description}`);
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
      renderMapView(result.gameState.map, result.gameState.kingdoms);
      break;
    case "kingdom":
      renderKingdomDetail(result.gameState);
      break;
    case "history":
      renderHistoryView(result.gameState.events);
      break;
  }
}

function renderDashboard(result: TickResult): void {
  const { width } = getTerminalDimensions();

  const aliveCount = Object.values(result.gameState.kingdoms).filter(
    (k) => k.alive,
  ).length;
  const title = `GEOPOLITICAL SIM \u00B7 tick ${result.tick} \u00B7 ${aliveCount} kingdoms alive`;

  const leftLines = renderWorldStatePanel(
    result.gameState.kingdoms,
    result.tick,
  );
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
  output.push(drawColumnHeaders("WORLD STATE", "EVENTS", width));
  output.push(...mergePanels(leftLines, rightLines, width));
  output.push(drawMidDivider(width, leftWidth));

  const hints =
    viewState.mode === "step"
      ? "[space] next tick  [m] map  [k] kingdom detail  [h] history  [q] quit"
      : "[m] map  [k] kingdom detail  [h] history  [q] quit";
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

export function renderMapView(
  map: MapGrid,
  kingdoms: Record<string, Kingdom>,
): void {
  const { width } = getTerminalDimensions();
  const tick = _allEvents.length > 0 ? _allEvents[_allEvents.length - 1].tick : 0;
  const title = `MAP VIEW \u00B7 tick ${tick}`;

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
        row += colorKingdom(symbol, tile.owner) + " ";
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

  // Kingdom territory summary
  for (const [name, k] of Object.entries(kingdoms)) {
    if (!k.alive) continue;
    const symbol = KINGDOM_SYMBOLS[name] ?? "\u25CF";
    const tileCount = k.tileIds.length;
    mapLines.push(
      `   ${colorKingdom(symbol, name)} ${colorKingdom(name, name)}: ${tileCount} tiles`,
    );
  }

  mapLines.push("");
  mapLines.push(`  ${DIM}[m] return to dashboard${RESET}`);

  const output = drawBox(mapLines, width, title);
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
