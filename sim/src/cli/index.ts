import * as fs from "node:fs";
import * as readline from "node:readline";
import { SimConfig, TickResult, EventType } from "../core/types.js";
import { createAgentConfig } from "../agent/llm.js";
import type { AgentConfig } from "../agent/llm.js";
import { runSimulation } from "../loop/loop.js";
import {
  renderTick,
  renderElimination,
  renderEndSummary,
  buildSimLog,
  setRenderMode,
  setView,
  cycleKingdomDetail,
  scrollHistory,
  getViewState,
  type RenderMode,
} from "./renderer.js";
import { RESET } from "./colors.js";

// ─── CLI Arg Parsing ──────────────────────────────────────────────────────

interface CliFlags {
  step: boolean;
  fast: boolean;
  debug: boolean;
  ticks: number;
  seed: number;
  model: string | null;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    step: false,
    fast: false,
    debug: false,
    ticks: 100,
    seed: Date.now(),
    model: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--step":
        flags.step = true;
        break;
      case "--fast":
        flags.fast = true;
        break;
      case "--debug":
        flags.debug = true;
        break;
      case "--ticks":
        i++;
        flags.ticks = parseInt(argv[i], 10) || 100;
        break;
      case "--seed":
        i++;
        flags.seed = parseInt(argv[i], 10) || Date.now();
        break;
      case "--model":
        i++;
        flags.model = argv[i] ?? null;
        break;
    }
  }

  return flags;
}

function resolveRenderMode(flags: CliFlags): RenderMode {
  if (flags.fast) return "fast";
  if (flags.debug) return "debug";
  if (flags.step) return "step";
  return "normal";
}

// ─── Keyboard Handling ────────────────────────────────────────────────────

type KeyHandler = (key: string) => void;

let keyResolve: ((key: string) => void) | null = null;
let keyHandler: KeyHandler | null = null;

function setupKeyboard(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (data: string) => {
    for (const ch of data) {
      // Handle escape sequences for arrow keys
      if (data === "\x1b[A") {
        if (keyHandler) keyHandler("up");
        if (keyResolve) {
          const r = keyResolve;
          keyResolve = null;
          r("up");
        }
        return;
      }
      if (data === "\x1b[B") {
        if (keyHandler) keyHandler("down");
        if (keyResolve) {
          const r = keyResolve;
          keyResolve = null;
          r("down");
        }
        return;
      }

      if (keyHandler) keyHandler(ch);
      if (keyResolve) {
        const r = keyResolve;
        keyResolve = null;
        r(ch);
      }
    }
  });
}

function waitForKey(): Promise<string> {
  return new Promise<string>((resolve) => {
    keyResolve = resolve;
  });
}

// ─── Terminal Cleanup ─────────────────────────────────────────────────────

function cleanup(): void {
  // Show cursor
  process.stdout.write("\x1b[?25h");
  // Reset colors
  process.stdout.write(RESET);
  // Restore stdin
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

function setupCleanup(): void {
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    cleanup();
    console.error("Uncaught exception:", err);
    process.exit(1);
  });
}

// ─── Render Callback ──────────────────────────────────────────────────────

let quitRequested = false;
let lastTickResult: TickResult | null = null;

function createRenderCallback(
  mode: RenderMode,
): (result: TickResult) => Promise<void> {
  return async (result: TickResult): Promise<void> => {
    lastTickResult = result;

    // Check for elimination events — render banner
    for (const e of result.eventsThisTick) {
      if (e.eventType === EventType.KINGDOM_ELIMINATED) {
        await renderElimination(
          e.kingdomsInvolved[0],
          e.tick,
        );
      }
    }

    renderTick(result);

    if (mode === "fast") return;

    if (mode === "step") {
      // Wait for space to advance
      while (true) {
        const key = await waitForKey();
        if (handleViewKey(key, result)) continue;
        if (key === " ") break;
        if (key === "q" || key === "\x03") {
          quitRequested = true;
          break;
        }
      }
    } else {
      // In normal/debug mode, briefly check for keypresses (non-blocking)
      // We give a short window for view toggles
      await handleNonBlockingKeys(result);
    }
  };
}

function handleViewKey(key: string, result: TickResult): boolean {
  const state = getViewState();

  switch (key) {
    case "m":
      setView(state.currentView === "map" ? "dashboard" : "map");
      renderTick(result);
      return true;
    case "k": {
      const aliveCount = Object.values(result.gameState.kingdoms).filter(
        (k) => k.alive,
      ).length;
      if (state.currentView === "kingdom") {
        cycleKingdomDetail(aliveCount);
      } else {
        setView("kingdom");
      }
      renderTick(result);
      return true;
    }
    case "h":
      setView(state.currentView === "history" ? "dashboard" : "history");
      renderTick(result);
      return true;
    case "d":
      setView(state.currentView === "diplomacy" ? "dashboard" : "diplomacy");
      renderTick(result);
      return true;
    case "up":
      if (state.currentView === "history") {
        scrollHistory(-3);
        renderTick(result);
      }
      return true;
    case "down":
      if (state.currentView === "history") {
        scrollHistory(3);
        renderTick(result);
      }
      return true;
    default:
      return false;
  }
}

async function handleNonBlockingKeys(result: TickResult): Promise<void> {
  // Give a brief window to handle view toggle keys
  const timeout = new Promise<string>((resolve) =>
    setTimeout(() => resolve("__timeout__"), 50),
  );
  const key = await Promise.race([waitForKey(), timeout]);

  if (key === "__timeout__") return;
  if (key === "q" || key === "\x03") {
    quitRequested = true;
    return;
  }
  handleViewKey(key, result);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);
  const mode = resolveRenderMode(flags);

  // Validate API key early
  let agentConfig: AgentConfig;
  try {
    agentConfig = createAgentConfig(
      flags.model ? { model: flags.model } : undefined,
    );
  } catch (err) {
    console.error(
      (err as Error).message ??
        "Failed to create agent config. Is OPENROUTER_API_KEY or ANTHROPIC_API_KEY set?",
    );
    process.exit(1);
  }

  const simConfig: SimConfig = {
    maxTicks: flags.ticks,
    kingdomNames: ["Aldrath", "Verne", "Durath", "Mira", "Thessan"],
    seed: flags.seed,
  };

  // Setup
  setRenderMode(mode);
  setupCleanup();

  if (mode !== "fast") {
    setupKeyboard();
    // Hide cursor
    process.stdout.write("\x1b[?25l");

    console.log(`Seed: ${simConfig.seed}  Ticks: ${simConfig.maxTicks}  Provider: ${agentConfig.provider}  Model: ${agentConfig.model}`);
    console.log(`Mode: ${mode}  Press [q] to quit\n`);
  }

  const renderCallback = createRenderCallback(mode);

  // Run simulation with render callback
  await runSimulation(simConfig, agentConfig, renderCallback, () => quitRequested);

  // End-of-run reporting: print summary and persist the sim log JSON.
  if (lastTickResult) {
    const finalState = lastTickResult.gameState;
    renderEndSummary(finalState, simConfig);
    const log = buildSimLog(finalState, simConfig);
    const logPath = `sim_log_${simConfig.seed}_${Date.now()}.json`;
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    console.log(`Wrote ${logPath}`);
  }

  cleanup();
}

main().catch((err) => {
  cleanup();
  console.error("Fatal error:", err);
  process.exit(1);
});
