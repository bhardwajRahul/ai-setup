import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AtlasCloudProvider, ATLASCLOUD_DEFAULT_BASE_URL } from '../atlascloud.js';
import type { LLMConfig } from '../types.js';

const createMock = vi.fn();
const listMock = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: createMock } };
      models = { list: listMock };
      constructor(public opts: Record<string, unknown>) {}
    },
  };
});

vi.mock('../usage.js', () => ({ trackUsage: vi.fn() }));

import OpenAI from 'openai';

const BASE_CONFIG: LLMConfig = {
  provider: 'atlascloud',
  model: 'deepseek-ai/deepseek-v4-pro',
  apiKey: 'atlas-key',
};

describe('AtlasCloudProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.ATLASCLOUD_API_KEY;
    delete process.env.ATLAS_CLOUD_API_KEY;
    delete process.env.ATLASCLOUD_BASE_URL;
    delete process.env.ATLAS_CLOUD_BASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('constructor passes apiKey and Atlas Cloud base URL to OpenAI client', () => {
    const provider = new AtlasCloudProvider(BASE_CONFIG);
    const instance = (provider as unknown as { client: InstanceType<typeof OpenAI> }).client;
    const opts = (instance as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts.apiKey).toBe('atlas-key');
    expect(opts.baseURL).toBe(ATLASCLOUD_DEFAULT_BASE_URL);
  });

  it('constructor supports ATLAS_CLOUD_API_KEY env alias when config has no apiKey', () => {
    process.env.ATLAS_CLOUD_API_KEY = 'alias-key';
    const provider = new AtlasCloudProvider({
      provider: 'atlascloud',
      model: 'deepseek-ai/deepseek-v4-pro',
    });
    const instance = (provider as unknown as { client: InstanceType<typeof OpenAI> }).client;
    const opts = (instance as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts.apiKey).toBe('alias-key');
  });

  it('constructor supports ATLASCLOUD_BASE_URL env var when config has no baseUrl', () => {
    process.env.ATLASCLOUD_BASE_URL = 'https://gateway.example.com/v1';
    const provider = new AtlasCloudProvider(BASE_CONFIG);
    const instance = (provider as unknown as { client: InstanceType<typeof OpenAI> }).client;
    const opts = (instance as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts.baseURL).toBe('https://gateway.example.com/v1');
  });

  it('listModels() falls back to known Atlas Cloud chat models when listing fails', async () => {
    listMock.mockRejectedValue(new Error('listing unavailable'));
    const provider = new AtlasCloudProvider(BASE_CONFIG);
    await expect(provider.listModels()).resolves.toEqual([
      'deepseek-ai/deepseek-v4-pro',
      'deepseek-ai/deepseek-v4-flash',
      'qwen/qwen3.5-27b',
    ]);
  });
});
