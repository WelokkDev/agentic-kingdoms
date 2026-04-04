import { Action, GameState } from "../core/types.js";
import { generatePerception } from "./perception.js";
import {
  validateAction,
  parseActionFromLLMResponse,
  getFallbackAction,
} from "../engine/actions.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AgentConfig {
  model: string;
  timeoutMs: number;
  maxRetries: number;
  apiKey: string;
}

interface OpenRouterRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the ruler of a kingdom. Each turn you will receive a report of your kingdom's current state.
Respond with exactly one JSON action from the schema below. No explanation. No chain of thought. Just the JSON object.

MECHANICS:
RECRUIT: recruits 5 soldiers. Costs food:5 + materials:10 total. Army cannot exceed population.
ATTACK: costs food:5 + materials:3 upfront regardless of outcome. Captures one
  border tile on decisive or marginal win. You must own a tile adjacent to target.
EXPAND: free. Claims one adjacent neutral tile immediately.
RATION: reduces food and water consumption by 30% this tick. Morale -0.15.
TRADE_OFFER: propose resource exchange. Target has 2 ticks to respond or it expires.
TRADE_ACCEPT: accept an outstanding offer shown in your OFFERS section.
NEGOTIATE: sends a message. No immediate mechanical effect.
Tile types: farmland→food, mountain→materials, river/wetland→water, coastal→food+water (Thessan gets +20% on received trades)
Deficit reduces population each tick. Army requires food+materials to avoid desertion.
War exhaustion: morale and materials drain each tick you remain AT_WAR.

ACTION SCHEMA:
{ "actionType": "PASS" }
{ "actionType": "RATION" }
{ "actionType": "RECRUIT" }
{ "actionType": "EXPAND", "targetTileId": "<id>" }
{ "actionType": "ATTACK", "targetKingdom": "<name>", "targetTileId": "<id>" }
{ "actionType": "NEGOTIATE", "targetKingdom": "<name>", "message": "<text>" }
{ "actionType": "TRADE_OFFER", "targetKingdom": "<name>", "offer": {"food":0,"water":0,"materials":0}, "request": {"food":0,"water":0,"materials":0} }
{ "actionType": "TRADE_ACCEPT", "targetKingdom": "<name>" }
{ "actionType": "TRADE_REJECT", "targetKingdom": "<name>" }

Rules:
- Respond with one JSON object only
- targetTileId must be a tile ID visible in your BORDERS section
- targetKingdom must be a kingdom name visible in your perception
- offer and request must have at least one non-zero value between them
Resource deficit kills population. Population collapse eliminates your kingdom.
Inaction during deficit accelerates collapse. PASS is always available but is
rarely the right choice.`;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const RETRY_DELAY_MS = 500;

// ─── Config Factory ────────────────────────────────────────────────────────

export function createAgentConfig(
  overrides?: Partial<AgentConfig>,
): AgentConfig {
  const config: AgentConfig = {
    model: "google/gemini-flash-1.5",
    timeoutMs: 8000,
    maxRetries: 1,
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    ...overrides,
  };

  if (!config.apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY environment variable is required but not set.",
    );
  }

  return config;
}

// ─── Pure Helpers ──────────────────────────────────────────────────────────

export function buildRequestBody(
  perception: string,
  config: AgentConfig,
): OpenRouterRequest {
  return {
    model: config.model,
    max_tokens: 150,
    temperature: 0.7,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: perception },
    ],
  };
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

// ─── Logging ───────────────────────────────────────────────────────────────

export function logAgentCall(
  kingdomName: string,
  tick: number,
  success: boolean,
  fallbackReason?: string,
): void {
  const verbose = process.env.VERBOSE === "true";
  if (success && !verbose) return;

  const pad = kingdomName.padEnd(12);
  if (success) {
    console.log(`[tick:${tick}] ${pad} → action received   (success)`);
  } else {
    console.log(
      `[tick:${tick}] ${pad} → FALLBACK: ${fallbackReason ?? "unknown"}`,
    );
  }
}

// ─── Core API Call ─────────────────────────────────────────────────────────

async function fetchFromOpenRouter(
  body: OpenRouterRequest,
  config: AgentConfig,
): Promise<string | null> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? null;
}

async function fetchWithRetry(
  body: OpenRouterRequest,
  config: AgentConfig,
): Promise<{ content: string | null; failReason: string | null }> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const content = await fetchFromOpenRouter(body, config);
      if (content === null) {
        return { content: null, failReason: "non-200 response" };
      }
      return { content, failReason: null };
    } catch {
      if (attempt < config.maxRetries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { content: null, failReason: "network error after retry" };
    }
  }

  return { content: null, failReason: "network error" };
}

// ─── Agent Call ────────────────────────────────────────────────────────────

export async function callAgent(
  kingdomName: string,
  perception: string,
  config: AgentConfig,
  gameState: GameState,
  tick: number,
): Promise<Action> {
  const fallback = getFallbackAction(kingdomName);
  const body = buildRequestBody(perception, config);

  const result = await withTimeout(
    fetchWithRetry(body, config),
    config.timeoutMs,
    { content: null, failReason: `timeout after ${config.timeoutMs}ms` },
  );

  if (result.content === null) {
    logAgentCall(kingdomName, tick, false, result.failReason ?? "empty response");
    return fallback;
  }

  const parsed = parseActionFromLLMResponse(result.content, kingdomName);
  if (parsed === null) {
    const truncated = result.content.slice(0, 100);
    logAgentCall(kingdomName, tick, false, `unparseable JSON: "${truncated}"`);
    return fallback;
  }

  // Inject sourceKingdom — the LLM doesn't send it
  if (typeof parsed === "object" && parsed !== null) {
    (parsed as Record<string, unknown>).sourceKingdom = kingdomName;
  }

  const validated = validateAction(parsed, gameState);
  if (validated === null) {
    const actionType =
      typeof parsed === "object" && parsed !== null
        ? String((parsed as Record<string, unknown>).actionType ?? "unknown")
        : "unknown";
    logAgentCall(
      kingdomName,
      tick,
      false,
      `invalid action type "${actionType}"`,
    );
    return fallback;
  }

  logAgentCall(kingdomName, tick, true);
  return validated;
}

// ─── Batch Call ────────────────────────────────────────────────────────────

export async function callAllAgents(
  gameState: GameState,
  config: AgentConfig,
): Promise<Record<string, Action>> {
  const aliveKingdoms = Object.values(gameState.kingdoms).filter(
    (k) => k.alive,
  );

  const entries = await Promise.all(
    aliveKingdoms.map(async (kingdom): Promise<[string, Action]> => {
      try {
        const perception = generatePerception(kingdom.name, gameState);
        const action = await callAgent(
          kingdom.name,
          perception,
          config,
          gameState,
          gameState.tick,
        );
        return [kingdom.name, action];
      } catch {
        return [kingdom.name, getFallbackAction(kingdom.name)];
      }
    }),
  );

  const result: Record<string, Action> = {};
  for (const [name, action] of entries) {
    result[name] = action;
  }
  return result;
}

export default callAllAgents;
