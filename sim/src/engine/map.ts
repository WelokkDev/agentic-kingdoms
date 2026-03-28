import { TileType, MapGrid, Tile } from "../core/types.js";

const GRID_SIZE = 7;

// Owner assignments: row -> col -> kingdom name (null = neutral)
const OWNER_MAP: Record<string, string | null> = {
  "0_0": "Aldrath", "0_1": "Aldrath", "0_2": "Aldrath", "0_3": null,     "0_4": "Durath",  "0_5": "Durath",  "0_6": null,
  "1_0": "Aldrath", "1_1": "Aldrath", "1_2": null,      "1_3": "Durath", "1_4": "Durath",  "1_5": "Durath",  "1_6": null,
  "2_0": null,      "2_1": "Verne",   "2_2": "Verne",   "2_3": "Durath", "2_4": "Durath",  "2_5": null,      "2_6": "Thessan",
  "3_0": "Verne",   "3_1": "Verne",   "3_2": "Verne",   "3_3": null,     "3_4": null,      "3_5": "Thessan", "3_6": "Thessan",
  "4_0": "Verne",   "4_1": null,      "4_2": "Mira",    "4_3": "Mira",   "4_4": "Thessan", "4_5": "Thessan", "4_6": "Thessan",
  "5_0": null,      "5_1": "Mira",    "5_2": "Mira",    "5_3": "Mira",   "5_4": "Mira",    "5_5": null,      "5_6": null,
  "6_0": null,      "6_1": null,      "6_2": "Mira",    "6_3": null,     "6_4": null,      "6_5": null,      "6_6": null,
};

// Tile type assignments for every cell
const TILE_TYPE_MAP: Record<string, TileType> = {
  // Aldrath (mountains, NW)
  "0_0": TileType.MOUNTAIN, "0_1": TileType.MOUNTAIN, "0_2": TileType.FOREST,
  "1_0": TileType.MOUNTAIN, "1_1": TileType.MOUNTAIN,

  // Durath (central, mixed)
  "0_4": TileType.PLAINS,   "0_5": TileType.PLAINS,
  "1_3": TileType.FARMLAND, "1_4": TileType.FARMLAND, "1_5": TileType.PLAINS,
  "2_3": TileType.FOREST,   "2_4": TileType.RIVER,

  // Verne (plains, food-rich)
  "2_1": TileType.FARMLAND, "2_2": TileType.FARMLAND,
  "3_0": TileType.FARMLAND, "3_1": TileType.FARMLAND, "3_2": TileType.PLAINS,
  "4_0": TileType.PLAINS,

  // Mira (wetlands, water-rich)
  "4_2": TileType.WETLAND,  "4_3": TileType.WETLAND,
  "5_1": TileType.RIVER,    "5_2": TileType.WETLAND,  "5_3": TileType.WETLAND, "5_4": TileType.RIVER,
  "6_2": TileType.FARMLAND,

  // Thessan (coastal, east)
  "2_6": TileType.COASTAL,
  "3_5": TileType.COASTAL,  "3_6": TileType.PLAINS,
  "4_4": TileType.RIVER,    "4_5": TileType.COASTAL,  "4_6": TileType.COASTAL,

  // Neutral tiles
  "0_3": TileType.PLAINS,   "0_6": TileType.FOREST,
  "1_2": TileType.PLAINS,   "1_6": TileType.FOREST,
  "2_0": TileType.FARMLAND, "2_5": TileType.PLAINS,
  "3_3": TileType.FARMLAND, "3_4": TileType.PLAINS,
  "4_1": TileType.WETLAND,
  "5_0": TileType.PLAINS,   "5_5": TileType.FOREST,   "5_6": TileType.PLAINS,
  "6_0": TileType.PLAINS,   "6_1": TileType.WETLAND,   "6_3": TileType.PLAINS,
  "6_4": TileType.FARMLAND, "6_5": TileType.FOREST,    "6_6": TileType.COASTAL,
};

const EXPECTED_COUNTS: Record<string, number> = {
  Aldrath: 5,
  Verne: 6,
  Durath: 7,
  Mira: 7,
  Thessan: 6,
  neutral: 18,
};

/** Defense multiplier per terrain type. Imported by the combat engine. */
export const TERRAIN_DEFENSE_BONUS: Record<TileType, number> = {
  [TileType.MOUNTAIN]: 1.5,
  [TileType.WETLAND]: 1.3,
  [TileType.COASTAL]: 1.2,
  [TileType.FOREST]: 1.15,
  [TileType.PLAINS]: 1.0,
  [TileType.FARMLAND]: 1.0,
  [TileType.RIVER]: 1.1,
};

/** Computes 4-directional adjacency for every tile in the grid. */
export function computeAdjacency(grid: string[][]): Record<string, string[]> {
  const adjacency: Record<string, string[]> = {};
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const id = grid[r][c];
      const neighbours: string[] = [];
      for (const [dr, dc] of directions) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < grid.length && nc >= 0 && nc < grid[r].length) {
          neighbours.push(grid[nr][nc]);
        }
      }
      adjacency[id] = neighbours;
    }
  }

  return adjacency;
}

/** Returns full Tile objects for all tiles adjacent to the given tile. */
export function getAdjacentTiles(tileId: string, map: MapGrid): Tile[] {
  const neighbours = map.adjacency[tileId];
  if (!neighbours) return [];
  return neighbours.map((id) => map.tiles[id]);
}

/** Returns all tiles currently owned by a given kingdom. */
export function getKingdomTiles(kingdomName: string, map: MapGrid): Tile[] {
  return Object.values(map.tiles).filter((t) => t.owner === kingdomName);
}

/** Returns all tiles with no owner. */
export function getNeutralTiles(map: MapGrid): Tile[] {
  return Object.values(map.tiles).filter((t) => t.owner === null);
}

/** Returns all tiles owned by a kingdom that border at least one tile not owned by that kingdom. */
export function getKingdomBorderTiles(kingdomName: string, map: MapGrid): Tile[] {
  return getKingdomTiles(kingdomName, map).filter((tile) =>
    map.adjacency[tile.id].some((adjId) => map.tiles[adjId].owner !== kingdomName)
  );
}

/** Returns all tiles not owned by a kingdom that are adjacent to at least one tile owned by that kingdom. */
export function getAdjacentEnemyTiles(kingdomName: string, map: MapGrid): Tile[] {
  const ownedIds = new Set(
    getKingdomTiles(kingdomName, map).map((t) => t.id)
  );
  const seen = new Set<string>();
  const result: Tile[] = [];

  for (const ownedId of ownedIds) {
    for (const adjId of map.adjacency[ownedId]) {
      if (!ownedIds.has(adjId) && !seen.has(adjId)) {
        seen.add(adjId);
        result.push(map.tiles[adjId]);
      }
    }
  }

  return result;
}

/** Returns an array of error strings. Empty array means the map is valid. */
export function validateMapGrid(map: MapGrid): string[] {
  const errors: string[] = [];

  // Exactly 49 tiles
  const tileCount = Object.keys(map.tiles).length;
  if (tileCount !== 49) {
    errors.push(`Expected 49 tiles, got ${tileCount}`);
  }

  // Every tile ID matches its row and col
  for (const [id, tile] of Object.entries(map.tiles)) {
    const expected = `${tile.row}_${tile.col}`;
    if (id !== expected) {
      errors.push(`Tile "${id}" has row=${tile.row}, col=${tile.col} — expected ID "${expected}"`);
    }
  }

  // Every tile in grid exists in tiles
  for (let r = 0; r < map.grid.length; r++) {
    for (let c = 0; c < map.grid[r].length; c++) {
      const id = map.grid[r][c];
      if (!map.tiles[id]) {
        errors.push(`Grid cell [${r}][${c}] references "${id}" which is not in tiles`);
      }
    }
  }

  // Every tile ID in adjacency exists in tiles
  for (const [id, neighbours] of Object.entries(map.adjacency)) {
    if (!map.tiles[id]) {
      errors.push(`Adjacency key "${id}" is not in tiles`);
    }
    for (const nId of neighbours) {
      if (!map.tiles[nId]) {
        errors.push(`Adjacency for "${id}" references "${nId}" which is not in tiles`);
      }
    }
  }

  // Adjacency is symmetric
  for (const [id, neighbours] of Object.entries(map.adjacency)) {
    for (const nId of neighbours) {
      if (!map.adjacency[nId]?.includes(id)) {
        errors.push(`Adjacency asymmetry: "${id}" lists "${nId}" but "${nId}" does not list "${id}"`);
      }
    }
  }

  // Kingdom tile counts
  const counts: Record<string, number> = { neutral: 0 };
  for (const tile of Object.values(map.tiles)) {
    const key = tile.owner ?? "neutral";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
    const actual = counts[name] ?? 0;
    if (actual !== expected) {
      errors.push(`${name}: expected ${expected} tiles, got ${actual}`);
    }
  }

  return errors;
}

/** Builds the initial 7×7 MapGrid with hardcoded layout. Pure and deterministic. */
export function buildMapGrid(): MapGrid {
  const tiles: Record<string, Tile> = {};
  const grid: string[][] = [];

  for (let r = 0; r < GRID_SIZE; r++) {
    const row: string[] = [];
    for (let c = 0; c < GRID_SIZE; c++) {
      const id = `${r}_${c}`;
      tiles[id] = {
        id,
        row: r,
        col: c,
        tileType: TILE_TYPE_MAP[id],
        owner: OWNER_MAP[id] ?? null,
        contested: false,
      };
      row.push(id);
    }
    grid.push(row);
  }

  const adjacency = computeAdjacency(grid);
  const map: MapGrid = { tiles, grid, adjacency };

  if (typeof process === "undefined" || process.env.NODE_ENV !== "production") {
    const errors = validateMapGrid(map);
    if (errors.length > 0) {
      throw new Error(`MapGrid validation failed:\n${errors.join("\n")}`);
    }
  }

  return map;
}

export default buildMapGrid;
