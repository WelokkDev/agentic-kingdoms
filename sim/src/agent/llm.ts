import { Action, GameState } from "../core/types.js";
import { generatePerception } from "./perception.js";
import {
  validateActionDetailed,
  parseActionFromLLMResponse,
  getFallbackAction,
} from "../engine/actions.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type Provider = "openrouter" | "anthropic";

export interface AgentConfig {
  provider: Provider;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  apiKey: string;
  /** Required for identity-linked Anthropic API keys; null otherwise. */
  workspaceId: string | null;
}

interface OpenRouterRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}

type LLMRequest = OpenRouterRequest | AnthropicRequest;

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
FORTIFY: costs materials:5. Strengthens one owned border tile defense for 5 ticks.
THREATEN: demand resources from a kingdom. Sets relationship to HOSTILE. Target sees it in OFFERS.
AID: send resources to another kingdom with no return. Builds goodwill.
Tile types: farmland→food, mountain→materials, river/wetland→water, coastal→food+water (Thessan gets +20% on received trades)
Deficit reduces population each tick. Army requires food+materials to avoid desertion.
War exhaustion: morale and materials drain each tick you remain AT_WAR.

ACTION SCHEMA:
{ "actionType": "RATION" }
{ "actionType": "RECRUIT" }
{ "actionType": "EXPAND", "targetTileId": "<id>" }
{ "actionType": "ATTACK", "targetKingdom": "<name>", "targetTileId": "<id>" }
{ "actionType": "NEGOTIATE", "targetKingdom": "<name>", "message": "<text>" }
{ "actionType": "TRADE_OFFER", "targetKingdom": "<name>", "offer": {"food":0,"water":0,"materials":0}, "request": {"food":0,"water":0,"materials":0} }
{ "actionType": "TRADE_ACCEPT", "targetKingdom": "<name>" }
{ "actionType": "TRADE_REJECT", "targetKingdom": "<name>" }
{ "actionType": "FORTIFY", "targetTileId": "<owned_border_tile_id>" }
{ "actionType": "THREATEN", "targetKingdom": "<name>", "request": {"food":0,"water":0,"materials":0}, "message": "<optional ultimatum>" }
{ "actionType": "AID", "targetKingdom": "<name>", "offer": {"food":0,"water":0,"materials":0} }

Rules:
- Respond with one JSON object only
- You MUST choose an actionType from the VALID ACTIONS list in your report
- LAST TICK shows the outcome of your previous order — if it was rejected, do not repeat it unchanged
- TRADE_OFFER locks your offered resources in escrow until accepted (delivered), rejected, or expired after 2 ticks (refunded). You can only offer what you currently hold.
- targetTileId must be a tile ID visible in your BORDERS section
- targetKingdom must be a kingdom name visible in your perception
- offer and request must have at least one non-zero value between them
Resource deficit kills population. Population collapse eliminates your kingdom.
Inaction during deficit accelerates collapse. You must act every tick.`;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const RETRY_DELAY_MS = 500;

const DEFAULT_MODELS: Record<Provider, string> = {
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  anthropic: "claude-haiku-4-5",
};

const KEY_NAMES: Record<Provider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

// Sampling params (temperature/top_p/top_k) were removed on these Anthropic
// model families — sending temperature returns HTTP 400. Haiku 4.5 and the
// OpenRouter models still accept it. Matched with includes() so a slug like
// "anthropic/claude-opus-5" is caught on the OpenRouter path too.
const NO_SAMPLING_MODELS = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
];

// ─── Config Factory ────────────────────────────────────────────────────────

function readApiKey(provider: Provider): string {
  if (provider === "openrouter") {
    return process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY ?? "";
  }
  return process.env.ANTHROPIC_API_KEY ?? "";
}

// LLM_PROVIDER wins when set. Otherwise pick by whichever key is present,
// OpenRouter first. The explicit override exists so a typo'd OpenRouter key
// name cannot silently fall through onto the paid Anthropic path.
export function resolveProvider(): Provider | null {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === "openrouter" || explicit === "anthropic") {
    return explicit;
  }
  if (readApiKey("openrouter")) return "openrouter";
  if (readApiKey("anthropic")) return "anthropic";
  return null;
}

export function createAgentConfig(
  overrides?: Partial<AgentConfig>,
): AgentConfig {
  const provider = overrides?.provider ?? resolveProvider();

  if (provider === null) {
    throw new Error(
      "No LLM API key found. Set OPENROUTER_API_KEY (or OPENROUTER_KEY) to use " +
        "OpenRouter, or ANTHROPIC_API_KEY to use Anthropic directly. " +
        "Set LLM_PROVIDER=openrouter|anthropic to choose explicitly.",
    );
  }

  const apiKey = overrides?.apiKey ?? readApiKey(provider);
  if (!apiKey) {
    throw new Error(
      `Provider resolved to "${provider}" but ${KEY_NAMES[provider]} is not set.`,
    );
  }

  return {
    provider,
    model: DEFAULT_MODELS[provider],
    timeoutMs: 15000,
    maxRetries: 2,
    apiKey,
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? null,
    ...overrides,
  };
}

// ─── Pure Helpers ──────────────────────────────────────────────────────────

export function supportsSampling(model: string): boolean {
  return !NO_SAMPLING_MODELS.some((m) => model.includes(m));
}

export function buildRequestBody(
  perception: string,
  config: AgentConfig,
): LLMRequest {
  const temperature = supportsSampling(config.model) ? 0.7 : undefined;

  if (config.provider === "anthropic") {
    return {
      model: config.model,
      max_tokens: 400,
      ...(temperature === undefined ? {} : { temperature }),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: perception }],
    };
  }

  return {
    model: config.model,
    max_tokens: 400,
    ...(temperature === undefined ? {} : { temperature }),
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

function requestHeaders(config: AgentConfig): Record<string, string> {
  if (config.provider === "anthropic") {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    // Identity-linked API keys reject requests without a workspace id
    if (config.workspaceId) {
      headers["anthropic-workspace-id"] = config.workspaceId;
    }
    return headers;
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
}

function extractContent(provider: Provider, data: unknown): string | null {
  if (provider === "anthropic") {
    const body = data as { content?: Array<{ type?: string; text?: string }> };
    return body.content?.find((b) => b.type === "text")?.text ?? null;
  }

  const body = data as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? null;
}

async function fetchFromProvider(
  body: LLMRequest,
  config: AgentConfig,
): Promise<{ content: string | null; status: number; errorDetail: string | null }> {
  const url = config.provider === "anthropic" ? ANTHROPIC_URL : OPENROUTER_URL;

  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders(config),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Surface the API's error message — a bare status code hides the cause
    let errorDetail: string | null = null;
    try {
      const errBody = (await response.json()) as {
        error?: { message?: string };
      };
      errorDetail = errBody.error?.message?.slice(0, 140) ?? null;
    } catch {
      // Non-JSON error body — leave detail null
    }
    return { content: null, status: response.status, errorDetail };
  }

  const data = (await response.json()) as unknown;
  return {
    content: extractContent(config.provider, data),
    status: response.status,
    errorDetail: null,
  };
}

async function fetchWithRetry(
  body: LLMRequest,
  config: AgentConfig,
): Promise<{ content: string | null; failReason: string | null }> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fetchFromProvider(body, config);
      if (result.content !== null) {
        return { content: result.content, failReason: null };
      }
      // Retry on 429 (rate limit), 503, and 529 (overloaded) — transient
      if (
        (result.status === 429 || result.status === 503 || result.status === 529) &&
        attempt < config.maxRetries
      ) {
        const backoff = RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return {
        content: null,
        failReason: result.errorDetail
          ? `HTTP ${result.status}: ${result.errorDetail}`
          : `HTTP ${result.status}`,
      };
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

export interface AgentTurn {
  action: Action;
  /** Non-null when the agent's order failed and RATION was substituted. Fed into next tick's perception. */
  feedback: string | null;
}

export async function callAgent(
  kingdomName: string,
  perception: string,
  config: AgentConfig,
  gameState: GameState,
  tick: number,
): Promise<AgentTurn> {
  const fallback = getFallbackAction(kingdomName);
  const body = buildRequestBody(perception, config);

  const result = await withTimeout(
    fetchWithRetry(body, config),
    config.timeoutMs,
    { content: null, failReason: `timeout after ${config.timeoutMs}ms` },
  );

  if (result.content === null) {
    const reason = result.failReason ?? "empty response";
    logAgentCall(kingdomName, tick, false, reason);
    return {
      action: fallback,
      feedback: `your order was lost (${reason}) — RATION executed by default`,
    };
  }

  const parsed = parseActionFromLLMResponse(result.content, kingdomName);
  if (parsed === null) {
    const truncated = result.content.slice(0, 100);
    logAgentCall(kingdomName, tick, false, `unparseable JSON: "${truncated}"`);
    return {
      action: fallback,
      feedback:
        "your previous response was not a parseable JSON action — RATION executed by default",
    };
  }

  // Inject sourceKingdom — the LLM doesn't send it
  if (typeof parsed === "object" && parsed !== null) {
    (parsed as Record<string, unknown>).sourceKingdom = kingdomName;
  }

  const { action: validated, reason } = validateActionDetailed(parsed, gameState);
  if (validated === null) {
    logAgentCall(kingdomName, tick, false, `rejected: ${reason}`);
    return {
      action: fallback,
      feedback: `your order was rejected (${reason}) — RATION executed instead`,
    };
  }

  logAgentCall(kingdomName, tick, true);
  return { action: validated, feedback: null };
}

// ─── Batch Call ────────────────────────────────────────────────────────────

export interface AgentPhaseResult {
  actions: Record<string, Action>;
  /** Per-kingdom failure feedback for orders that fell back to RATION. */
  feedback: Record<string, string>;
}

export async function callAllAgents(
  gameState: GameState,
  config: AgentConfig,
): Promise<AgentPhaseResult> {
  const aliveKingdoms = Object.values(gameState.kingdoms).filter(
    (k) => k.alive,
  );

  const entries = await Promise.all(
    aliveKingdoms.map(async (kingdom): Promise<[string, AgentTurn]> => {
      try {
        const perception = generatePerception(kingdom.name, gameState);
        const turn = await callAgent(
          kingdom.name,
          perception,
          config,
          gameState,
          gameState.tick,
        );
        return [kingdom.name, turn];
      } catch {
        return [
          kingdom.name,
          {
            action: getFallbackAction(kingdom.name),
            feedback: "your order was lost (internal error) — RATION executed by default",
          },
        ];
      }
    }),
  );

  const actions: Record<string, Action> = {};
  const feedback: Record<string, string> = {};
  for (const [name, turn] of entries) {
    actions[name] = turn.action;
    if (turn.feedback !== null) {
      feedback[name] = turn.feedback;
    }
  }
  return { actions, feedback };
}

export default callAllAgents;
