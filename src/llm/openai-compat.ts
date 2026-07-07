import OpenAI, { APIConnectionError } from 'openai';
import type {
  LLMProvider,
  LLMCallOptions,
  LLMStreamOptions,
  LLMStreamCallbacks,
  LLMConfig,
  TokenUsage,
} from './types.js';
import { trackUsage } from './usage.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function resolveTimeoutMs(): number {
  const raw = process.env.CALIBER_OPENAI_TIMEOUT_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1000) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

function getBaseUrl(config: LLMConfig): string {
  return (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

interface ChatCompletionResponse {
  choices: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function isConnectionError(error: unknown): error is APIConnectionError {
  return error instanceof APIConnectionError;
}

function buildRequestBody(
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  temperature: number | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  return {
    model,
    max_completion_tokens: maxTokens,
    ...(temperature !== undefined && { temperature }),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };
}

function buildStreamRequestBody(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  return {
    model,
    max_completion_tokens: maxTokens,
    ...(temperature !== undefined && { temperature }),
    messages,
    stream: true,
  };
}

export class OpenAICompatProvider implements LLMProvider {
  protected client: OpenAI;
  protected defaultModel: string;
  protected temperature: number | undefined;
  protected baseUrl: string;
  protected apiKey: string | undefined;

  constructor(config: LLMConfig, options?: { temperature?: number }) {
    this.baseUrl = getBaseUrl(config);
    this.apiKey = config.apiKey;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      timeout: resolveTimeoutMs(),
    });
    this.defaultModel = config.model;
    this.temperature = options?.temperature;
  }

  async call(options: LLMCallOptions): Promise<string> {
    try {
      return await this.sdkCall(options);
    } catch (error) {
      if (isConnectionError(error)) {
        return await this.fetchFallback(options, error);
      }
      throw error;
    }
  }

  private async sdkCall(options: LLMCallOptions): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      max_completion_tokens: options.maxTokens || 4096,
      ...(this.temperature !== undefined && { temperature: this.temperature }),
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.prompt },
      ],
    });

    const model = options.model || this.defaultModel;
    if (response.usage) {
      trackUsage(model, {
        inputTokens: response.usage.prompt_tokens ?? 0,
        outputTokens: response.usage.completion_tokens ?? 0,
      });
    }

    return response.choices[0]?.message?.content || '';
  }

  private async fetchFallback(
    options: LLMCallOptions,
    originalError: APIConnectionError,
  ): Promise<string> {
    const model = options.model || this.defaultModel;
    const url = `${this.baseUrl}/chat/completions`;
    const timeoutMs = resolveTimeoutMs();
    const body = buildRequestBody(
      model,
      options.system,
      options.prompt,
      options.maxTokens || 4096,
      this.temperature,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timer);
      const err = fetchError instanceof Error ? fetchError : new Error(String(fetchError));
      const msg = `OpenAI-compatible provider connection failed after SDK connection error. The provider at ${url} may be unreachable or incompatible.\n  SDK error: ${originalError.message}${originalError.cause ? ` (${String(originalError.cause)})` : ''}\n  Fetch error: ${err.message}`;
      throw new Error(msg);
    }

    clearTimeout(timer);

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as { error?: { message?: string } };
        detail = errBody.error?.message || JSON.stringify(errBody).slice(0, 500);
      } catch {
        detail = response.statusText;
      }
      const msg = `OpenAI-compatible provider returned HTTP ${response.status}: ${detail}`;
      throw Object.assign(new Error(msg), {
        status: response.status,
        statusText: response.statusText,
      });
    }

    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch {
      throw new Error(`OpenAI-compatible provider returned invalid JSON (HTTP ${response.status})`);
    }

    if (data.usage) {
      trackUsage(model, {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
      });
    }

    return data.choices?.[0]?.message?.content || '';
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    for await (const model of this.client.models.list()) {
      models.push(model.id);
    }
    return models;
  }

  async stream(options: LLMStreamOptions, callbacks: LLMStreamCallbacks): Promise<void> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: options.system },
    ];

    if (options.messages) {
      for (const msg of options.messages) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: options.prompt });

    const simpleMessages = messages as Array<{ role: string; content: string }>;

    try {
      await this.sdkStream(messages, options, callbacks);
    } catch (error) {
      if (isConnectionError(error)) {
        await this.streamFetchFallback(simpleMessages, options, callbacks, error);
        return;
      }
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async sdkStream(
    messages: OpenAI.ChatCompletionMessageParam[],
    options: LLMStreamOptions,
    callbacks: LLMStreamCallbacks,
  ): Promise<void> {
    const stream = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      max_completion_tokens: options.maxTokens || 10240,
      ...(this.temperature !== undefined && { temperature: this.temperature }),
      messages,
      stream: true,
    });

    try {
      let stopReason: string | undefined;
      let usage: TokenUsage | undefined;
      const model = options.model || this.defaultModel;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta != null) callbacks.onText(delta);
        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) stopReason = finishReason === 'length' ? 'max_tokens' : finishReason;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunkUsage = (chunk as any).usage;
        if (chunkUsage) {
          usage = {
            inputTokens: chunkUsage.prompt_tokens ?? 0,
            outputTokens: chunkUsage.completion_tokens ?? 0,
          };
          trackUsage(model, usage);
        }
      }
      callbacks.onEnd({ stopReason, usage });
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async streamFetchFallback(
    messages: Array<{ role: string; content: string }>,
    options: LLMStreamOptions,
    callbacks: LLMStreamCallbacks,
    originalError: APIConnectionError,
  ): Promise<void> {
    const model = options.model || this.defaultModel;
    const url = `${this.baseUrl}/chat/completions`;
    const timeoutMs = resolveTimeoutMs();
    const body = buildStreamRequestBody(
      model,
      messages as Array<{ role: string; content: string }>,
      options.maxTokens || 10240,
      this.temperature,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timer);
      const err = fetchError instanceof Error ? fetchError : new Error(String(fetchError));
      const msg = `OpenAI-compatible streaming provider connection failed after SDK connection error.\n  SDK error: ${originalError.message}${originalError.cause ? ` (${String(originalError.cause)})` : ''}\n  Fetch error: ${err.message}`;
      callbacks.onError(new Error(msg));
      return;
    }

    clearTimeout(timer);

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as { error?: { message?: string } };
        detail = errBody.error?.message || JSON.stringify(errBody).slice(0, 500);
      } catch {
        detail = response.statusText;
      }
      callbacks.onError(
        new Error(
          `OpenAI-compatible streaming provider returned HTTP ${response.status}: ${detail}`,
        ),
      );
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      callbacks.onError(
        new Error('OpenAI-compatible streaming provider returned no response body'),
      );
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let stopReason: string | undefined;
    let usage: TokenUsage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk: ChatCompletionChunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta != null) callbacks.onText(delta);
            const finishReason = chunk.choices?.[0]?.finish_reason;
            if (finishReason) stopReason = finishReason === 'length' ? 'max_tokens' : finishReason;
            if (chunk.usage) {
              usage = {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              };
              trackUsage(model, usage);
            }
          } catch {
            // skip unparseable SSE lines
          }
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks.onError(err);
      return;
    } finally {
      reader.releaseLock();
    }

    callbacks.onEnd({ stopReason, usage });
  }
}
