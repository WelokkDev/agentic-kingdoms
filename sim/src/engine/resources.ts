import { Kingdom, MapGrid, Resources, TILE_YIELDS } from "../core/types.js";

/** Sum TILE_YIELDS for every tile the kingdom owns. Raw tile production only — tradeEfficiency applies to trade receipts, not production. */
export function computeProduction(kingdom: Kingdom, map: MapGrid): Resources {
  let food = 0;
  let water = 0;
  let materials = 0;

  for (const tileId of kingdom.tileIds) {
    const tile = map.tiles[tileId];
    const yields = TILE_YIELDS[tile.tileType];
    food += yields.food;
    water += yields.water;
    materials += yields.materials;
  }

  return { food, water, materials };
}

/** Compute per-tick consumption based on population and army size. */
export function computeConsumption(kingdom: Kingdom): Resources {
  const totalPeople = kingdom.population + kingdom.army;
  return {
    food: totalPeople * 1,
    water: totalPeople * 0.5,
    materials: kingdom.army * 0.5,
  };
}

/** Apply production and consumption to stockpile, flooring each resource at 0. */
export function applyProductionConsumption(kingdom: Kingdom, map: MapGrid): Kingdom {
  const production = computeProduction(kingdom, map);
  const consumption = computeConsumption(kingdom);

  return {
    ...kingdom,
    production,
    consumption,
    stockpile: {
      food: Math.max(0, kingdom.stockpile.food + production.food - consumption.food),
      water: Math.max(0, kingdom.stockpile.water + production.water - consumption.water),
      materials: Math.max(0, kingdom.stockpile.materials + production.materials - consumption.materials),
    },
  };
}

/** Track how many consecutive ticks each resource has been at zero after a decrease. */
export function updateDeficitTracking(kingdom: Kingdom, previousStockpile: Resources): Kingdom {
  const keys: Array<keyof Resources> = ["food", "water", "materials"];
  const ticksInDeficit: Record<string, number> = { ...kingdom.ticksInDeficit };

  for (const key of keys) {
    if (kingdom.stockpile[key] <= 0 && kingdom.stockpile[key] < previousStockpile[key]) {
      ticksInDeficit[key] = (ticksInDeficit[key] ?? 0) + 1;
    } else if (kingdom.stockpile[key] > 0) {
      ticksInDeficit[key] = 0;
    }
  }

  return { ...kingdom, ticksInDeficit };
}

/** Returns max(0, consumption - production) per resource. */
export function getDeficit(kingdom: Kingdom): Resources {
  return {
    food: Math.max(0, kingdom.consumption.food - kingdom.production.food),
    water: Math.max(0, kingdom.consumption.water - kingdom.production.water),
    materials: Math.max(0, kingdom.consumption.materials - kingdom.production.materials),
  };
}

/** Returns max(0, production - consumption) per resource. */
export function getSurplus(kingdom: Kingdom): Resources {
  return {
    food: Math.max(0, kingdom.production.food - kingdom.consumption.food),
    water: Math.max(0, kingdom.production.water - kingdom.consumption.water),
    materials: Math.max(0, kingdom.production.materials - kingdom.consumption.materials),
  };
}
