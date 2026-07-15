import type { LLMConfig, LLMProvider } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const MINIMAX_ENDPOINTS = {
  global_en: {
    openai: 'https://api.minimax.io/v1',
    anthropic: 'https://api.minimax.io/anthropic',
  },
  cn_zh: {
    openai: 'https://api.minimaxi.com/v1',
    anthropic: 'https://api.minimaxi.com/anthropic',
  },
} as const;

const MINIMAX_MODELS = ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'];

function resolveMiniMaxConfig(config: LLMConfig): LLMConfig {
  return {
    ...config,
    apiKey: config.apiKey ?? process.env.MINIMAX_API_KEY,
    baseUrl: config.baseUrl ?? process.env.MINIMAX_BASE_URL ?? MINIMAX_ENDPOINTS.global_en.openai,
  };
}

function isAnthropicCompatibleBaseUrl(baseUrl: string | undefined): boolean {
  return /\/anthropic\/?$/.test(baseUrl ?? '');
}

export class MiniMaxProvider extends OpenAICompatProvider {
  constructor(config: LLMConfig) {
    super(
      resolveMiniMaxConfig(config),
      // MiniMax requires temperature in (0.0, 1.0] — 1.0 is the only safe default.
      { temperature: 1.0 },
    );
  }

  // MiniMax API doesn't support model listing; return known models statically.
  override async listModels(): Promise<string[]> {
    return [...MINIMAX_MODELS];
  }
}

export class MiniMaxAnthropicProvider extends AnthropicProvider {
  constructor(config: LLMConfig) {
    super(resolveMiniMaxConfig(config));
  }

  override async listModels(): Promise<string[]> {
    return [...MINIMAX_MODELS];
  }
}

export function createMiniMaxProvider(config: LLMConfig): LLMProvider {
  const resolvedConfig = resolveMiniMaxConfig(config);
  return isAnthropicCompatibleBaseUrl(resolvedConfig.baseUrl)
    ? new MiniMaxAnthropicProvider(resolvedConfig)
    : new MiniMaxProvider(resolvedConfig);
}
