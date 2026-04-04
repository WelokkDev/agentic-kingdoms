import {
  Action,
  ActionType,
  DiplomaticMemory,
  DiplomaticStatus,
  Event,
  EventType,
  GameState,
  Kingdom,
  Resources,
  TradeResult,
} from "../core/types.js";
import { createEvent, logDiplomacy, logTrade } from "./logger.js";

// ─── Internal Helpers ─────────────────────────────────────────────────────

function defaultDiplomaticMemory(): DiplomaticMemory {
  return {
    status: DiplomaticStatus.NEUTRAL,
    lastInteractionTick: -1,
    tradeDealsCompleted: 0,
    timesAttackedUs: 0,
    timesWeAttacked: 0,
    outstandingOffer: null,
    ticksAtWar: 0,
  };
}

/** Immutably updates fields on one kingdom's diplomatic memory entry for another. */
function updateMemory(
  kingdoms: Record<string, Kingdom>,
  kingdomName: string,
  targetName: string,
  updates: Partial<DiplomaticMemory>,
): Record<string, Kingdom> {
  const kingdom = kingdoms[kingdomName];
  const existing =
    kingdom.diplomaticMemory[targetName] ?? defaultDiplomaticMemory();
  return {
    ...kingdoms,
    [kingdomName]: {
      ...kingdom,
      diplomaticMemory: {
        ...kingdom.diplomaticMemory,
        [targetName]: { ...existing, ...updates },
      },
    },
  };
}

/** Sets diplomatic status symmetrically on both kingdoms. */
function setStatusSymmetric(
  kingdoms: Record<string, Kingdom>,
  a: string,
  b: string,
  status: DiplomaticStatus,
): Record<string, Kingdom> {
  let result = updateMemory(kingdoms, a, b, { status });
  result = updateMemory(result, b, a, { status });
  return result;
}

function hasNonZeroResource(r: Resources): boolean {
  return r.food > 0 || r.water > 0 || r.materials > 0;
}

function canAfford(stockpile: Resources, cost: Resources): boolean {
  return (
    stockpile.food >= cost.food &&
    stockpile.water >= cost.water &&
    stockpile.materials >= cost.materials
  );
}

function describeOffer(offer: Resources, request: Resources): string {
  const offerParts: string[] = [];
  const requestParts: string[] = [];
  if (offer.food > 0) offerParts.push(`${offer.food} food`);
  if (offer.water > 0) offerParts.push(`${offer.water} water`);
  if (offer.materials > 0) offerParts.push(`${offer.materials} materials`);
  if (request.food > 0) requestParts.push(`${request.food} food`);
  if (request.water > 0) requestParts.push(`${request.water} water`);
  if (request.materials > 0)
    requestParts.push(`${request.materials} materials`);
  return `offers ${offerParts.join(", ")}, requesting ${requestParts.join(", ")}`;
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Stores a trade offer in the offerer's diplomatic memory for the target. */
export function resolveTradeOffer(
  action: Action,
  gameState: GameState,
): { gameState: GameState; event: Event | null } {
  const { sourceKingdom, targetKingdom, offer, request } = action;

  if (!offer || !request || !targetKingdom) {
    return { gameState, event: null };
  }
  if (!hasNonZeroResource(offer) || !hasNonZeroResource(request)) {
    return { gameState, event: null };
  }

  const source = gameState.kingdoms[sourceKingdom];
  if (!canAfford(source.stockpile, offer)) {
    return { gameState, event: null };
  }

  const target = gameState.kingdoms[targetKingdom];
  if (!target || !target.alive) {
    return { gameState, event: null };
  }

  // Store offer on offerer's memory about target
  let kingdoms = updateMemory(
    { ...gameState.kingdoms },
    sourceKingdom,
    targetKingdom,
    { outstandingOffer: action, lastInteractionTick: gameState.tick },
  );
  kingdoms = updateMemory(kingdoms, targetKingdom, sourceKingdom, {
    lastInteractionTick: gameState.tick,
  });

  const event = logDiplomacy(
    gameState.tick,
    sourceKingdom,
    targetKingdom,
    describeOffer(offer, request),
  );

  return { gameState: { ...gameState, kingdoms }, event };
}

/**
 * Resolves a TRADE_ACCEPT action: transfers resources between offerer and
 * accepter, applying tradeEfficiency on receipt. Updates diplomatic state.
 */
export function resolveTradeAccept(
  action: Action,
  gameState: GameState,
): { gameState: GameState; event: Event | null } {
  const accepterName = action.sourceKingdom;
  const offererName = action.targetKingdom;

  if (!offererName) return { gameState, event: null };

  // Locate the outstanding offer
  const offerer = gameState.kingdoms[offererName];
  if (!offerer) return { gameState, event: null };
  const offerMem = offerer.diplomaticMemory[accepterName];
  if (!offerMem?.outstandingOffer) return { gameState, event: null };

  const offerAction = offerMem.outstandingOffer;
  const offer = offerAction.offer!;
  const request = offerAction.request!;
  const accepter = gameState.kingdoms[accepterName];

  // Validate both sides can still afford
  if (
    !canAfford(offerer.stockpile, offer) ||
    !canAfford(accepter.stockpile, request)
  ) {
    const kingdoms = updateMemory(
      { ...gameState.kingdoms },
      offererName,
      accepterName,
      { outstandingOffer: null },
    );
    const event = createEvent(
      gameState.tick,
      EventType.DIPLOMACY,
      [offererName, accepterName],
      `Trade between ${offererName} and ${accepterName} fell through — insufficient resources.`,
      {},
    );
    return { gameState: { ...gameState, kingdoms }, event };
  }

  // Capture pre-trade diplomatic state
  const currentStatus = offerMem.status;
  const newTradeCount = offerMem.tradeDealsCompleted + 1;

  // Execute trade atomically — compute final stockpiles from originals
  let kingdoms: Record<string, Kingdom> = {
    ...gameState.kingdoms,
    [offererName]: {
      ...offerer,
      stockpile: {
        food: Math.max(
          0,
          offerer.stockpile.food -
            offer.food +
            request.food * offerer.tradeEfficiency,
        ),
        water: Math.max(
          0,
          offerer.stockpile.water -
            offer.water +
            request.water * offerer.tradeEfficiency,
        ),
        materials: Math.max(
          0,
          offerer.stockpile.materials -
            offer.materials +
            request.materials * offerer.tradeEfficiency,
        ),
      },
    },
    [accepterName]: {
      ...accepter,
      stockpile: {
        food: Math.max(
          0,
          accepter.stockpile.food +
            offer.food * accepter.tradeEfficiency -
            request.food,
        ),
        water: Math.max(
          0,
          accepter.stockpile.water +
            offer.water * accepter.tradeEfficiency -
            request.water,
        ),
        materials: Math.max(
          0,
          accepter.stockpile.materials +
            offer.materials * accepter.tradeEfficiency -
            request.materials,
        ),
      },
    },
  };

  // Update diplomatic memory — clear offer, increment trade count, update tick
  kingdoms = updateMemory(kingdoms, offererName, accepterName, {
    outstandingOffer: null,
    lastInteractionTick: gameState.tick,
    tradeDealsCompleted: newTradeCount,
  });
  kingdoms = updateMemory(kingdoms, accepterName, offererName, {
    lastInteractionTick: gameState.tick,
    tradeDealsCompleted: newTradeCount,
  });

  // Diplomatic status transitions after completed trade
  if (currentStatus === DiplomaticStatus.AT_WAR) {
    kingdoms = setStatusSymmetric(
      kingdoms,
      offererName,
      accepterName,
      DiplomaticStatus.HOSTILE,
    );
    // Reset ticksAtWar symmetrically on status transition away from AT_WAR
    kingdoms = updateMemory(kingdoms, offererName, accepterName, { ticksAtWar: 0 });
    kingdoms = updateMemory(kingdoms, accepterName, offererName, { ticksAtWar: 0 });
  } else if (currentStatus === DiplomaticStatus.HOSTILE) {
    kingdoms = setStatusSymmetric(
      kingdoms,
      offererName,
      accepterName,
      DiplomaticStatus.NEUTRAL,
    );
  } else if (
    currentStatus === DiplomaticStatus.NEUTRAL &&
    newTradeCount >= 3
  ) {
    kingdoms = setStatusSymmetric(
      kingdoms,
      offererName,
      accepterName,
      DiplomaticStatus.TRADE_PARTNER,
    );
  }

  const tradeResult: TradeResult = {
    offerer: offererName,
    accepter: accepterName,
    offered: offer,
    received: request,
    tick: gameState.tick,
  };

  return {
    gameState: { ...gameState, kingdoms },
    event: logTrade(gameState.tick, tradeResult),
  };
}

/** Clears the outstanding offer and optionally downgrades diplomatic status. */
export function resolveTradeReject(
  action: Action,
  gameState: GameState,
): { gameState: GameState; event: Event | null } {
  const rejectorName = action.sourceKingdom;
  const offererName = action.targetKingdom;

  if (!offererName) return { gameState, event: null };

  const offerer = gameState.kingdoms[offererName];
  if (!offerer) return { gameState, event: null };
  const offerMem = offerer.diplomaticMemory[rejectorName];
  if (!offerMem?.outstandingOffer) return { gameState, event: null };

  const currentStatus = offerMem.status;

  // Clear offer, update interaction tick
  let kingdoms = updateMemory(
    { ...gameState.kingdoms },
    offererName,
    rejectorName,
    { outstandingOffer: null, lastInteractionTick: gameState.tick },
  );
  kingdoms = updateMemory(kingdoms, rejectorName, offererName, {
    lastInteractionTick: gameState.tick,
  });

  // TRADE_PARTNER → NEUTRAL on rejection
  if (currentStatus === DiplomaticStatus.TRADE_PARTNER) {
    kingdoms = setStatusSymmetric(
      kingdoms,
      offererName,
      rejectorName,
      DiplomaticStatus.NEUTRAL,
    );
  }

  const event = createEvent(
    gameState.tick,
    EventType.DIPLOMACY,
    [rejectorName, offererName],
    `${rejectorName} rejected ${offererName}'s trade offer.`,
    {},
  );

  return { gameState: { ...gameState, kingdoms }, event };
}

/**
 * Handles a NEGOTIATE action. No resource effect.
 * If both kingdoms send NEGOTIATE with "alliance" in the message this tick,
 * their status transitions to ALLIED.
 */
export function resolveNegotiate(
  action: Action,
  gameState: GameState,
): { gameState: GameState; event: Event | null } {
  const { sourceKingdom, targetKingdom, message } = action;

  if (!targetKingdom) return { gameState, event: null };
  const target = gameState.kingdoms[targetKingdom];
  if (!target || !target.alive) return { gameState, event: null };

  let kingdoms = updateMemory(
    { ...gameState.kingdoms },
    sourceKingdom,
    targetKingdom,
    { lastInteractionTick: gameState.tick },
  );
  kingdoms = updateMemory(kingdoms, targetKingdom, sourceKingdom, {
    lastInteractionTick: gameState.tick,
  });

  // Check for mutual alliance proposal this tick
  const sourceProposesAlliance =
    message !== null && message.toLowerCase().includes("alliance");
  const targetAction = gameState.pendingActions[targetKingdom];
  const targetProposesAlliance =
    targetAction !== undefined &&
    targetAction.actionType === ActionType.NEGOTIATE &&
    targetAction.targetKingdom === sourceKingdom &&
    targetAction.message !== null &&
    targetAction.message.toLowerCase().includes("alliance");

  if (sourceProposesAlliance && targetProposesAlliance) {
    kingdoms = setStatusSymmetric(
      kingdoms,
      sourceKingdom,
      targetKingdom,
      DiplomaticStatus.ALLIED,
    );
  }

  const event = logDiplomacy(
    gameState.tick,
    sourceKingdom,
    targetKingdom,
    message ?? "",
  );

  return { gameState: { ...gameState, kingdoms }, event };
}

/** Clears outstanding offers that are more than 2 ticks old. Called once per tick before resolution. */
export function expireOutstandingOffers(gameState: GameState): { gameState: GameState; events: Event[] } {
  let kingdoms = { ...gameState.kingdoms };
  const events: Event[] = [];

  for (const [kingdomName, kingdom] of Object.entries(gameState.kingdoms)) {
    for (const [targetName, mem] of Object.entries(
      kingdom.diplomaticMemory,
    )) {
      if (
        mem.outstandingOffer !== null &&
        mem.lastInteractionTick < gameState.tick - 2
      ) {
        kingdoms = updateMemory(kingdoms, kingdomName, targetName, {
          outstandingOffer: null,
        });
        events.push(
          logDiplomacy(
            gameState.tick,
            kingdomName,
            targetName,
            "trade offer expired — no response after 2 ticks",
          ),
        );
      }
    }
  }

  return { gameState: { ...gameState, kingdoms }, events };
}

/** Updates diplomatic status symmetrically for both kingdoms. */
export function updateDiplomaticStatus(
  kingdomA: string,
  kingdomB: string,
  newStatus: DiplomaticStatus,
  gameState: GameState,
): GameState {
  const kingdoms = setStatusSymmetric(
    { ...gameState.kingdoms },
    kingdomA,
    kingdomB,
    newStatus,
  );
  return { ...gameState, kingdoms };
}

/** Returns all outstanding trade offers directed at the given kingdom. */
export function getOutstandingOffersForKingdom(
  kingdomName: string,
  gameState: GameState,
): Array<{ offerer: string; action: Action }> {
  const result: Array<{ offerer: string; action: Action }> = [];

  for (const [otherName, otherKingdom] of Object.entries(
    gameState.kingdoms,
  )) {
    if (otherName === kingdomName) continue;
    const mem = otherKingdom.diplomaticMemory[kingdomName];
    if (mem?.outstandingOffer) {
      result.push({ offerer: otherName, action: mem.outstandingOffer });
    }
  }

  return result;
}

/**
 * Reduces food and water consumption by 30% for this tick and applies
 * a morale penalty. One-tick effect — consumption resets next tick.
 */
export function resolveRation(
  action: Action,
  gameState: GameState,
): { gameState: GameState; event: Event | null } {
  const { sourceKingdom } = action;
  const kingdom = gameState.kingdoms[sourceKingdom];

  const kingdoms: Record<string, Kingdom> = {
    ...gameState.kingdoms,
    [sourceKingdom]: {
      ...kingdom,
      consumption: {
        ...kingdom.consumption,
        food: kingdom.consumption.food * 0.7,
        water: kingdom.consumption.water * 0.7,
      },
      morale: Math.max(0.2, kingdom.morale - 0.15),
    },
  };

  const event = createEvent(
    gameState.tick,
    EventType.MORALE_CHANGE,
    [sourceKingdom],
    `${sourceKingdom} implements rationing. Consumption reduced but morale suffers.`,
    {},
  );

  return { gameState: { ...gameState, kingdoms }, event };
}

/**
 * Initializes diplomatic memory between all kingdom pairs.
 * Called once at simulation start. Does not overwrite existing entries.
 */
export function initializeDiplomaticMemory(
  kingdoms: Record<string, Kingdom>,
): Record<string, Kingdom> {
  const names = Object.keys(kingdoms);
  let result = { ...kingdoms };

  for (const name of names) {
    let memoryChanged = false;
    const updatedMemory = { ...result[name].diplomaticMemory };

    for (const otherName of names) {
      if (otherName === name) continue;
      if (!updatedMemory[otherName]) {
        updatedMemory[otherName] = defaultDiplomaticMemory();
        memoryChanged = true;
      }
    }

    if (memoryChanged) {
      result = {
        ...result,
        [name]: {
          ...result[name],
          diplomaticMemory: updatedMemory,
        },
      };
    }
  }

  return result;
}
