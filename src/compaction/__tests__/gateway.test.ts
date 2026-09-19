import { describe, it, expect } from 'vitest';
import {
  buildGatewayJevRequest,
  createGatewayAsker,
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_GATEWAY_MODEL,
  GATEWAY_BILLING_ERROR_MESSAGE,
  gatewayEvaluationUrl,
  gatewayModelId,
  isGatewayBillingError,
  parseGatewayJevResponse,
  toGatewayQuestions,
  toLibraryAnswers,
} from '../gateway.js';

describe('gatewayModelId', () => {
  it('defaults to typesafe-ai/jev', () => {
    expect(gatewayModelId()).toBe(DEFAULT_GATEWAY_MODEL);
    expect(gatewayModelId('')).toBe(DEFAULT_GATEWAY_MODEL);
  });

  it('maps TypeSafe aliases to the canonical Gateway id (only typesafe-ai/jev is listed)', () => {
    expect(gatewayModelId('jev')).toBe(DEFAULT_GATEWAY_MODEL);
    expect(gatewayModelId('jev-latest')).toBe(DEFAULT_GATEWAY_MODEL);
    expect(gatewayModelId('typesafe-ai/jev-latest')).toBe(DEFAULT_GATEWAY_MODEL);
    expect(gatewayModelId('typesafe-ai/jev')).toBe(DEFAULT_GATEWAY_MODEL);
  });

  it('prefixes an unknown bare id and leaves a non-alias Gateway id alone', () => {
    expect(gatewayModelId('jev-custom')).toBe('typesafe-ai/jev-custom');
    expect(gatewayModelId('acme/jev')).toBe('acme/jev');
  });
});

describe('gatewayEvaluationUrl', () => {
  it('appends /evaluation-model to the /v4/ai prefix', () => {
    expect(gatewayEvaluationUrl()).toBe(`${DEFAULT_GATEWAY_BASE_URL}/evaluation-model`);
    expect(gatewayEvaluationUrl('https://ai-gateway.vercel.sh/v4/ai/')).toBe(
      'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
    );
  });

  it('does not double-append when the caller already passed the evaluate path', () => {
    expect(gatewayEvaluationUrl('https://example.test/v4/ai/evaluation-model')).toBe(
      'https://example.test/v4/ai/evaluation-model',
    );
  });
});

describe('noul ↔ boolean mapping', () => {
  it('rewrites noul questions to boolean and leaves others alone', () => {
    expect(
      toGatewayQuestions({
        keep: { type: 'noul', instructions: 'keep?', criteria: { true: 'yes' } },
        pick: { type: 'choice', instructions: 'which?', criteria: { a: 'A' } },
      }),
    ).toEqual({
      keep: { type: 'boolean', instructions: 'keep?', criteria: { true: 'yes' } },
      pick: { type: 'choice', instructions: 'which?', criteria: { a: 'A' } },
    });
  });

  it('rewrites boolean.probability to noul and accepts a proxied noul (H5)', () => {
    expect(
      toLibraryAnswers({
        a: { type: 'boolean', probability: 0.81 },
        b: { type: 'noul', noul: 0.2 },
        c: { type: 'choice', choice: 'x' },
      }),
    ).toEqual({
      a: { type: 'noul', noul: 0.81 },
      b: { type: 'noul', noul: 0.2 },
      c: { type: 'choice', choice: 'x' },
    });
  });
});

describe('buildGatewayJevRequest', () => {
  it('posts evaluate shape, not System One / noul', () => {
    const request = buildGatewayJevRequest(
      { apiKey: 'gw-test', model: 'jev-latest' },
      { goal: 'fix the test' },
      { call_t1: { type: 'noul', instructions: 'keep the call?' } },
    );

    expect(request.url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    expect(request.method).toBe('POST');
    expect(request.headers.Authorization).toBe('Bearer gw-test');
    expect(request.headers['ai-model-id']).toBe(DEFAULT_GATEWAY_MODEL);
    expect(request.headers['ai-evaluation-model-specification-version']).toBe('4');
    expect(request.headers['ai-gateway-auth-method']).toBe('api-key');

    const body = JSON.parse(request.body) as {
      model?: string;
      state: unknown;
      questions: Record<string, { type: string }>;
    };
    expect(body.model).toBeUndefined();
    expect(body.state).toEqual({ goal: 'fix the test' });
    expect(body.questions.call_t1).toEqual({
      type: 'boolean',
      instructions: 'keep the call?',
    });
  });

  it('honors an explicit evaluation base URL', () => {
    const request = buildGatewayJevRequest(
      { apiKey: 'gw-test', baseUrl: 'https://gateway.example/v4/ai' },
      'state',
      {},
    );
    expect(request.url).toBe('https://gateway.example/v4/ai/evaluation-model');
  });
});

describe('parseGatewayJevResponse', () => {
  it('maps boolean answers to noul for the compact library', () => {
    const parsed = parseGatewayJevResponse(
      200,
      true,
      JSON.stringify({ answers: { q1: { type: 'boolean', probability: 0.42 } } }),
    );
    expect(parsed.answers.q1).toEqual({ type: 'noul', noul: 0.42 });
  });

  it('throws on HTTP errors, malformed JSON, and missing answers', () => {
    expect(() => parseGatewayJevResponse(401, false, 'nope')).toThrow(/401/);
    expect(() => parseGatewayJevResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseGatewayJevResponse(200, true, '{}')).toThrow(/missing answers/);
  });

  it('classifies the known Vercel credit-card 403 as account billing, not Caliber', () => {
    const body = 'AI Gateway requires a valid credit card on file';
    expect(isGatewayBillingError(403, body)).toBe(true);
    expect(isGatewayBillingError(402, 'payment method required')).toBe(true);
    expect(isGatewayBillingError(403, 'forbidden model')).toBe(false);
    expect(isGatewayBillingError(401, body)).toBe(false);
    expect(() => parseGatewayJevResponse(403, false, body)).toThrow(GATEWAY_BILLING_ERROR_MESSAGE);
    expect(() => parseGatewayJevResponse(403, false, body)).toThrow(/not a Caliber/);
  });
});

describe('createGatewayAsker', () => {
  it('drives a fake fetch and returns library noul answers', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const asker = createGatewayAsker({
      apiKey: 'gw-test',
      fetch: async (url, init) => {
        seen.push({
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: String(init?.body),
        });
        return new Response(
          JSON.stringify({ answers: { q1: { type: 'boolean', probability: 0.91 } } }),
          { status: 200 },
        );
      },
    });

    const response = await asker.ask('state', {
      q1: { type: 'noul', instructions: 'keep?' },
    });

    expect(response.answers.q1).toEqual({ type: 'noul', noul: 0.91 });
    expect(seen[0]?.url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    expect(seen[0]?.headers.Authorization).toBe('Bearer gw-test');
    expect(seen[0]?.headers['ai-evaluation-model-specification-version']).toBe('4');
    expect(seen[0]?.headers['ai-model-id']).toBe(DEFAULT_GATEWAY_MODEL);
    expect(seen[0]?.headers['ai-gateway-auth-method']).toBe('api-key');
    expect(JSON.parse(seen[0]?.body ?? '{}').questions.q1.type).toBe('boolean');
  });
});
