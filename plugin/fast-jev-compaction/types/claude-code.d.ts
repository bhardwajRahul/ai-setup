/**
 * Compile shim for the Claude Code plugin function-hook API.
 *
 * This is NOT Claude Code's real type surface. It is a small, deliberately
 * permissive declaration authored for this plugin, covering only the members
 * `hooks/fast-jev.ts` touches, so the hook typechecks in this repository
 * without redistributing Claude Code's own generated declarations.
 *
 * Claude Code can generate the full, exact declarations for the version you
 * run. If you are developing against this plugin and want real type safety,
 * generate them and point `tsconfig.plugin.json` at that file instead — the
 * hook is written against the same API either way.
 *
 * Function hooks are an early-access surface and may change between Claude
 * Code releases. Upstream authored this hook against 2.1.274.
 */
declare module 'claude-code' {
  export type PluginOptions = Record<string, unknown>;

  export type ToolUseSummary = {
    tool_use_id: string;
    tool: string;
    input: Record<string, unknown>;
    text?: string;
    isError?: boolean;
  };

  export type ToolResultSummary = {
    tool_use_id: string;
    text: string;
    isError: boolean;
  };

  export type SessionMessage = {
    role: 'user' | 'assistant';
    text: string;
    toolUses: ToolUseSummary[];
    toolResults?: ToolResultSummary[];
  };

  export type TurnCompleteInput = {
    reason?: 'answer' | 'aborted' | 'refusal' | 'error';
    [key: string]: unknown;
  };

  export type SessionCompactInput = {
    messages: readonly SessionMessage[];
    [key: string]: unknown;
  };

  export type HookResponse = {
    status: number;
    ok: boolean;
    text: string;
  };

  /** The engine handle passed to every hook. */
  export type HookContext = {
    http: {
      fetch(
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ): Promise<HookResponse>;
    };
    env: { get(name: string): Promise<string | undefined> };
    settings: { read(): Promise<Readonly<Record<string, unknown>>> };
    ui: {
      log(text: string): void;
      toast(text: string, options?: { timeoutMs?: number }): void;
    };
    session: {
      usage(): Promise<{ context: { percent?: number } }>;
      compact(): Promise<unknown>;
    };
  };

  export type On = {
    (
      pattern: 'session.compact',
      hook: (
        $: HookContext,
        event: SessionCompactInput,
        next: (event: SessionCompactInput) => unknown,
      ) => unknown,
    ): unknown;
    (
      pattern: 'turn.complete',
      hook: (
        $: HookContext,
        event: TurnCompleteInput,
        next: (event: TurnCompleteInput) => unknown,
      ) => unknown,
    ): unknown;
    (pattern: string, hook: (...args: never[]) => unknown): unknown;
  };

  export type Register = (on: On, options: PluginOptions) => unknown;
}
