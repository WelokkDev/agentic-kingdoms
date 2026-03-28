# Design Decisions

All locked physics, numbers, and architectural choices for the simulation.
This is the authoritative reference.

---

## Core Philosophy

- **No explicit goals.** Agents are not told to expand, win, or conquer.
- **Physics drives behavior.** The engine enforces all rules. Agents cannot bypass mechanics.
- **Scarcity creates decisions.** Every kingdom consumes more than it produces in at least one resource.
- **Geography determines power.** Resource asymmetry between kingdoms is intentional and permanent.
- **Simple mechanics, deep outcomes.** Complexity emerges from interactions, not from feature count.
- **Minimum viable survival window.** Every kingdom must have at least 6–10 ticks before any resource hits critical collapse. Scarcity creates pressure, not instant death.

---

## Resources

| Resource | Role |
|---|---|
| FOOD | Growth potential — feeds population and army |
| WATER | Hard survival constraint — deficits kill faster than food |
| MATERIALS | Military capability — required to recruit and maintain army |

**Gold does not exist.** There is no currency. All exchange is barter (resource-for-resource).
**Coastal tile advantage** is expressed as a `tradeEfficiency` multiplier on the Kingdom struct, not a resource yield.

---

## Tile Types & Yields (per tick)

| Tile Type | Food | Water | Materials | Notes |
|---|---|---|---|---|
| FARMLAND | 3 | 0 | 0 | Core food source |
| RIVER | 1 | 3 | 0 | Water leverage tile |
| MOUNTAIN | 0 | 0 | 3 | Military supply |
| FOREST | 1 | 1 | 1 | Balanced, low yield |
| COASTAL | 2 | 2 | 0 | No gold — advantage is tradeEfficiency |
| PLAINS | 2 | 1 | 0 | Common, moderate |
| WETLAND | 1 | 2 | 0 | Water + minor food |

No tile produces everything. Every tile type creates demand for other tile types.

---

## Map

### Structure
- 7×7 grid = 49 tiles total
- 5 kingdoms, ~7 tiles each at start (~35 tiles)
- ~14 neutral tiles scattered at borders — early expansion targets
- Adjacency: 4-directional only (no diagonals)
- Tile ID format: `"row_col"` e.g. `"3_4"`

### Kingdom Starting Positions & Terrain Identity

**Aldrath** — Mountains (NW)
- Tiles: 4× Mountain, 1× Forest
- Production: high materials, near-zero food and water
- Pressure: must trade or expand within first few ticks

**Verne** — Plains (West-Center)
- Tiles: 4× Farmland, 2× Plains
- Production: food surplus, nothing else
- Pressure: rich but exposed on multiple borders

**Durath** — Central
- Tiles: 2× Plains, 2× Farmland, 1× Forest, 1× River
- Production: most balanced of all kingdoms
- Pressure: borders everyone — strategic kingmaker

**Mira** — Wetlands (South)
- Tiles: 3× Wetland, 2× River, 1× Farmland
- Production: water powerhouse, food-weak, no materials
- Pressure: controls water leverage but militarily vulnerable

**Thessan** — Coastal (East)
- Tiles: 3× Coastal, 1× Plains, 1× River
- Production: high tradeEfficiency, moderate food/water, no materials
- Pressure: peninsula — easy to defend, hard to expand

### Adjacency Graph

| Kingdom | Borders |
|---|---|
| Aldrath | Verne, Durath |
| Verne | Aldrath, Mira, Durath |
| Durath | Aldrath, Verne, Mira, Thessan |
| Mira | Verne, Durath, Thessan |
| Thessan | Mira, Durath |

Durath borders everyone — it is the strategic pivot of the map.
Aldrath and Thessan each have only 2 borders — natural defensive isolation.

### Neutral Tiles
Distributed at kingdom borders: mix of Plains, Farmland, Forest.
A small number of River tiles near Mira's borders — these will be highly contested.
Neutral tiles give agents a safe first-move (EXPAND) before kingdoms begin clashing.

---

## Terrain Combat Bonuses (Defender)

Applied when a kingdom is attacked on its own tiles.

| Terrain | Defender Bonus | Reasoning |
|---|---|---|
| MOUNTAIN | ×1.5 | Passes, elevation, chokepoints |
| WETLAND | ×1.3 | Slow movement, difficult footing |
| COASTAL | ×1.2 | Coastline flanks |
| FOREST | ×1.15 | Cover, visibility disadvantage for attacker |
| CENTRAL / PLAINS | ×1.0 | No natural advantage |

Bonus applies to the tile being attacked specifically, not the whole kingdom.

---

## Population & Morale

### Population

```
Base growth:
  if food_surplus >= 10:  population += 1 per tick

Decline from food deficit:
  population -= food_deficit * 0.3 per tick

Decline from water deficit:
  population -= water_deficit * 0.5 per tick   ← faster than food

Floor: population cannot drop below 1
  (kingdom survives as rump state until army is also gone)
```

### Morale

```
Range: 0.2 (floor) → 1.5 (ceiling)
Default: 1.0

Modifiers per tick:
  +0.1  food surplus (any)
  +0.1  successful trade completed
  +0.2  military victory
  −0.1  food deficit
  −0.2  water deficit
  −0.3  military loss

Morale affects:
  - combat power (multiplier)
  - desertion rate (scaled by 2 - morale; see Army System)
```

---

## Army System

### Recruiting Cost
```
To recruit N soldiers:
  costs: materials * 2 per soldier + food * 1 per soldier
  requires: population >= army + N  (can't recruit beyond population pool)
```

### Per-Tick Upkeep
```
Each soldier consumes per tick:
  food:      1
  materials: 0.5
```

### Degradation from Deficits
```
If materials deficit:
  army_effectiveness *= 0.95 per tick  (5% degradation, compounds)
  floor: 0.5 effectiveness

If food deficit:
  morale -= 0.1 per tick (via morale system)
  desertion: army -= army * 0.03 * (2 - morale) per tick
    At morale 1.0 (default): baseline 3% loss
    At morale 0.2 (floor):   ~5.4% loss — nearly double
    At morale 1.5 (ceiling):  ~1.5% loss — half
    Creates feedback loop: food deficit → morale drops → faster desertion
```

### Army Effectiveness
Tracked as a multiplier (default 1.0) applied to attack/defense power calculations.
Recovers at +0.05 per tick when materials are in surplus.

---

## Combat Engine

### Power Calculation
```
attack_power  = attacker.army * attacker.morale * attacker.army_effectiveness
defense_power = defender.army * defender.morale * defender.army_effectiveness * terrain_bonus
ratio         = attack_power / defense_power
```

### Outcome Bands

| Ratio | Outcome | Description |
|---|---|---|
| > 2.0 | decisive_win | Attacker wins cleanly, low losses |
| 1.3 – 2.0 | marginal_win | Attacker wins, moderate losses both sides |
| 0.8 – 1.3 | contested | Both take equal losses (−20%) — coin flip determines tile capture |
| < 0.8 | repelled | Attacker pushed back with heavy losses |

Randomness is quarantined to the `contested` band only. All other outcomes are fully deterministic.

### Logistics Cost (paid upfront by attacker, before resolution)
```
food      -= 5
materials -= 3
```
This cost is paid even if the attack is repelled. War is never costless.

### Army Losses by Outcome

```
decisive_win:
  attacker loses: army * 0.10
  defender loses: army * 0.40

marginal_win:
  attacker loses: army * 0.20
  defender loses: army * 0.25

contested:
  both lose:      army * 0.20

repelled:
  attacker loses: army * 0.30
  defender loses: army * 0.05
```

### Tile Capture
On decisive_win, marginal_win, or contested (coin flip favors attacker):
- One tile transfers from defender to attacker
- Eligible tiles: defender tiles adjacent to any attacker tile
- Attacker specifies `targetTileId` in the Action — engine validates adjacency
- Defender's production drops immediately next tick
- Attacker's production rises immediately next tick

Kingdoms are never fully absorbed in v1. They shrink tile by tile.
Elimination occurs when population hits floor AND army reaches 0.

---

## Trade & Diplomacy

### Barter Only
All trades are resource-for-resource.

Example: `{ offer: { food: 10, water: 0, materials: 0 }, request: { food: 0, water: 0, materials: 5 } }`

### Trade Flow
```
Tick N:   Kingdom A submits TRADE_OFFER targeting Kingdom B
Tick N:   Kingdom B sees offer in its perception
Tick N:   Kingdom B submits TRADE_ACCEPT or TRADE_REJECT
Resolution: if both actions present and valid, trade executes atomically
```

Offers expire after 2 ticks if not responded to.

### tradeEfficiency Multiplier
Coastal kingdoms start with `tradeEfficiency: 1.2`.
All others: `tradeEfficiency: 1.0`.
Effect: when a coastal kingdom receives a trade, the received quantities are multiplied by tradeEfficiency.
This makes coastal kingdoms desirable trade partners without requiring gold.

### Diplomatic Memory
Each kingdom tracks per-relationship:
- Current status (NEUTRAL → TRADE_PARTNER → ALLIED → HOSTILE → AT_WAR)
- Completed trade count
- Times attacked / times we attacked
- Last interaction tick

Status transitions are driven by actions, not by time.
An ALLIED kingdom that attacks shifts directly to AT_WAR.

---

## Agent Perception

Each agent receives a single compact string per tick — max ~200 tokens.

### Perception Contents
```
- Kingdom name + tick number
- Own stockpile (food, water, materials)
- Own production rate
- Own consumption rate
- Deficit flags + ticks_in_deficit per resource
- Population, army, morale (single values)
- Tiles owned (count by type, not full list)
- Border exposure: which kingdoms/neutral tiles are adjacent + tile types at border
- Neighbor summaries: military_strength (weak/medium/strong), resource_pressure (low/medium/high/critical)
- Diplomatic memory per neighbor: status + last_interaction_tick
- Outstanding trade offers (if any)
- Last tick's events involving this kingdom (brief)
```

No raw map data. No full tile lists. No internal state of other kingdoms.
The engine computes this — the LLM never reasons about raw world state.

---

## Action Schema

All legal actions. Engine rejects anything outside this set.

| Action | Required Fields | Notes |
|---|---|---|
| TRADE_OFFER | targetKingdom, offer, request | Barter only |
| TRADE_ACCEPT | targetKingdom | Accepts outstanding offer from that kingdom |
| TRADE_REJECT | targetKingdom | Explicit rejection |
| ATTACK | targetKingdom, targetTileId | Must be adjacent tile |
| RECRUIT | (none) | Costs food + materials, capped by population |
| RATION | (none) | Reduces consumption, penalizes morale |
| EXPAND | targetTileId | Must be neutral tile adjacent to own territory |
| NEGOTIATE | targetKingdom, message | No mechanical effect, updates diplomatic memory |
| PASS | (none) | Do nothing |

One action per kingdom per tick.

---

## Simulation Loop Order (per tick)

```
1. Resource production    (tiles → kingdom stockpiles)
2. Resource consumption   (population + army → stockpile deductions)
3. Deficit/surplus update (ticksInDeficit tracking)
4. Population update      (growth/decline from food/water state)
5. Morale update          (modifiers applied)
6. Army upkeep + degradation
7. Perception generation  (one compact string per kingdom)
8. LLM calls              (Promise.all — all kingdoms concurrent)
9. Action validation      (engine rejects malformed actions → PASS fallback)
10. Action resolution     (trade, combat, expand, recruit, ration, negotiate)
11. Event logging         (structured events emitted)
12. Kingdom elimination check
13. TickResult assembled  (serialized, handed to output layer)
```

---

## Kingdom Elimination

A kingdom is eliminated (`alive: false`) when:
- (`population <= 1` AND `army <= 0`) OR the kingdom chooses to surrender OR all tiles are taken

On elimination:
- All tiles become neutral (not transferred to attacker automatically)
- Other kingdoms may EXPAND into them in subsequent ticks
- Eliminated kingdom no longer receives LLM calls
- Event logged: `KINGDOM_ELIMINATED`

It should also be noted, that the tiles taken is partially redundant, this would likely not be a real case due to the other conditions occuring before this.

---

## Terminal Output Format (v1)

Per tick, the terminal displays:
- Tick number + alive kingdom count
- Per-kingdom one-line summary: `[Name] pop:X army:X morale:X.X | food:X water:X materials:X`
- All events this tick as narrative strings
- A separator line between ticks

Full structured log exported to `sim_log.json` on completion.

---

## What This Is NOT

- Not a city builder — no internal city mechanics
- Not a tech tree game — no research or upgrades
- Not Risk — no dice-driven outcomes (except contested band)
- Not scripted — no hardcoded strategies or predefined behaviors
- Not a product — optimization is for simulation quality, not UX polish