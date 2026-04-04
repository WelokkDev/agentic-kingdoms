import {
  GameState,
  Kingdom,
  MapGrid,
  Resources,
  Event,
  Tile,
  TileType,
} from "../core/types.js";
import {
  computeProduction,
  computeConsumption,
  getDeficit,
} from "../engine/resources.js";
import { getAdjacentEnemyTiles } from "../engine/map.js";

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Rough token estimator: 1 token ~ 4 characters. */
export function estimateTokenCount(str: string): number {
  return Math.ceil(str.length / 4);
}

/**
 * Formats a Resources object as a compact string.
 * Always emits all three resources to maintain stable format structure.
 */
export function formatResources(
  r: Resources,
  prefix: "+" | "-" | "",
): string {
  const sep = prefix === "" ? ":" : prefix;
  return `food${sep}${r.food} water${sep}${r.water} materials${sep}${r.materials}`;
}

/** Compact resource formatter that omits zero values. Used for OFFERS where token efficiency matters. */
export function formatResourcesCompact(r: Resources): string {
  const parts: string[] = [];
  if (r.food !== 0) parts.push(`food:${r.food}`);
  if (r.water !== 0) parts.push(`water:${r.water}`);
  if (r.materials !== 0) parts.push(`materials:${r.materials}`);
  return parts.join(" ");
}

/** Groups tile IDs by TileType and returns a compact string like "mountain×4 forest×1". */
export function formatTileGroup(tileIds: string[], map: MapGrid): string {
  const counts: Partial<Record<TileType, number>> = {};
  for (const id of tileIds) {
    const tt = map.tiles[id].tileType;
    counts[tt] = (counts[tt] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([t, n]) => `${t.toLowerCase()}\u00d7${n}`)
    .join(" ");
}

/** Filters events from the previous tick involving this kingdom, max 3, most recent first. */
export function getEventsForKingdom(
  kingdomName: string,
  tick: number,
  events: Event[],
): Event[] {
  const previousTick = tick - 1;
  const matching = events.filter(
    (e) => e.tick === previousTick && e.kingdomsInvolved.includes(kingdomName),
  );
  // Most recent first (later in array = later in tick processing)
  return matching.slice(-3).reverse();
}

// ─── Pressure Label ─────────────────────────────────────────────────────────

export function computePressureLabel(
  kingdom: Kingdom,
): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  const deficit = getDeficit(kingdom);
  const prod = kingdom.production;
  const cons = kingdom.consumption;
  const keys: Array<keyof Resources> = ["food", "water", "materials"];

  // CRITICAL: any resource in deficit for 3+ consecutive ticks
  for (const key of keys) {
    if ((kingdom.ticksInDeficit[key] ?? 0) >= 3) return "CRITICAL";
  }

  // HIGH: any resource currently in deficit
  for (const key of keys) {
    if (deficit[key] > 0) return "HIGH";
  }

  // MEDIUM: consumption within 20% of production on any resource
  for (const key of keys) {
    if (prod[key] > 0 && cons[key] >= prod[key] * 0.8) return "MEDIUM";
  }

  return "LOW";
}

// ─── Borders ────────────────────────────────────────────────────────────────

/** Returns formatted BORDERS lines for one kingdom. */
export function getBorderLines(
  kingdomName: string,
  gameState: GameState,
): string[] {
  const adjacentTiles = getAdjacentEnemyTiles(kingdomName, gameState.map);
  const kingdom = gameState.kingdoms[kingdomName];

  // Group tiles by owner
  const byOwner: Record<string, Tile[]> = {};
  for (const tile of adjacentTiles) {
    const owner = tile.owner ?? "neutral";
    if (!byOwner[owner]) byOwner[owner] = [];
    byOwner[owner].push(tile);
  }

  const lines: string[] = [];

  // Kingdom-owned borders first (attackable tiles)
  for (const [owner, tiles] of Object.entries(byOwner)) {
    if (owner === "neutral") continue;
    const ownerKingdom = gameState.kingdoms[owner];
    if (!ownerKingdom || !ownerKingdom.alive) continue;
    const status = kingdom.diplomaticMemory[owner]?.status ?? "NEUTRAL";
    const tileList = tiles
      .map((t) => `${t.tileType.toLowerCase()} at ${t.id}`)
      .join(", ");
    lines.push(`\u2192 ${owner} [${status}]: ${tileList}`);
  }

  // Neutral tiles (expandable)
  const neutralTiles = byOwner["neutral"];
  if (neutralTiles && neutralTiles.length > 0) {
    const tileList = neutralTiles
      .map((t) => `${t.tileType.toLowerCase()} at ${t.id}`)
      .join(", ");
    lines.push(`\u2192 neutral: ${tileList}`);
  }

  return lines;
}

// ─── Reputation ─────────────────────────────────────────────────────────────

function computeReputation(
  kingdomName: string,
  gameState: GameState,
): "HIGH" | "MEDIUM" | "LOW" {
  const kingdom = gameState.kingdoms[kingdomName];
  if (!kingdom) return "MEDIUM";

  let totalTrades = 0;
  let totalAttacks = 0;
  let betrayals = 0;

  for (const mem of Object.values(kingdom.diplomaticMemory)) {
    totalTrades += mem.tradeDealsCompleted;
    totalAttacks += mem.timesWeAttacked;

    // betrayal = attacked a kingdom we had traded with 2+ times
    if (mem.timesWeAttacked > 0 && mem.tradeDealsCompleted >= 2) {
      betrayals += 1;
    }
  }

  if (betrayals >= 1) return "LOW";
  if (totalAttacks > totalTrades) return "LOW";
  if (totalTrades >= 3 && totalAttacks === 0) return "HIGH";
  return "MEDIUM";
}

// ─── Main Perception ────────────────────────────────────────────────────────

/** Produces the full perception string for one kingdom. */
export function generatePerception(
  kingdomName: string,
  gameState: GameState,
): string {
  const kingdom = gameState.kingdoms[kingdomName];
  const map = gameState.map;
  const tick = gameState.tick;

  // Compute fresh production/consumption for display
  const production = computeProduction(kingdom, map);
  const consumption = computeConsumption(kingdom);

  const lines: string[] = [];

  // ── Header ──
  lines.push(`=== ${kingdomName} | TICK ${tick} ===`);
  lines.push("");

  // ── YOUR STATE ──
  lines.push("YOUR STATE");
  lines.push(`tiles: ${formatTileGroup(kingdom.tileIds, map)}`);

  lines.push(`production:  ${formatResources(production, "+")}`);
  lines.push(`consumption: ${formatResources(consumption, "-")}`);

  lines.push(
    `stockpile:   ${formatResources(kingdom.stockpile, "")}`,
  );

  // Deficit line — only if any resource is in deficit
  const deficitParts: string[] = [];
  const keys: Array<keyof Resources> = ["food", "water", "materials"];
  for (const key of keys) {
    const ticks = kingdom.ticksInDeficit[key] ?? 0;
    if (ticks > 0) {
      deficitParts.push(`${key}(${ticks} ticks)`);
    }
  }
  if (deficitParts.length > 0) {
    lines.push(`deficit: ${deficitParts.join(" ")}`);
  }

  lines.push(
    `pop:${Math.round(kingdom.population)} army:${Math.round(kingdom.army)} morale:${kingdom.morale.toFixed(1)} effectiveness:${kingdom.armyEffectiveness.toFixed(1)}`,
  );
  lines.push("");

  // ── BORDERS ──
  const borderLines = getBorderLines(kingdomName, gameState);
  if (borderLines.length > 0) {
    lines.push("BORDERS");
    lines.push(...borderLines);
    lines.push("");
  }

  // ── KNOWN WORLD ──
  lines.push("KNOWN WORLD");
  for (const [name, k] of Object.entries(gameState.kingdoms)) {
    if (name === kingdomName || !k.alive) continue;
    const pressure = computePressureLabel(k);
    const trust = computeReputation(name, gameState);
    lines.push(
      `${name}: pop:${Math.round(k.population)} army:${Math.round(k.army)} morale:${k.morale.toFixed(1)} | ${pressure} tiles:${k.tileIds.length} | trust:${trust}`,
    );
  }
  lines.push("");

  // ── DIPLOMACY ──
  const diplomacyLines: string[] = [];
  for (const [name, mem] of Object.entries(kingdom.diplomaticMemory)) {
    const otherK = gameState.kingdoms[name];
    if (!otherK || !otherK.alive) continue;
    const last =
      mem.lastInteractionTick < 0 ? "never" : `tick${mem.lastInteractionTick}`;
    diplomacyLines.push(
      `${name}: ${mem.status} | trades:${mem.tradeDealsCompleted} attacked_us:${mem.timesAttackedUs} we_attacked:${mem.timesWeAttacked} last:${last}`,
    );
  }
  if (diplomacyLines.length > 0) {
    lines.push("DIPLOMACY");
    lines.push(...diplomacyLines);
    lines.push("");
  }

  // ── OFFERS ──
  // Offers directed at this kingdom live in the *offerer's* diplomaticMemory
  // entry for this kingdom (offerer.diplomaticMemory[kingdomName].outstandingOffer)
  const offerLines: string[] = [];
  for (const [otherName, otherK] of Object.entries(gameState.kingdoms)) {
    if (otherName === kingdomName || !otherK.alive) continue;
    const mem = otherK.diplomaticMemory[kingdomName];
    if (!mem || !mem.outstandingOffer) continue;
    const offer = mem.outstandingOffer;
    if (offer.offer && offer.request) {
      const giveStr = formatResourcesCompact(offer.offer);
      const recvStr = formatResourcesCompact(offer.request);
      offerLines.push(
        `${otherName} \u2192 you: give ${giveStr} \u2192 receive ${recvStr}`,
      );
    }
  }
  if (offerLines.length > 0) {
    lines.push("OFFERS");
    lines.push(...offerLines);
    lines.push("");
  }

  // ── EVENTS ──
  let events = getEventsForKingdom(kingdomName, tick, gameState.events);

  // Token budget enforcement: trim EVENTS first, then collapse DIPLOMACY
  let result = assemble(lines, events);
  if (estimateTokenCount(result) > 200 && events.length > 2) {
    events = events.slice(0, 2);
    result = assemble(lines, events);
  }
  if (estimateTokenCount(result) > 200 && events.length > 1) {
    events = events.slice(0, 1);
    result = assemble(lines, events);
  }
  if (estimateTokenCount(result) > 200) {
    // Collapse DIPLOMACY to status-only (remove stats after status)
    const collapsed = lines.map((line) => {
      const dipMatch = line.match(/^(.+?): (NEUTRAL|TRADE_PARTNER|ALLIED|HOSTILE|AT_WAR) \|.+$/);
      if (dipMatch) return `${dipMatch[1]}: ${dipMatch[2]}`;
      return line;
    });
    result = assemble(collapsed, events);
  }

  return result;
}

function assemble(lines: string[], events: Event[]): string {
  const all = [...lines];
  if (events.length > 0) {
    all.push("EVENTS");
    for (const e of events) {
      all.push(`\u25B6 ${e.description}`);
    }
  }
  return all.join("\n");
}

export default generatePerception;
