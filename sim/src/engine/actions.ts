import {
  Action,
  ActionType,
  DiplomaticStatus,
  GameState,
  Kingdom,
  Resources,
} from "../core/types.js";
import { getAdjacentEnemyTiles, getKingdomBorderTiles, FORTIFY_COST } from "./map.js";

// ─── Constants ────────────────────────────────────────────────────────────

/** Number of soldiers recruited per RECRUIT action. */
export const RECRUIT_AMOUNT = 5;

// ─── Helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidResources(value: unknown): value is Resources {
  if (!isRecord(value)) return false;
  return (
    typeof value.food === "number" &&
    typeof value.water === "number" &&
    typeof value.materials === "number" &&
    value.food >= 0 &&
    value.water >= 0 &&
    value.materials >= 0
  );
}

const ACTION_TYPE_VALUES: ReadonlySet<string> = new Set(
  Object.values(ActionType)
);

function isValidActionType(value: unknown): value is ActionType {
  return typeof value === "string" && ACTION_TYPE_VALUES.has(value);
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Result of validating a raw LLM action: the valid Action, or a rejection reason. */
export interface ValidationResult {
  action: Action | null;
  reason: string | null;
}

function reject(reason: string): ValidationResult {
  return { action: null, reason };
}

/**
 * Validates raw unknown input (typically from an LLM) and returns a valid
 * Action if all checks pass, otherwise null.
 */
export function validateAction(
  action: unknown,
  gameState: GameState
): Action | null {
  return validateActionDetailed(action, gameState).action;
}

/**
 * Validates raw unknown input and returns either a valid Action or a
 * human-readable rejection reason (fed back into next tick's perception).
 */
export function validateActionDetailed(
  action: unknown,
  gameState: GameState
): ValidationResult {
  if (!isRecord(action)) return reject("response was not a JSON object");

  const { actionType, sourceKingdom } = action;

  // actionType must be a valid enum value
  if (!isValidActionType(actionType))
    return reject(`unknown actionType "${String(actionType)}"`);

  // sourceKingdom must exist and be alive
  if (typeof sourceKingdom !== "string") return reject("missing sourceKingdom");
  const source = gameState.kingdoms[sourceKingdom];
  if (!source || !source.alive) return reject("source kingdom not alive");

  const targetKingdom =
    typeof action.targetKingdom === "string" ? action.targetKingdom : null;
  const targetTileId =
    typeof action.targetTileId === "string" ? action.targetTileId : null;
  const offer = isValidResources(action.offer) ? action.offer : null;
  const request = isValidResources(action.request) ? action.request : null;
  const message =
    typeof action.message === "string" ? action.message : null;

  // ── Per-action-type validation ──

  if (actionType === ActionType.ATTACK) {
    if (!targetKingdom) return reject("ATTACK requires targetKingdom");
    const defender = gameState.kingdoms[targetKingdom];
    if (!defender || !defender.alive)
      return reject(`ATTACK target kingdom "${targetKingdom}" is not alive`);
    if (!targetTileId) return reject("ATTACK requires targetTileId");

    // targetTileId must be owned by defender
    const tile = gameState.map.tiles[targetTileId];
    if (!tile || tile.owner !== targetKingdom)
      return reject(
        `ATTACK target tile ${targetTileId} is not owned by ${targetKingdom}`
      );

    // targetTileId must be adjacent to attacker territory
    const adjacentEnemy = getAdjacentEnemyTiles(sourceKingdom, gameState.map);
    const isAdjacent = adjacentEnemy.some(
      (t) => t.id === targetTileId && t.owner === targetKingdom
    );
    if (!isAdjacent)
      return reject(
        `ATTACK target tile ${targetTileId} is not adjacent to your territory`
      );
  }

  if (actionType === ActionType.EXPAND) {
    if (!targetTileId) return reject("EXPAND requires targetTileId");
    const tile = gameState.map.tiles[targetTileId];
    if (!tile || tile.owner !== null)
      return reject(
        `EXPAND target ${targetTileId} is not a neutral tile` +
          (tile?.owner ? ` (owned by ${tile.owner})` : "")
      );

    // Must be adjacent to attacker territory
    const adjacentEnemy = getAdjacentEnemyTiles(sourceKingdom, gameState.map);
    const isAdjacent = adjacentEnemy.some(
      (t) => t.id === targetTileId && t.owner === null
    );
    if (!isAdjacent)
      return reject(
        `EXPAND target ${targetTileId} is not adjacent to your territory`
      );
  }

  if (actionType === ActionType.TRADE_OFFER) {
    if (!offer || !request)
      return reject(
        "TRADE_OFFER requires both offer and request — for a one-sided gift use AID"
      );
    const totalOffer = offer.food + offer.water + offer.materials;
    const totalRequest = request.food + request.water + request.materials;
    if (totalOffer + totalRequest === 0)
      return reject("TRADE_OFFER offer and request are both empty");
    // Escrow model: you can only offer what you currently hold
    if (
      source.stockpile.food < offer.food ||
      source.stockpile.water < offer.water ||
      source.stockpile.materials < offer.materials
    )
      return reject(
        "TRADE_OFFER rejected: you cannot afford the resources you offered"
      );
  }

  if (
    actionType === ActionType.TRADE_ACCEPT ||
    actionType === ActionType.TRADE_REJECT
  ) {
    if (!targetKingdom) return reject(`${actionType} requires targetKingdom`);
    // The target kingdom's diplomatic memory for source must have an outstanding offer
    const targetK = gameState.kingdoms[targetKingdom];
    if (!targetK) return reject(`no kingdom named "${targetKingdom}"`);
    const memory = targetK.diplomaticMemory[sourceKingdom];
    if (!memory || memory.outstandingOffer === null)
      return reject(`no outstanding offer from ${targetKingdom} to accept/reject`);

    // Accepting means paying the offer's request — verify affordability up front
    // so the agent gets feedback instead of a silent resolution failure.
    if (actionType === ActionType.TRADE_ACCEPT) {
      const req = memory.outstandingOffer.request;
      if (
        req &&
        (source.stockpile.food < req.food ||
          source.stockpile.water < req.water ||
          source.stockpile.materials < req.materials)
      ) {
        const needed: string[] = [];
        if (req.food > 0) needed.push(`food:${req.food}`);
        if (req.water > 0) needed.push(`water:${req.water}`);
        if (req.materials > 0) needed.push(`materials:${req.materials}`);
        return reject(
          `TRADE_ACCEPT rejected: accepting requires paying ${needed.join(" ")} — you cannot afford it`
        );
      }
    }
  }

  if (actionType === ActionType.RECRUIT) {
    // Kingdom must afford the full batch: RECRUIT_AMOUNT soldiers
    if (source.stockpile.materials < RECRUIT_AMOUNT * 2 || source.stockpile.food < RECRUIT_AMOUNT)
      return reject(
        `RECRUIT needs food:${RECRUIT_AMOUNT} + materials:${RECRUIT_AMOUNT * 2} — you cannot afford it`
      );
  }

  if (actionType === ActionType.FORTIFY) {
    if (!targetTileId) return reject("FORTIFY requires targetTileId");
    const tile = gameState.map.tiles[targetTileId];
    if (!tile || tile.owner !== sourceKingdom)
      return reject(`FORTIFY target ${targetTileId} is not your tile`);
    // Must be a border tile
    const borderTiles = getKingdomBorderTiles(sourceKingdom, gameState.map);
    const isBorder = borderTiles.some((t) => t.id === targetTileId);
    if (!isBorder)
      return reject(`FORTIFY target ${targetTileId} is not a border tile`);
    if (source.stockpile.materials < FORTIFY_COST)
      return reject(`FORTIFY needs materials:${FORTIFY_COST} — you cannot afford it`);
  }

  if (actionType === ActionType.THREATEN) {
    if (!targetKingdom) return reject("THREATEN requires targetKingdom");
    const target = gameState.kingdoms[targetKingdom];
    if (!target || !target.alive)
      return reject(`THREATEN target "${targetKingdom}" is not alive`);
    if (targetKingdom === sourceKingdom)
      return reject("cannot THREATEN yourself");
    if (!request) return reject("THREATEN requires a request (the demand)");
    const totalRequest = request.food + request.water + request.materials;
    if (totalRequest === 0) return reject("THREATEN demand is empty");
    // Cannot threaten an ALLIED kingdom
    const mem = source.diplomaticMemory[targetKingdom];
    if (mem && mem.status === DiplomaticStatus.ALLIED)
      return reject(`cannot THREATEN ${targetKingdom} — you are ALLIED`);
  }

  if (actionType === ActionType.AID) {
    if (!targetKingdom) return reject("AID requires targetKingdom");
    const target = gameState.kingdoms[targetKingdom];
    if (!target || !target.alive)
      return reject(`AID target "${targetKingdom}" is not alive`);
    if (targetKingdom === sourceKingdom) return reject("cannot AID yourself");
    if (!offer) return reject("AID requires an offer");
    const totalOffer = offer.food + offer.water + offer.materials;
    if (totalOffer === 0) return reject("AID offer is empty");
    if (
      source.stockpile.food < offer.food ||
      source.stockpile.water < offer.water ||
      source.stockpile.materials < offer.materials
    )
      return reject("AID rejected: you cannot afford the offered resources");
  }

  // NEGOTIATE, RATION: always valid if sourceKingdom is valid (already checked above)

  return {
    action: {
      actionType,
      sourceKingdom,
      targetKingdom,
      targetTileId,
      offer,
      request,
      message,
    },
    reason: null,
  };
}

/** Returns a RATION fallback action for the given kingdom (used when LLM fails). */
export function getFallbackAction(kingdomName: string): Action {
  return {
    actionType: ActionType.RATION,
    sourceKingdom: kingdomName,
    targetKingdom: null,
    targetTileId: null,
    offer: null,
    request: null,
    message: null,
  };
}

/**
 * Attempts to parse a JSON action object from raw LLM text.
 * Strips markdown code fences and extracts the first JSON object.
 * Returns null on any parse failure — never throws.
 */
export function parseActionFromLLMResponse(
  raw: string,
  _kingdomName: string
): unknown {
  try {
    // Strip markdown code fences
    let cleaned = raw.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");

    // Find first { and last }
    const openIdx = cleaned.indexOf("{");
    const closeIdx = cleaned.lastIndexOf("}");
    if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) return null;

    const jsonStr = cleaned.slice(openIdx, closeIdx + 1);
    return JSON.parse(jsonStr) as unknown;
  } catch {
    return null;
  }
}

/**
 * Returns the list of action types currently available to a kingdom
 * given the game state.
 */
export function getValidActionTypes(
  kingdom: Kingdom,
  gameState: GameState
): ActionType[] {
  const result: ActionType[] = [
    ActionType.TRADE_OFFER,
    ActionType.NEGOTIATE,
    ActionType.RATION,
  ];

  // ATTACK: requires adjacent enemy tiles owned by another alive kingdom and army > 0
  if (kingdom.army > 0) {
    const adjacentEnemy = getAdjacentEnemyTiles(kingdom.name, gameState.map);
    const hasEnemyTiles = adjacentEnemy.some((t) => {
      if (t.owner === null) return false;
      const ownerK = gameState.kingdoms[t.owner];
      return ownerK && ownerK.alive;
    });
    if (hasEnemyTiles) {
      result.push(ActionType.ATTACK);
    }
  }

  // EXPAND: requires adjacent neutral tiles
  {
    const adjacentEnemy = getAdjacentEnemyTiles(kingdom.name, gameState.map);
    const hasNeutral = adjacentEnemy.some((t) => t.owner === null);
    if (hasNeutral) {
      result.push(ActionType.EXPAND);
    }
  }

  // TRADE_ACCEPT / TRADE_REJECT: requires that some other kingdom's
  // diplomaticMemory entry for this kingdom has a non-null outstandingOffer
  // (must match validateAction's check: targetKingdom.diplomaticMemory[sourceKingdom])
  {
    const hasOutstandingOffer = Object.keys(gameState.kingdoms).some((otherName) => {
      if (otherName === kingdom.name) return false;
      const otherKingdom = gameState.kingdoms[otherName];
      const memory = otherKingdom.diplomaticMemory[kingdom.name];
      return memory !== undefined && memory.outstandingOffer !== null;
    });
    if (hasOutstandingOffer) {
      result.push(ActionType.TRADE_ACCEPT);
      result.push(ActionType.TRADE_REJECT);
    }
  }

  // RECRUIT: requires full batch cost
  if (kingdom.stockpile.food >= RECRUIT_AMOUNT && kingdom.stockpile.materials >= RECRUIT_AMOUNT * 2) {
    result.push(ActionType.RECRUIT);
  }

  // FORTIFY: requires border tiles and materials >= FORTIFY_COST
  {
    const borderTiles = getKingdomBorderTiles(kingdom.name, gameState.map);
    if (borderTiles.length > 0 && kingdom.stockpile.materials >= FORTIFY_COST) {
      result.push(ActionType.FORTIFY);
    }
  }

  // THREATEN: requires alive non-allied neighbors
  {
    const hasThreatenableTarget = Object.keys(gameState.kingdoms).some((otherName) => {
      if (otherName === kingdom.name) return false;
      const otherK = gameState.kingdoms[otherName];
      if (!otherK.alive) return false;
      const mem = kingdom.diplomaticMemory[otherName];
      return !mem || mem.status !== DiplomaticStatus.ALLIED;
    });
    if (hasThreatenableTarget) {
      result.push(ActionType.THREATEN);
    }
  }

  // AID: requires alive neighbors and at least one non-zero stockpile resource
  {
    const hasAliveNeighbor = Object.keys(gameState.kingdoms).some((otherName) => {
      if (otherName === kingdom.name) return false;
      return gameState.kingdoms[otherName].alive;
    });
    const hasResources =
      kingdom.stockpile.food > 0 ||
      kingdom.stockpile.water > 0 ||
      kingdom.stockpile.materials > 0;
    if (hasAliveNeighbor && hasResources) {
      result.push(ActionType.AID);
    }
  }

  return result;
}
