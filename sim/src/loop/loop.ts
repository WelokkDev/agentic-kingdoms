import {
  Action,
  ActionType,
  DiplomaticStatus,
  Event,
  EventType,
  GameState,
  Kingdom,
  Resources,
  SimConfig,
  TickResult,
} from "../core/types.js";
import { buildMapGrid } from "../engine/map.js";
import {
  computeProduction,
  computeConsumption,
  updateDeficitTracking,
} from "../engine/resources.js";
import {
  updatePopulation,
  updateMorale,
  isKingdomEliminated,
} from "../engine/population.js";
import {
  recruitTroops,
  updateArmyEffectiveness,
  applyDesertion,
  applyWarExhaustion,
} from "../engine/army.js";
import {
  resolveCombat,
  applyLogisticsCost,
  applyAttackerLosses,
  applyDefenderLosses,
  transferTile,
} from "../engine/combat.js";
import {
  resolveTradeOffer,
  resolveTradeAccept,
  resolveTradeReject,
  resolveNegotiate,
  resolveRation,
  expireOutstandingOffers,
  updateDiplomaticStatus,
  initializeDiplomaticMemory,
} from "../engine/trade.js";
import {
  logCombat,
  logKingdomEliminated,
  logTileExpanded,
  logResourceCrisis,
  formatTickSummary,
} from "../engine/logger.js";
import { generatePerception } from "../agent/perception.js";
import { callAllAgents } from "../agent/llm.js";
import type { AgentConfig } from "../agent/llm.js";
import { RECRUIT_AMOUNT } from "../engine/actions.js";

// ─── Seeded RNG ────────────────────────────────────────────────────────────

function createSeededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Local Types ───────────────────────────────────────────────────────────

interface TickContext {
  eventsThisTick: Event[];
  moraleFlags: Record<
    string,
    {
      wonCombat: boolean;
      lostCombat: boolean;
      tradeCompleted: boolean;
    }
  >;
  preResolvedActions: Set<string>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getAliveNames(gameState: GameState): string[] {
  return Object.keys(gameState.kingdoms).filter(
    (n) => gameState.kingdoms[n].alive,
  );
}

function setKingdom(gameState: GameState, name: string, kingdom: Kingdom): GameState {
  return {
    ...gameState,
    kingdoms: { ...gameState.kingdoms, [name]: kingdom },
  };
}

/**
 * Derives morale flags for a kingdom from the previous tick's events.
 * Receives only that tick's events (not the full history) so the scan is O(eventsPerTick).
 */
function deriveMoraleFlags(
  kingdomName: string,
  prevTickEvents: readonly Event[],
): { wonCombat: boolean; lostCombat: boolean; tradeCompleted: boolean } {
  let wonCombat = false;
  let lostCombat = false;
  let tradeCompleted = false;

  for (const e of prevTickEvents) {
    if (e.eventType === EventType.COMBAT) {
      const attacker = e.data.attacker as string;
      const defender = e.data.defender as string;
      const tileCaptured = e.data.tileCaptured as string | null;

      if (attacker === kingdomName) {
        if (tileCaptured) wonCombat = true;
        else lostCombat = true;
      }
      if (defender === kingdomName) {
        if (tileCaptured) lostCombat = true;
        else wonCombat = true;
      }
    }

    if (
      e.eventType === EventType.TRADE &&
      e.kingdomsInvolved.includes(kingdomName)
    ) {
      tradeCompleted = true;
    }
  }

  return { wonCombat, lostCombat, tradeCompleted };
}

// ─── Pure Functions ────────────────────────────────────────────────────────

export function checkTermination(gameState: GameState): boolean {
  const aliveCount = Object.values(gameState.kingdoms).filter(
    (k) => k.alive,
  ).length;
  return aliveCount < 2;
}

export function assembleTickResult(
  tick: number,
  gameState: GameState,
  actions: Record<string, Action>,
  eventsThisTick: Event[],
  terminated: boolean,
): TickResult {
  return {
    tick,
    gameState,
    eventsThisTick,
    actionsThisTick: actions,
    terminated,
  };
}

// ─── Initialization ────────────────────────────────────────────────────────

export function initializeGameState(config: SimConfig): GameState {
  const map = buildMapGrid();

  let kingdoms: Record<string, Kingdom> = {};

  for (const name of config.kingdomNames) {
    const tileIds = Object.values(map.tiles)
      .filter((t) => t.owner === name)
      .map((t) => t.id);

    const baseKingdom: Kingdom = {
      name,
      population: 30,
      army: 10,
      armyEffectiveness: 1.0,
      morale: 1.0,
      stockpile: { food: 20, water: 20, materials: 20 },
      production: { food: 0, water: 0, materials: 0 },
      consumption: { food: 0, water: 0, materials: 0 },
      tileIds,
      diplomaticMemory: {},
      alive: true,
      ticksInDeficit: { food: 0, water: 0, materials: 0 },
      tradeEfficiency: name === "Thessan" ? 1.2 : 1.0,
    };

    const production = computeProduction(baseKingdom, map);
    const consumption = computeConsumption(baseKingdom);
    kingdoms[name] = { ...baseKingdom, production, consumption };
  }

  kingdoms = initializeDiplomaticMemory(kingdoms);

  return {
    tick: 0,
    kingdoms,
    map,
    events: [],
    pendingActions: {},
    rngSeed: config.seed,
    config,
  };
}

// ─── Main Tick ─────────────────────────────────────────────────────────────

export async function runTick(
  gameState: GameState,
  agentConfig: AgentConfig,
  rng: () => number,
  prevTickEvents: readonly Event[] = [],
): Promise<TickResult> {
  const tick = gameState.tick;

  const ctx: TickContext = {
    eventsThisTick: [],
    moraleFlags: {},
    preResolvedActions: new Set(),
  };

  const aliveNames = getAliveNames(gameState);
  for (const name of aliveNames) {
    ctx.moraleFlags[name] = {
      wonCombat: false,
      lostCombat: false,
      tradeCompleted: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRE-TICK (step 0): Expire outstanding trade offers older than 2 ticks
  // ═══════════════════════════════════════════════════════════════════════

  const expiryResult = expireOutstandingOffers(gameState);
  gameState = expiryResult.gameState;
  ctx.eventsThisTick.push(...expiryResult.events);

  // ═══════════════════════════════════════════════════════════════════════
  // RATION PASS (step 1): Identify RATION actions from previous tick
  // ═══════════════════════════════════════════════════════════════════════

  const rationKingdoms: string[] = [];
  for (const [name, action] of Object.entries(gameState.pendingActions)) {
    if (
      action.actionType === ActionType.RATION &&
      gameState.kingdoms[name]?.alive
    ) {
      rationKingdoms.push(name);
      ctx.preResolvedActions.add(name);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RESOURCE PHASE (steps 2–5)
  // ═══════════════════════════════════════════════════════════════════════

  // Step 2: computeProduction → update kingdom.production
  for (const name of aliveNames) {
    const k = gameState.kingdoms[name];
    const production = computeProduction(k, gameState.map);
    gameState = setKingdom(gameState, name, { ...k, production });
  }

  // Step 3: computeConsumption → update kingdom.consumption
  for (const name of aliveNames) {
    const k = gameState.kingdoms[name];
    const consumption = computeConsumption(k);
    gameState = setKingdom(gameState, name, { ...k, consumption });
  }

  // Apply ration reduction to consumption (between steps 3 and 4)
  for (const name of rationKingdoms) {
    const rationAction = gameState.pendingActions[name];
    const { gameState: gs, event } = resolveRation(rationAction, gameState);
    gameState = gs;
    if (event) ctx.eventsThisTick.push(event);
  }

  // Step 4: Apply production - consumption to stockpiles
  // Step 5: updateDeficitTracking
  for (const name of aliveNames) {
    const k = gameState.kingdoms[name];
    const previousStockpile: Resources = { ...k.stockpile };

    const newStockpile: Resources = {
      food: Math.max(0, k.stockpile.food + k.production.food - k.consumption.food),
      water: Math.max(0, k.stockpile.water + k.production.water - k.consumption.water),
      materials: Math.max(
        0,
        k.stockpile.materials + k.production.materials - k.consumption.materials,
      ),
    };

    let updated: Kingdom = { ...k, stockpile: newStockpile };
    updated = updateDeficitTracking(updated, previousStockpile);

    // Log resource crises when ticksInDeficit increases to >= 3
    for (const key of ["food", "water", "materials"] as const) {
      const prev = (k.ticksInDeficit[key] as number) ?? 0;
      const curr = (updated.ticksInDeficit[key] as number) ?? 0;
      if (curr >= 3 && curr > prev) {
        ctx.eventsThisTick.push(logResourceCrisis(tick, name, key, curr));
      }
    }

    gameState = setKingdom(gameState, name, updated);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATE UPDATE PHASE (steps 6–9)
  // ═══════════════════════════════════════════════════════════════════════

  for (const name of aliveNames) {
    const prevFlags = deriveMoraleFlags(name, prevTickEvents);

    // Step 6: updatePopulation
    let k = updatePopulation(gameState.kingdoms[name]);
    // Step 7: updateMorale (flags from previous tick)
    k = updateMorale(k, prevFlags.wonCombat, prevFlags.lostCombat, prevFlags.tradeCompleted);
    // Step 8: updateArmyEffectiveness
    k = updateArmyEffectiveness(k);
    // Step 9: applyDesertion
    k = applyDesertion(k);

    gameState = setKingdom(gameState, name, k);
  }

  // Step 9.5: applyWarExhaustion — per-tick penalty for AT_WAR kingdoms
  for (const name of aliveNames) {
    gameState = setKingdom(
      gameState,
      name,
      applyWarExhaustion(gameState.kingdoms[name], gameState),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PERCEPTION + AGENT PHASE (steps 10–11)
  // generatePerception is called inside callAllAgents
  // ═══════════════════════════════════════════════════════════════════════

  const actions = await callAllAgents(gameState, agentConfig);

  // Store actions as pendingActions so resolveNegotiate can check mutual proposals
  gameState = { ...gameState, pendingActions: actions };

  // ═══════════════════════════════════════════════════════════════════════
  // ACTION RESOLUTION PHASE (steps 12–17)
  // ═══════════════════════════════════════════════════════════════════════

  // Step 12: EXPAND actions — neutral tile claims
  for (const [name, action] of Object.entries(actions)) {
    if (action.actionType !== ActionType.EXPAND) continue;
    const tileId = action.targetTileId!;
    const tile = gameState.map.tiles[tileId];
    if (!tile || tile.owner !== null) continue;

    const { map, kingdoms } = transferTile(tileId, name, gameState.map, gameState.kingdoms);
    gameState = { ...gameState, map, kingdoms };
    ctx.eventsThisTick.push(logTileExpanded(tick, name, tileId, tile.tileType));
  }

  // Step 13: TRADE_OFFER actions
  for (const action of Object.values(actions)) {
    if (action.actionType !== ActionType.TRADE_OFFER) continue;
    const { gameState: gs, event } = resolveTradeOffer(action, gameState);
    gameState = gs;
    if (event) ctx.eventsThisTick.push(event);
  }

  // Step 14: TRADE_ACCEPT / TRADE_REJECT actions
  for (const action of Object.values(actions)) {
    if (action.actionType === ActionType.TRADE_ACCEPT) {
      const { gameState: gs, event } = resolveTradeAccept(action, gameState);
      gameState = gs;
      if (event) {
        ctx.eventsThisTick.push(event);
        if (event.eventType === EventType.TRADE) {
          for (const involved of event.kingdomsInvolved) {
            if (ctx.moraleFlags[involved]) {
              ctx.moraleFlags[involved].tradeCompleted = true;
            }
          }
        }
      }
    } else if (action.actionType === ActionType.TRADE_REJECT) {
      const { gameState: gs, event } = resolveTradeReject(action, gameState);
      gameState = gs;
      if (event) ctx.eventsThisTick.push(event);
    }
  }

  // Step 15: RECRUIT actions
  for (const [name, action] of Object.entries(actions)) {
    if (action.actionType !== ActionType.RECRUIT) continue;
    const updated = recruitTroops(gameState.kingdoms[name], RECRUIT_AMOUNT);
    gameState = setKingdom(gameState, name, updated);
  }

  // Step 16: NEGOTIATE actions
  for (const action of Object.values(actions)) {
    if (action.actionType !== ActionType.NEGOTIATE) continue;
    const { gameState: gs, event } = resolveNegotiate(action, gameState);
    gameState = gs;
    if (event) ctx.eventsThisTick.push(event);
  }

  // Step 17: ATTACK actions — resolved last
  for (const action of Object.values(actions)) {
    if (action.actionType !== ActionType.ATTACK) continue;

    const attackerName = action.sourceKingdom;
    const defenderName = action.targetKingdom!;
    const targetTileId = action.targetTileId!;
    const targetTile = gameState.map.tiles[targetTileId];

    // Apply logistics cost
    let attacker = applyLogisticsCost(gameState.kingdoms[attackerName]);
    const defender = gameState.kingdoms[defenderName];

    // Resolve combat
    const combatResult = resolveCombat(attacker, defender, targetTile, rng);

    // Apply losses
    attacker = applyAttackerLosses(attacker, combatResult);
    const updatedDefender = applyDefenderLosses(defender, combatResult);

    gameState = {
      ...gameState,
      kingdoms: {
        ...gameState.kingdoms,
        [attackerName]: attacker,
        [defenderName]: updatedDefender,
      },
    };

    // Transfer tile if captured
    if (combatResult.tileCaptured) {
      const { map, kingdoms } = transferTile(
        combatResult.tileCaptured,
        attackerName,
        gameState.map,
        gameState.kingdoms,
      );
      gameState = { ...gameState, map, kingdoms };
    }

    // Log combat event
    ctx.eventsThisTick.push(logCombat(tick, combatResult, targetTileId, targetTile.tileType));

    // Track morale flags for next tick
    if (combatResult.tileCaptured) {
      if (ctx.moraleFlags[attackerName]) ctx.moraleFlags[attackerName].wonCombat = true;
      if (ctx.moraleFlags[defenderName]) ctx.moraleFlags[defenderName].lostCombat = true;
    } else {
      if (ctx.moraleFlags[attackerName]) ctx.moraleFlags[attackerName].lostCombat = true;
      if (ctx.moraleFlags[defenderName]) ctx.moraleFlags[defenderName].wonCombat = true;
    }

    // Update diplomatic memory: AT_WAR + counters + lastInteractionTick
    gameState = updateDiplomaticStatus(
      attackerName,
      defenderName,
      DiplomaticStatus.AT_WAR,
      gameState,
    );

    const defMem = gameState.kingdoms[defenderName].diplomaticMemory[attackerName];
    const atkMem = gameState.kingdoms[attackerName].diplomaticMemory[defenderName];

    gameState = {
      ...gameState,
      kingdoms: {
        ...gameState.kingdoms,
        [defenderName]: {
          ...gameState.kingdoms[defenderName],
          diplomaticMemory: {
            ...gameState.kingdoms[defenderName].diplomaticMemory,
            [attackerName]: {
              ...defMem,
              timesAttackedUs: defMem.timesAttackedUs + 1,
              lastInteractionTick: tick,
            },
          },
        },
        [attackerName]: {
          ...gameState.kingdoms[attackerName],
          diplomaticMemory: {
            ...gameState.kingdoms[attackerName].diplomaticMemory,
            [defenderName]: {
              ...atkMem,
              timesWeAttacked: atkMem.timesWeAttacked + 1,
              lastInteractionTick: tick,
            },
          },
        },
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POST-ACTION PHASE (steps 18–20)
  // ═══════════════════════════════════════════════════════════════════════

  // Step 18: AT_WAR → HOSTILE transition after 3 ticks with no attack
  const postAlive = getAliveNames(gameState);
  for (let i = 0; i < postAlive.length; i++) {
    for (let j = i + 1; j < postAlive.length; j++) {
      const a = postAlive[i];
      const b = postAlive[j];
      const mem = gameState.kingdoms[a].diplomaticMemory[b];
      if (
        mem &&
        mem.status === DiplomaticStatus.AT_WAR &&
        tick - mem.lastInteractionTick > 3
      ) {
        gameState = updateDiplomaticStatus(a, b, DiplomaticStatus.HOSTILE, gameState);
        // Reset ticksAtWar symmetrically on status transition away from AT_WAR
        gameState = {
          ...gameState,
          kingdoms: {
            ...gameState.kingdoms,
            [a]: {
              ...gameState.kingdoms[a],
              diplomaticMemory: {
                ...gameState.kingdoms[a].diplomaticMemory,
                [b]: { ...gameState.kingdoms[a].diplomaticMemory[b], ticksAtWar: 0 },
              },
            },
            [b]: {
              ...gameState.kingdoms[b],
              diplomaticMemory: {
                ...gameState.kingdoms[b].diplomaticMemory,
                [a]: { ...gameState.kingdoms[b].diplomaticMemory[a], ticksAtWar: 0 },
              },
            },
          },
        };
      }
    }
  }

  // Step 19: Check kingdom elimination
  for (const name of postAlive) {
    const k = gameState.kingdoms[name];
    if (!isKingdomEliminated(k)) continue;

    // Transfer tiles to neutral
    let updatedTiles = { ...gameState.map.tiles };
    for (const tileId of k.tileIds) {
      updatedTiles[tileId] = { ...updatedTiles[tileId], owner: null };
    }

    gameState = {
      ...gameState,
      map: { ...gameState.map, tiles: updatedTiles },
      kingdoms: {
        ...gameState.kingdoms,
        [name]: { ...k, alive: false, tileIds: [] },
      },
    };

    ctx.eventsThisTick.push(logKingdomEliminated(tick, name));

    // Reset ticksAtWar and status for all pairs involving the eliminated kingdom
    let updatedKingdoms = { ...gameState.kingdoms };
    for (const otherName of Object.keys(updatedKingdoms)) {
      if (otherName === name) continue;
      if (!updatedKingdoms[otherName].alive) continue;

      // Reset on eliminated kingdom's side
      updatedKingdoms = {
        ...updatedKingdoms,
        [name]: {
          ...updatedKingdoms[name],
          diplomaticMemory: {
            ...updatedKingdoms[name].diplomaticMemory,
            [otherName]: {
              ...updatedKingdoms[name].diplomaticMemory[otherName],
              ticksAtWar: 0,
              status: DiplomaticStatus.NEUTRAL,
            },
          },
        },
      };

      // Reset on surviving kingdom's side
      updatedKingdoms = {
        ...updatedKingdoms,
        [otherName]: {
          ...updatedKingdoms[otherName],
          diplomaticMemory: {
            ...updatedKingdoms[otherName].diplomaticMemory,
            [name]: {
              ...updatedKingdoms[otherName].diplomaticMemory[name],
              ticksAtWar: 0,
              status: DiplomaticStatus.NEUTRAL,
            },
          },
        },
      };
    }
    gameState = { ...gameState, kingdoms: updatedKingdoms };
  }

  // Step 20: Update production/consumption caches after tile transfers
  const stillAlive = getAliveNames(gameState);
  for (const name of stillAlive) {
    const k = gameState.kingdoms[name];
    const production = computeProduction(k, gameState.map);
    const consumption = computeConsumption(k);
    gameState = setKingdom(gameState, name, { ...k, production, consumption });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OUTPUT PHASE (steps 21–22)
  // ═══════════════════════════════════════════════════════════════════════

  // Append this tick's events to the full event log.
  // Mutate-in-place via push: O(1) amortized, avoids O(totalEvents) copy per tick.
  // Safe here because this is the final phase boundary — no engine function reads
  // events after this point, and no reference equality checks exist on the array.
  for (const e of ctx.eventsThisTick) {
    gameState.events.push(e);
  }

  const terminated = checkTermination(gameState);

  return assembleTickResult(tick, gameState, actions, ctx.eventsThisTick, terminated);
}

// ─── Top-Level Runner ──────────────────────────────────────────────────────

/** Callback invoked after each tick with the full TickResult. */
export type RenderCallback = (result: TickResult) => Promise<void>;

/** Returns true when the simulation should stop early (e.g. user pressed quit). */
export type QuitCheck = () => boolean;

export async function runSimulation(
  simConfig: SimConfig,
  agentConfig: AgentConfig,
  onTick?: RenderCallback,
  shouldQuit?: QuitCheck,
): Promise<void> {
  let gameState = initializeGameState(simConfig);
  const rng = createSeededRng(simConfig.seed);
  let prevTickEvents: Event[] = [];

  for (let tick = 1; tick <= simConfig.maxTicks; tick++) {
    if (shouldQuit?.()) break;

    gameState = { ...gameState, tick };
    const result = await runTick(gameState, agentConfig, rng, prevTickEvents);
    gameState = result.gameState;
    prevTickEvents = result.eventsThisTick;

    if (onTick) {
      await onTick(result);
    } else {
      console.log(formatTickSummary(tick, gameState.kingdoms, result.eventsThisTick));
    }

    if (result.terminated) break;
  }
}
