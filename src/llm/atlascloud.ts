import type { LLMConfig } from './types.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const ATLASCLOUD_DEFAULT_BASE_URL = 'https://api.atlascloud.ai/v1';

export class AtlasCloudProvider extends OpenAICompatProvider {
  constructor(config: LLMConfig) {
    super({
      ...config,
      apiKey: config.apiKey ?? process.env.ATLASCLOUD_API_KEY ?? process.env.ATLAS_CLOUD_API_KEY,
      baseUrl:
        config.baseUrl ??
        process.env.ATLASCLOUD_BASE_URL ??
        process.env.ATLAS_CLOUD_BASE_URL ??
        ATLASCLOUD_DEFAULT_BASE_URL,
    });
  }

  override async listModels(): Promise<string[]> {
    try {
      return await super.listModels();
    } catch {
      return ['deepseek-ai/deepseek-v4-pro', 'deepseek-ai/deepseek-v4-flash', 'qwen/qwen3.5-27b'];
    }
  }
}
