import { DiplomaticStatus, GameState, Kingdom } from "../core/types.js";
import { getDeficit, getSurplus } from "./resources.js";

/** Recruit soldiers if the kingdom can afford it and has enough population. */
export function recruitTroops(kingdom: Kingdom, amount: number): Kingdom {
  const foodCost = amount * 1;
  const materialsCost = amount * 2;

  const canAfford =
    kingdom.stockpile.food >= foodCost &&
    kingdom.stockpile.materials >= materialsCost;

  const hasPopulation = kingdom.population >= kingdom.army + amount;

  if (!canAfford || !hasPopulation) {
    return kingdom;
  }

  return {
    ...kingdom,
    stockpile: {
      ...kingdom.stockpile,
      food: kingdom.stockpile.food - foodCost,
      materials: kingdom.stockpile.materials - materialsCost,
    },
    army: kingdom.army + amount,
  };
}

/** Degrade or recover army effectiveness based on materials deficit/surplus. */
export function updateArmyEffectiveness(kingdom: Kingdom): Kingdom {
  const deficit = getDeficit(kingdom);
  const surplus = getSurplus(kingdom);
  let armyEffectiveness = kingdom.armyEffectiveness;

  if (deficit.materials > 0) {
    armyEffectiveness = Math.max(0.5, armyEffectiveness * 0.95);
  } else if (surplus.materials > 0) {
    armyEffectiveness = Math.min(1.0, armyEffectiveness + 0.05);
  }

  return { ...kingdom, armyEffectiveness };
}

/** Apply desertion when kingdom has a food deficit. Morale scales the rate. */
export function applyDesertion(kingdom: Kingdom): Kingdom {
  const deficit = getDeficit(kingdom);
  if (deficit.food <= 0) {
    return kingdom;
  }

  // desertion = army × 0.03 × (2 - morale)
  // At morale 1.0: baseline 0.03. At 0.2: ~0.054. At 1.5: ~0.015.
  const losses = kingdom.army * 0.03 * (2 - kingdom.morale);
  return {
    ...kingdom,
    army: Math.max(0, kingdom.army - losses),
  };
}

/** Apply war exhaustion penalties for each active AT_WAR pair. Skips dead kingdoms. */
export function applyWarExhaustion(
  kingdom: Kingdom,
  gameState: GameState,
): Kingdom {
  let updated = { ...kingdom };
  let moralePenalty = 0;
  let materialsDrain = 0;
  let effectivenessDegraded = false;

  for (const [otherName, mem] of Object.entries(updated.diplomaticMemory)) {
    // Skip if the other kingdom is dead — no exhaustion from wars with corpses
    if (!gameState.kingdoms[otherName]?.alive) continue;
    if (mem.status !== DiplomaticStatus.AT_WAR) continue;

    // Increment FIRST — measures "entering tick N of war" before applying effects
    const updatedMem = { ...mem, ticksAtWar: mem.ticksAtWar + 1 };
    updated = {
      ...updated,
      diplomaticMemory: {
        ...updated.diplomaticMemory,
        [otherName]: updatedMem,
      },
    };

    // Per-war penalties (compound with multiple wars)
    moralePenalty += 0.05;
    materialsDrain += 1;

    // After 5 consecutive ticks at war: effectiveness degrades
    if (updatedMem.ticksAtWar >= 5) {
      effectivenessDegraded = true;
    }
  }

  // Apply materials drain
  updated = {
    ...updated,
    stockpile: {
      ...updated.stockpile,
      materials: Math.max(0, updated.stockpile.materials - materialsDrain),
    },
  };

  // Apply morale penalty — clamp to floor 0.2 inside this function
  updated = {
    ...updated,
    morale: Math.max(0.2, updated.morale - moralePenalty),
  };

  // Apply effectiveness degradation if threshold crossed
  // Compounds with existing materials-deficit degradation — shared floor 0.5
  if (effectivenessDegraded) {
    updated = {
      ...updated,
      armyEffectiveness: Math.max(0.5, updated.armyEffectiveness * 0.97),
    };
  }

  return updated;
}

/** Compute effective combat power of a kingdom's army. */
export function getArmyEffectivePower(kingdom: Kingdom): number {
  return kingdom.army * kingdom.morale * kingdom.armyEffectiveness;
}
