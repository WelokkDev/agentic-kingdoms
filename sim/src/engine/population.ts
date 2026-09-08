import { Kingdom } from "../core/types.js";
import { getDeficit, getSurplus } from "./resources.js";

/**
 * Adjust population based on food/water availability. Stockpiles buffer
 * people: starvation only bites once the relevant store is empty.
 */
export function updatePopulation(kingdom: Kingdom): Kingdom {
  const surplus = getSurplus(kingdom);
  const deficit = getDeficit(kingdom);

  let population = kingdom.population;

  const wellFed = kingdom.stockpile.food > kingdom.population * 2;
  if (surplus.food >= 10 || wellFed) {
    population += 1;
  }

  if (deficit.food > 0 && kingdom.stockpile.food <= 0) {
    population -= deficit.food * 0.3;
  }

  if (deficit.water > 0 && kingdom.stockpile.water <= 0) {
    population -= deficit.water * 0.5;
  }

  population = Math.max(1.0, population);

  return { ...kingdom, population };
}

/** Adjust morale based on resource state and events this tick. */
export function updateMorale(
  kingdom: Kingdom,
  wonCombat: boolean,
  lostCombat: boolean,
  tradeCompleted: boolean,
): Kingdom {
  const surplus = getSurplus(kingdom);
  const deficit = getDeficit(kingdom);

  let morale = kingdom.morale;

  if (surplus.food > 0) {
    morale += 0.1;
  }
  if (deficit.food > 0 && kingdom.stockpile.food <= 0) {
    morale -= 0.1;
  }
  if (deficit.water > 0 && kingdom.stockpile.water <= 0) {
    morale -= 0.2;
  }
  if (tradeCompleted) {
    morale += 0.1;
  }
  if (wonCombat) {
    morale += 0.2;
  }
  if (lostCombat) {
    morale -= 0.3;
  }

  morale = Math.max(0.2, Math.min(1.5, morale));

  return { ...kingdom, morale };
}

/** Returns true if the kingdom should be eliminated. */
export function isKingdomEliminated(kingdom: Kingdom): boolean {
  return kingdom.population <= 1 && kingdom.army <= 0;
}
