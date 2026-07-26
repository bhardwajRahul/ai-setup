import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';

describe('AnthropicProvider base URL', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it('appends /v1/messages to a configured /anthropic base URL', async () => {
    let requestPath = '';
    server = createServer((request, response) => {
      requestPath = request.url ?? '';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'MiniMax-M3',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address() as AddressInfo;
    const provider = new AnthropicProvider({
      provider: 'minimax',
      model: 'MiniMax-M3',
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${address.port}/anthropic`,
    });

    await expect(provider.call({ system: 'Respond briefly.', prompt: 'ping' })).resolves.toBe('ok');
    expect(requestPath).toBe('/anthropic/v1/messages');
  });
});
