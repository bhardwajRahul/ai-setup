import { DEFAULT_GATEWAY_BASE_URL, gatewayModelId } from './gateway.js';

export type JevTransportKind = 'gateway' | 'typesafe';

export interface JevCredentialInput {
  /** Explicit TypeSafe System One key. */
  apiKey?: string;
  /** Explicit Vercel AI Gateway key. A Gateway key is not a TypeSafe key. */
  gatewayApiKey?: string;
  /** Override the Gateway evaluation prefix (`https://ai-gateway.vercel.sh/v4/ai`). */
  gatewayBaseUrl?: string;
  model?: string;
}

export interface JevEnvLookup {
  AI_GATEWAY_API_KEY?: string;
  TYPESAFE_API_KEY?: string;
}

export interface ResolvedJevCredentials {
  kind: JevTransportKind;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export const MISSING_JEV_KEY_MESSAGE =
  'Jev compaction needs your own key. A Vercel AI Gateway key is not a TypeSafe key. ' +
  'Set AI_GATEWAY_API_KEY (https://vercel.com/docs/ai-gateway/authentication-and-byok) ' +
  'or TYPESAFE_API_KEY (https://typesafe.ai) and retry. Caliber does not provide a key.';

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function gatewayCredentials(apiKey: string, input: JevCredentialInput): ResolvedJevCredentials {
  const resolved: ResolvedJevCredentials = {
    kind: 'gateway',
    apiKey,
    model: gatewayModelId(input.model),
  };
  if (nonEmpty(input.gatewayBaseUrl)) resolved.baseUrl = input.gatewayBaseUrl;
  else resolved.baseUrl = DEFAULT_GATEWAY_BASE_URL;
  return resolved;
}

function typesafeCredentials(apiKey: string, input: JevCredentialInput): ResolvedJevCredentials {
  const resolved: ResolvedJevCredentials = { kind: 'typesafe', apiKey };
  if (nonEmpty(input.model)) resolved.model = input.model;
  return resolved;
}

/**
 * Auth order for every Caliber Jev surface:
 *   1. explicit `gatewayApiKey`
 *   2. explicit TypeSafe `apiKey`
 *   3. `AI_GATEWAY_API_KEY` → Gateway
 *   4. `TYPESAFE_API_KEY` → direct TypeSafe
 */
export function resolveJevCredentials(
  input: JevCredentialInput = {},
  env: JevEnvLookup = process.env,
): ResolvedJevCredentials | undefined {
  if (nonEmpty(input.gatewayApiKey)) return gatewayCredentials(input.gatewayApiKey, input);
  if (nonEmpty(input.apiKey)) return typesafeCredentials(input.apiKey, input);
  if (nonEmpty(env.AI_GATEWAY_API_KEY)) {
    return gatewayCredentials(env.AI_GATEWAY_API_KEY, input);
  }
  if (nonEmpty(env.TYPESAFE_API_KEY)) {
    return typesafeCredentials(env.TYPESAFE_API_KEY, input);
  }
  return undefined;
}
