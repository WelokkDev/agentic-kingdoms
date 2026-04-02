/** The three resources in the simulation. No currency exists. */
export enum ResourceType {
  FOOD = "FOOD",
  WATER = "WATER",
  MATERIALS = "MATERIALS",
}

/** The seven terrain types that make up the 7×7 grid. */
export enum TileType {
  FARMLAND = "FARMLAND",
  RIVER = "RIVER",
  MOUNTAIN = "MOUNTAIN",
  FOREST = "FOREST",
  COASTAL = "COASTAL",
  PLAINS = "PLAINS",
  WETLAND = "WETLAND",
}

/** A bundle of the three resource quantities. Used for stockpiles, production, consumption, and trade. */
export interface Resources {
  food: number;
  water: number;
  materials: number;
}

/** A single cell in the 7×7 grid. */
export interface Tile {
  id: string;
  row: number;
  col: number;
  tileType: TileType;
  owner: string | null;
  contested: boolean;
}

/** Static per-tick resource yield for each terrain type. */
export const TILE_YIELDS: Record<TileType, Resources> = {
  [TileType.FARMLAND]: { food: 3, water: 0, materials: 0 },
  [TileType.RIVER]: { food: 1, water: 3, materials: 0 },
  [TileType.MOUNTAIN]: { food: 0, water: 0, materials: 3 },
  [TileType.FOREST]: { food: 1, water: 1, materials: 1 },
  [TileType.COASTAL]: { food: 2, water: 2, materials: 0 },
  [TileType.PLAINS]: { food: 2, water: 1, materials: 0 },
  [TileType.WETLAND]: { food: 1, water: 2, materials: 0 },
};

/** Relationship state between two kingdoms. */
export enum DiplomaticStatus {
  NEUTRAL = "NEUTRAL",
  TRADE_PARTNER = "TRADE_PARTNER",
  ALLIED = "ALLIED",
  HOSTILE = "HOSTILE",
  AT_WAR = "AT_WAR",
}

/** What one kingdom remembers about its relationship with another. */
export interface DiplomaticMemory {
  status: DiplomaticStatus;
  lastInteractionTick: number;
  tradeDealsCompleted: number;
  timesAttackedUs: number;
  timesWeAttacked: number;
  outstandingOffer: Action | null;
}

/** The full state of one kingdom at a point in time. */
export interface Kingdom {
  name: string;
  population: number;
  army: number;
  armyEffectiveness: number;
  morale: number;
  stockpile: Resources;
  production: Resources;
  consumption: Resources;
  tileIds: string[];
  diplomaticMemory: Record<string, DiplomaticMemory>;
  alive: boolean;
  ticksInDeficit: Record<string, number>;
  tradeEfficiency: number;
}

/** All legal actions an agent can submit in a tick. */
export enum ActionType {
  TRADE_OFFER = "TRADE_OFFER",
  TRADE_ACCEPT = "TRADE_ACCEPT",
  TRADE_REJECT = "TRADE_REJECT",
  ATTACK = "ATTACK",
  RECRUIT = "RECRUIT",
  RATION = "RATION",
  EXPAND = "EXPAND",
  NEGOTIATE = "NEGOTIATE",
  PASS = "PASS",
}

/** A single action chosen by an agent for one tick. */
export interface Action {
  actionType: ActionType;
  sourceKingdom: string;
  targetKingdom: string | null;
  targetTileId: string | null;
  offer: Resources | null;
  request: Resources | null;
  message: string | null;
}

/** String union describing the degree of combat success. */
export type CombatOutcome =
  | "decisive_win"
  | "marginal_win"
  | "contested"
  | "repelled";

/** Resolved outcome of one combat action, stored in the event log. */
export interface CombatResult {
  attacker: string;
  defender: string;
  attackerPower: number;
  defenderPower: number;
  ratio: number;
  outcome: CombatOutcome;
  attackerLosses: number;
  defenderLosses: number;
  tileCaptured: string | null;
}

/** Resolved outcome of one completed barter trade. */
export interface TradeResult {
  offerer: string;
  accepter: string;
  offered: Resources;
  received: Resources;
  tick: number;
}

/** Categories of simulation events. */
export enum EventType {
  COMBAT = "COMBAT",
  TRADE = "TRADE",
  DIPLOMACY = "DIPLOMACY",
  RESOURCE_CRISIS = "RESOURCE_CRISIS",
  KINGDOM_ELIMINATED = "KINGDOM_ELIMINATED",
  TILE_CAPTURED = "TILE_CAPTURED",
  TILE_EXPANDED = "TILE_EXPANDED",
  POPULATION_CHANGE = "POPULATION_CHANGE",
  MORALE_CHANGE = "MORALE_CHANGE",
}

/** A single logged simulation event. */
export interface Event {
  tick: number;
  eventType: EventType;
  kingdomsInvolved: string[];
  description: string;
  data: Record<string, unknown>;
}

/** The full 7×7 tile map with positional and adjacency lookups. */
export interface MapGrid {
  tiles: Record<string, Tile>;
  grid: string[][];
  adjacency: Record<string, string[]>;
}

/** Top-level simulation configuration. */
export interface SimConfig {
  maxTicks: number;
  kingdomNames: string[];
  seed: number;
}

/** The complete simulation state at any tick. Single source of truth. Must be fully JSON-serializable. */
export interface GameState {
  tick: number;
  kingdoms: Record<string, Kingdom>;
  map: MapGrid;
  events: Event[];
  pendingActions: Record<string, Action>;
  rngSeed: number;
  config: SimConfig;
}

/** Output of one full simulation tick. Primary serialization boundary for renderers and web layer. */
export interface TickResult {
  tick: number;
  gameState: GameState;
  eventsThisTick: Event[];
  actionsThisTick: Record<string, Action>;
  terminated: boolean;
  /** Optional per-kingdom LLM response times in ms. Populated in debug mode. */
  agentTimings?: Record<string, number>;
}
