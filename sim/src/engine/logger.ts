import {
  Event,
  EventType,
  CombatResult,
  Resources,
  TradeResult,
  TileType,
  Kingdom,
} from "../core/types.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function describeResources(res: Resources): string {
  const parts: string[] = [];
  if (res.food > 0) parts.push(`${res.food} food`);
  if (res.water > 0) parts.push(`${res.water} water`);
  if (res.materials > 0) parts.push(`${res.materials} materials`);
  return parts.join(", ");
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Simple event factory. */
export function createEvent(
  tick: number,
  eventType: EventType,
  kingdomsInvolved: string[],
  description: string,
  data: Record<string, unknown>
): Event {
  return { tick, eventType, kingdomsInvolved, description, data };
}

/** Logs a combat event with a description based on outcome. */
export function logCombat(
  tick: number,
  result: CombatResult,
  targetTileId: string,
  tileType: TileType
): Event {
  const { attacker, defender, outcome, tileCaptured } = result;
  let description: string;

  switch (outcome) {
    case "decisive_win":
      description = `${attacker}'s forces overwhelm ${defender} at ${tileCaptured}, capturing the ${tileType}.`;
      break;
    case "marginal_win":
      description = `${attacker} pushes into ${defender}'s ${tileType} at ${tileCaptured} — a costly but decisive advance.`;
      break;
    case "contested":
      if (tileCaptured) {
        description = `${attacker} and ${defender} clash at ${targetTileId}. ${attacker} narrowly seizes the ${tileType}.`;
      } else {
        description = `${attacker} and ${defender} clash at ${targetTileId}. Neither side gains ground.`;
      }
      break;
    case "repelled":
      description = `${attacker}'s attack on ${defender} at ${targetTileId} is repelled with heavy losses.`;
      break;
  }

  return createEvent(
    tick,
    EventType.COMBAT,
    [attacker, defender],
    description,
    { ...result, targetTileId }
  );
}

/** Logs a completed trade event. */
export function logTrade(tick: number, result: TradeResult): Event {
  const offeredDesc = describeResources(result.offered);
  const receivedDesc = describeResources(result.received);

  let description: string;
  if (offeredDesc && receivedDesc) {
    description = `${result.offerer} trades ${offeredDesc} to ${result.accepter} in exchange for ${receivedDesc}.`;
  } else if (offeredDesc) {
    description = `${result.offerer} trades ${offeredDesc} to ${result.accepter}.`;
  } else {
    description = `${result.accepter} trades ${receivedDesc} to ${result.offerer}.`;
  }

  return createEvent(
    tick,
    EventType.TRADE,
    [result.offerer, result.accepter],
    description,
    { ...result }
  );
}

/** Logs a resource crisis event. */
export function logResourceCrisis(
  tick: number,
  kingdomName: string,
  resource: string,
  ticksInDeficit: number
): Event {
  const description = `${kingdomName} has suffered ${resource} shortages for ${ticksInDeficit} consecutive ticks. Population is declining.`;
  return createEvent(
    tick,
    EventType.RESOURCE_CRISIS,
    [kingdomName],
    description,
    { resource, ticksInDeficit }
  );
}

/** Logs a kingdom elimination event. */
export function logKingdomEliminated(
  tick: number,
  kingdomName: string
): Event {
  const description = `${kingdomName} has collapsed. Its lands lie unclaimed.`;
  return createEvent(
    tick,
    EventType.KINGDOM_ELIMINATED,
    [kingdomName],
    description,
    {}
  );
}

/** Logs a tile expansion event (claiming neutral tile). */
export function logTileExpanded(
  tick: number,
  kingdomName: string,
  tileId: string,
  tileType: TileType
): Event {
  const description = `${kingdomName} claims an unclaimed ${tileType} at ${tileId}.`;
  return createEvent(
    tick,
    EventType.TILE_EXPANDED,
    [kingdomName],
    description,
    { tileId, tileType }
  );
}

/** Logs a fortification event. */
export function logFortify(
  tick: number,
  kingdomName: string,
  tileId: string,
  tileType: TileType,
): Event {
  const description = `${kingdomName} reinforces its ${tileType.toLowerCase()} at ${tileId}. Border defenses strengthened.`;
  return createEvent(
    tick,
    EventType.DIPLOMACY,
    [kingdomName],
    description,
    { tileId, tileType },
  );
}

/** Logs a threat event. */
export function logThreat(
  tick: number,
  sourceKingdom: string,
  targetKingdom: string,
  demand: Resources,
  message: string | null,
): Event {
  const parts: string[] = [];
  if (demand.food > 0) parts.push(`${demand.food} food`);
  if (demand.water > 0) parts.push(`${demand.water} water`);
  if (demand.materials > 0) parts.push(`${demand.materials} materials`);
  let description = `${sourceKingdom} issues an ultimatum to ${targetKingdom}: surrender ${parts.join(", ")} or face war.`;
  if (message) description += ` "${message}"`;
  return createEvent(
    tick,
    EventType.DIPLOMACY,
    [sourceKingdom, targetKingdom],
    description,
    { demand, message },
  );
}

/** Logs an aid event. */
export function logAid(
  tick: number,
  sourceKingdom: string,
  targetKingdom: string,
  resources: Resources,
): Event {
  const parts: string[] = [];
  if (resources.food > 0) parts.push(`${resources.food} food`);
  if (resources.water > 0) parts.push(`${resources.water} water`);
  if (resources.materials > 0) parts.push(`${resources.materials} materials`);
  const description = `${sourceKingdom} sends aid to ${targetKingdom}: ${parts.join(", ")}.`;
  return createEvent(
    tick,
    EventType.TRADE,
    [sourceKingdom, targetKingdom],
    description,
    { resources, sourceKingdom, targetKingdom },
  );
}

/** Logs a diplomacy event (message from one kingdom to another). */
export function logDiplomacy(
  tick: number,
  sourceKingdom: string,
  targetKingdom: string,
  message: string
): Event {
  const description = `${sourceKingdom} to ${targetKingdom}: ${message}`;
  return createEvent(
    tick,
    EventType.DIPLOMACY,
    [sourceKingdom, targetKingdom],
    description,
    { message }
  );
}

/** Formats a terminal-friendly tick summary string. */
export function formatTickSummary(
  tick: number,
  kingdoms: Record<string, Kingdom>,
  events: Event[]
): string {
  const lineWidth = 64;
  const divider = "\u2500".repeat(lineWidth);

  // Header
  const tickLabel = ` TICK ${tick} `;
  const sidePad = Math.max(0, Math.floor((lineWidth - tickLabel.length) / 2));
  const header =
    "\u2500".repeat(sidePad) +
    tickLabel +
    "\u2500".repeat(lineWidth - sidePad - tickLabel.length);

  // Gather alive kingdoms
  const aliveKingdoms = Object.values(kingdoms).filter((k) => k.alive);

  // Compute column widths for alignment
  const maxNameLen = Math.max(...aliveKingdoms.map((k) => k.name.length));
  const rows = aliveKingdoms.map((k) => {
    const name = k.name.padEnd(maxNameLen);
    const pop = `pop:${Math.round(k.population)}`;
    const army = `army:${Math.round(k.army)}`;
    const morale = `morale:${k.morale.toFixed(1)}`;
    const food = `food:${Math.round(k.stockpile.food)}`;
    const water = `water:${Math.round(k.stockpile.water)}`;
    const materials = `materials:${Math.round(k.stockpile.materials)}`;
    return `${name}  ${pop.padEnd(8)} ${army.padEnd(8)} ${morale.padEnd(10)} | ${food.padEnd(7)} ${water.padEnd(9)} ${materials}`;
  });

  // Events
  const eventLines = events.map((e) => `\u25B6 ${e.description}`);

  const lines = [
    header,
    ...rows,
    divider,
    ...eventLines,
    divider,
  ];

  return lines.join("\n");
}
