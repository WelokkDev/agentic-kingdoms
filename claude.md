# Geopolitical Simulation — Project Memory

A deterministic, terminal-first simulation where AI-controlled kingdoms interact under resource constraints. Behavior emerges from environmental pressure — no explicit goals, no scripted strategies.

See docs/design-decisions.md for locked design choices and their reasoning.

---

## Stack

- **Language**: TypeScript, strict mode (`strict: true`)
- **Runtime**: Node.js
- **LLM calls**: OpenRouter API (not Anthropic SDK directly)
- **No framework**: plain Node, no Express, no game engine
- **No external deps** unless absolutely necessary — prefer stdlib

---

## Project Structure

```
docs/
  design-decisions.md
sim/
  src/
    core/         ← types only (types.ts) — no logic
    engine/       ← pure functions: resource, combat, trade, population, army
    agent/        ← LLM perception serializer + action validator + OpenRouter caller
    loop/         ← tick orchestrator + event logger
    cli/          ← terminal runner, output formatting
claude.md
```

---

## Architecture Rules — Do Not Violate

These will cause silent breakage across the entire system if ignored.

**1. Engine functions are pure and synchronous.**
Every file in `src/engine/` takes state in, returns new state out. No side effects. No async. Same input always produces same output.

**2. GameState is always fully JSON-serializable.**
No Maps, no Sets, no classes, no functions anywhere in state. Plain objects and arrays only. `JSON.stringify(gameState)` must work with zero loss at all times — this is what makes the future web layer free.

**3. TickResult is the only external boundary.**
The terminal renderer and the future web layer both consume `TickResult` and nothing else. Never expose raw GameState or internal engine state to output layers.

**4. All LLM calls per tick are concurrent.**
Use `Promise.all` — never sequential `await` in a loop. Each kingdom's LLM call is independent.

**5. The engine never calls the LLM.**
The loop orchestrator calls agents, collects actions, then passes them to the engine. These are separate phases.

---

## Core Design Decisions (Locked)

**Resources: exactly 3.** FOOD, WATER, MATERIALS.

**Map**: 7×7 grid, 5 kingdoms, ~14 neutral tiles. Adjacency is 4-directional (no diagonals).

**Combat outcomes** are near-deterministic by ratio band. Randomness only in the contested band (ratio 0.8–1.3).

See docs/design-decisions.md for full physics spec (resource yields, combat ratios, morale modifiers, population math).

---

## TypeScript Conventions

- `interface` for all data structures, `enum` for categoricals, `type` for unions
- camelCase fields, PascalCase types
- No classes anywhere — this is a data-transformation pipeline, not OOP
- Explicit return types on all engine functions
- Never use `any` — use `unknown` + narrowing if type is genuinely uncertain

---

## What Claude Gets Wrong On This Project
- **Making engine functions async.** Resource math, combat, trade resolution — all synchronous. Only the LLM call boundary is async.
- **Putting logic in types.ts.** `src/core/types.ts` is data shapes only. Zero logic, zero methods.
- **Sequential LLM calls.** Always `Promise.all`, never `for...of` with `await`.