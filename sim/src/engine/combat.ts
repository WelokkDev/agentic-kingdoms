import { Kingdom, Tile, CombatResult, CombatOutcome, MapGrid } from "../core/types.js";
import { TERRAIN_DEFENSE_BONUS } from "./map.js";
import { getArmyEffectivePower } from "./army.js";

/** Resolve combat between attacker and defender over a target tile. */
export function resolveCombat(
  attacker: Kingdom,
  defender: Kingdom,
  targetTile: Tile,
  rng: () => number,
): CombatResult {
  const attackPower = getArmyEffectivePower(attacker);
  const terrainBonus = TERRAIN_DEFENSE_BONUS[targetTile.tileType] +
    (targetTile.fortified ? 0.3 : 0);
  const defensePower = getArmyEffectivePower(defender) * terrainBonus;

  const ratio = attackPower / defensePower;

  let outcome: CombatOutcome;
  let attackerLossRate: number;
  let defenderLossRate: number;
  let contestedAttackerWins = false;

  if (ratio > 2.0) {
    outcome = "decisive_win";
    attackerLossRate = 0.10;
    defenderLossRate = 0.40;
  } else if (ratio >= 1.3) {
    outcome = "marginal_win";
    attackerLossRate = 0.20;
    defenderLossRate = 0.25;
  } else if (ratio >= 0.8) {
    outcome = "contested";
    attackerLossRate = 0.20;
    defenderLossRate = 0.20;
    // Coin flip determines tile capture only — losses are symmetric
    contestedAttackerWins = rng() > 0.5;
  } else {
    outcome = "repelled";
    attackerLossRate = 0.30;
    defenderLossRate = 0.05;
  }

  const attackerLosses = Math.floor(attacker.army * attackerLossRate);
  const defenderLosses = Math.floor(defender.army * defenderLossRate);

  const tileCaptured =
    outcome === "decisive_win" || outcome === "marginal_win" || contestedAttackerWins
      ? targetTile.id
      : null;

  return {
    attacker: attacker.name,
    defender: defender.name,
    attackerPower: attackPower,
    defenderPower: defensePower,
    ratio,
    outcome,
    attackerLosses,
    defenderLosses,
    tileCaptured,
  };
}

/** Deduct logistics costs for launching an attack. */
export function applyLogisticsCost(kingdom: Kingdom): Kingdom {
  return {
    ...kingdom,
    stockpile: {
      ...kingdom.stockpile,
      food: Math.max(0, kingdom.stockpile.food - 5),
      materials: Math.max(0, kingdom.stockpile.materials - 3),
    },
  };
}

/** Apply attacker army losses from a combat result. */
export function applyAttackerLosses(kingdom: Kingdom, result: CombatResult): Kingdom {
  return {
    ...kingdom,
    army: Math.max(0, kingdom.army - result.attackerLosses),
  };
}

/** Apply defender army losses from a combat result. */
export function applyDefenderLosses(kingdom: Kingdom, result: CombatResult): Kingdom {
  return {
    ...kingdom,
    army: Math.max(0, kingdom.army - result.defenderLosses),
  };
}

/** Transfer a tile from its current owner to a new owner. Returns new map and kingdoms. */
export function transferTile(
  tileId: string,
  newOwner: string,
  map: MapGrid,
  kingdoms: Record<string, Kingdom>,
): { map: MapGrid; kingdoms: Record<string, Kingdom> } {
  const tile = map.tiles[tileId];
  const previousOwner = tile.owner;

  // Update the tile
  const updatedTiles: Record<string, Tile> = {
    ...map.tiles,
    [tileId]: { ...tile, owner: newOwner, fortified: false, fortifyExpiresAt: 0 },
  };

  const updatedMap: MapGrid = { ...map, tiles: updatedTiles };

  // Update kingdoms
  const updatedKingdoms: Record<string, Kingdom> = { ...kingdoms };

  // Remove from previous owner
  if (previousOwner !== null && updatedKingdoms[previousOwner]) {
    updatedKingdoms[previousOwner] = {
      ...updatedKingdoms[previousOwner],
      tileIds: updatedKingdoms[previousOwner].tileIds.filter((id) => id !== tileId),
    };
  }

  // Add to new owner
  if (updatedKingdoms[newOwner]) {
    updatedKingdoms[newOwner] = {
      ...updatedKingdoms[newOwner],
      tileIds: [...updatedKingdoms[newOwner].tileIds, tileId],
    };
  }

  return { map: updatedMap, kingdoms: updatedKingdoms };
}
