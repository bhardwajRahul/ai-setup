import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_GATEWAY_MODEL } from '../gateway.js';
import { MISSING_JEV_KEY_MESSAGE, resolveJevCredentials } from '../transport.js';

describe('resolveJevCredentials', () => {
  const originalGateway = process.env.AI_GATEWAY_API_KEY;
  const originalTypesafe = process.env.TYPESAFE_API_KEY;

  afterEach(() => {
    if (originalGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalGateway;
    if (originalTypesafe === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalTypesafe;
  });

  it('prefers an explicit Gateway key over everything else', () => {
    const creds = resolveJevCredentials(
      { gatewayApiKey: 'gw-opt', apiKey: 'ts-opt', model: 'jev-latest' },
      { AI_GATEWAY_API_KEY: 'gw-env', TYPESAFE_API_KEY: 'ts-env' },
    );
    expect(creds).toEqual({
      kind: 'gateway',
      apiKey: 'gw-opt',
      model: 'typesafe-ai/jev-latest',
      baseUrl: 'https://ai-gateway.vercel.sh/v4/ai',
    });
  });

  it('uses an explicit TypeSafe key before any env', () => {
    const creds = resolveJevCredentials(
      { apiKey: 'ts-opt' },
      { AI_GATEWAY_API_KEY: 'gw-env', TYPESAFE_API_KEY: 'ts-env' },
    );
    expect(creds).toEqual({ kind: 'typesafe', apiKey: 'ts-opt' });
  });

  it('picks AI_GATEWAY_API_KEY over TYPESAFE_API_KEY', () => {
    const creds = resolveJevCredentials(
      {},
      { AI_GATEWAY_API_KEY: 'gw-env', TYPESAFE_API_KEY: 'ts-env' },
    );
    expect(creds?.kind).toBe('gateway');
    expect(creds?.apiKey).toBe('gw-env');
    expect(creds?.model).toBe(DEFAULT_GATEWAY_MODEL);
  });

  it('falls back to TYPESAFE_API_KEY when no Gateway key is present', () => {
    const creds = resolveJevCredentials({ model: 'jev-pinned' }, { TYPESAFE_API_KEY: 'ts-env' });
    expect(creds).toEqual({ kind: 'typesafe', apiKey: 'ts-env', model: 'jev-pinned' });
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveJevCredentials({}, {})).toBeUndefined();
  });

  it('reads process.env when no lookup is passed', () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.TYPESAFE_API_KEY = 'from-process';
    expect(resolveJevCredentials()?.apiKey).toBe('from-process');
  });
});

describe('MISSING_JEV_KEY_MESSAGE', () => {
  it('tells the user a Gateway key is not a TypeSafe key', () => {
    expect(MISSING_JEV_KEY_MESSAGE).toMatch(/not a TypeSafe key/);
    expect(MISSING_JEV_KEY_MESSAGE).toMatch(/AI_GATEWAY_API_KEY/);
    expect(MISSING_JEV_KEY_MESSAGE).toMatch(/TYPESAFE_API_KEY/);
    expect(MISSING_JEV_KEY_MESSAGE).toMatch(/Caliber does not provide a key/);
  });
});
