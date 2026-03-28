# Geopolitical Simulation
 
A deterministic, terminal-first simulation where kingdoms (controlled by agents) interact under resource constraints. These agents do not have any specific instructions or goals. Rather, my hope was to create a world where external pressure caused different types of behaviors.
 
---
 
## What It Is
 
Five kingdoms compete for survival on a 7×7 tile map. Each is controlled by an LLM agent that receives a compact ~200 token snapshot of the world each tick and picks an action from a constrained schema. The engine resolves everything deterministically.
 
The agents are not told to expand, win, or conquer. They simply respond to scarcity.
 
What emerges: we will see. Hopefully cool stuff.
 
---
 
## How It Is Intended To Work
 
Each tick:
 
1. Tiles produce resources
2. Population and army consume resources
3. Deficits update — morale drops, populations decline, armies degrade
4. Each kingdom receives a perception string (~200 tokens)
5. All LLM agents are called concurrently
6. Actions are validated and resolved by the engine
7. Events are logged
8. Terminal output is rendered
 
The engine is pure and deterministic.
