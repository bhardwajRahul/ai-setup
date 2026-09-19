/**
 * Lean Vercel AI Gateway transport for TypeSafe Jev.
 *
 * Evaluation is not on the OpenAI-compatible `/v1` chat endpoints. The
 * published `@ai-sdk/gateway` client (4.x) posts to
 * `${baseURL}/evaluation-model` with default
 * `baseURL = https://ai-gateway.vercel.sh/v4/ai`.
 *
 * Protocol (confirmed from that client + Vercel evaluation docs):
 *   POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
 *   headers: Authorization Bearer, ai-evaluation-model-specification-version: 4,
 *            ai-model-id, ai-gateway-protocol-version, ai-gateway-auth-method
 *   body:    { state, questions }  — questions use AI SDK `boolean`, not `noul`
 *   answers: { type: 'boolean', probability }
 *
 * The vendored compact library still speaks TypeSafe System One (`noul`).
 * This module maps noul ↔ boolean so the library does not change.
 *
 * Hypotheses left open against a live Gateway:
 *   H5 — if Gateway ever proxied System One `noul` answers unchanged, accept them.
 *   H6 — auth-method / protocol-version headers match the official SDK; extra
 *        headers should be ignored if the host treats them as optional.
 */

export const DEFAULT_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';
export const DEFAULT_GATEWAY_MODEL = 'typesafe-ai/jev';
export const GATEWAY_PROTOCOL_VERSION = '0.0.1';

/**
 * TypeSafe System One ids (`jev`, `jev-latest`) and the stale Gateway alias
 * `typesafe-ai/jev-latest`. Public `GET /v1/models` only lists `typesafe-ai/jev`.
 */
const GATEWAY_JEV_ALIASES = new Set(['jev', 'jev-latest', 'typesafe-ai/jev-latest']);

export const GATEWAY_BILLING_ERROR_MESSAGE =
  'Vercel AI Gateway rejected this request because the Vercel account has no payment method. ' +
  'HTTP 403 "AI Gateway requires a valid credit card on file" is Vercel account billing, ' +
  'not a Caliber protocol/auth bug. Add a credit card at https://vercel.com/docs/pricing/billing ' +
  'then retry `npm run e2e:jev:gateway`.';

export interface GatewayJevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface GatewayJevRequestParams {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/** Map TypeSafe / alias ids to the canonical Gateway evaluation model. */
export function gatewayModelId(model?: string): string {
  if (!model || model.length === 0) return DEFAULT_GATEWAY_MODEL;
  if (GATEWAY_JEV_ALIASES.has(model)) return DEFAULT_GATEWAY_MODEL;
  if (model.includes('/')) return model;
  return `typesafe-ai/${model}`;
}

/** Evaluation URL. `baseUrl` is the `/v4/ai` prefix, not OpenAI-compat `/v1`. */
export function gatewayEvaluationUrl(baseUrl?: string): string {
  const base = (baseUrl ?? DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, '');
  if (base.endsWith('/evaluation-model')) return base;
  return `${base}/evaluation-model`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Library `noul` questions become AI SDK `boolean` questions. */
export function toGatewayQuestions(questions: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, raw]) => {
      if (!isRecord(raw) || raw.type !== 'noul') return [id, raw];
      const mapped: Record<string, unknown> = {
        type: 'boolean',
        instructions: raw.instructions,
      };
      if (raw.criteria !== undefined) mapped.criteria = raw.criteria;
      return [id, mapped];
    }),
  );
}

/** Gateway `boolean.probability` (or a proxied `noul`) back to library `noul`. */
export function toLibraryAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, raw]) => {
      if (!isRecord(raw)) return [id, raw];
      if (raw.type === 'boolean' && typeof raw.probability === 'number') {
        return [id, { type: 'noul', noul: raw.probability }];
      }
      if (typeof raw.noul === 'number') {
        return [id, { type: 'noul', noul: raw.noul }];
      }
      return [id, raw];
    }),
  );
}

export function buildGatewayJevRequest(
  params: GatewayJevRequestParams,
  state: unknown,
  questions: Record<string, unknown>,
): GatewayJevRequest {
  const model = gatewayModelId(params.model);
  return {
    url: gatewayEvaluationUrl(params.baseUrl),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
      'ai-evaluation-model-specification-version': '4',
      'ai-model-id': model,
      'ai-gateway-protocol-version': GATEWAY_PROTOCOL_VERSION,
      'ai-gateway-auth-method': 'api-key',
    },
    body: JSON.stringify({
      state,
      questions: toGatewayQuestions(questions),
    }),
  };
}

export interface GatewayJevResponse {
  answers: Record<string, unknown>;
  [key: string]: unknown;
}

/** True when Gateway rejected the call for account billing, not protocol. */
export function isGatewayBillingError(status: number, text: string): boolean {
  if (status !== 402 && status !== 403) return false;
  return /credit card|payment method|billing|on file/i.test(text);
}

export function parseGatewayJevResponse(
  status: number,
  ok: boolean,
  text: string,
): GatewayJevResponse {
  if (!ok) {
    if (isGatewayBillingError(status, text)) {
      throw new Error(`${GATEWAY_BILLING_ERROR_MESSAGE} Upstream: ${text.slice(0, 160)}`);
    }
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (!isRecord(parsed) || !('answers' in parsed) || !isRecord(parsed.answers)) {
    throw new Error('Jev response is missing answers');
  }
  return {
    ...parsed,
    answers: toLibraryAnswers(parsed.answers),
  };
}

export interface GatewayAskerOptions extends GatewayJevRequestParams {
  fetch?: typeof fetch;
}

/** A `JevAsker` over `fetch` that speaks Gateway evaluate and returns `noul`. */
export function createGatewayAsker(options: GatewayAskerOptions): {
  ask: (state: unknown, questions: Record<string, unknown>) => Promise<GatewayJevResponse>;
} {
  const fetcher = options.fetch ?? fetch;
  return {
    async ask(state, questions) {
      const request = buildGatewayJevRequest(options, state, questions);
      const response = await fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseGatewayJevResponse(response.status, response.ok, await response.text());
    },
  };
}
