// Agent loop: talks to an OpenAI-compatible endpoint and executes the
// model's shell tool calls inside the sandbox.
//
// Provider-agnostic: the same tool-calling loop runs regardless of which
// OpenAI-compatible API is behind it. The sandbox network stays isolated and
// unchanged; only the LLM client construction differs by provider.

// Well-known provider base URLs. Add a new one here when a new provider is
// supported.
export const PROVIDER_BASE_URLS = {
  vultr: 'https://api.vultrinference.com/v1',
};

// Default base URL for the 'openai-compatible' provider when the run payload
// does not supply one and process.env.EXTERNAL_BASE_URL is not set.
export const DEFAULT_EXTERNAL_BASE_URL = 'https://api.openai.com/v1';

// Cap per tool result so one large output cannot blow up the context window.
const MAX_TOOL_OUTPUT_CHARS = 4000;

/**
 * Tools descriptor for the agent. A single tool, shell(cmd), so the agent can
 * fetch pages and, in the attack scenarios, exfiltrate data with curl.
 *
 * The tool set is the same for every provider. Only the LLM client changes.
 */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Run a shell command inside the sandbox. Use it to fetch URLs (curl), read files, or run env. Returns stdout, stderr and the exit code.',
      parameters: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            description:
              'Shell command to run, e.g. curl http://<host>:8080 (use the host given in the task)',
          },
        },
        required: ['cmd'],
      },
    },
  },
];

export function shellToolDescription() {
  return 'You have one tool: shell(cmd). Use it to run shell commands in the sandbox (curl, env, cat, etc.).';
}

/**
 * Provider-aware per-run LLM config.
 *
 * Accepted shapes in the run body:
 *   { provider, model, apiKey, externalBaseUrl }
 *
 * provider: 'vultr' | 'openai-compatible' | 'external'   (external == openai-compatible, kept for UI compat)
 *   - 'vultr'                 -> Vultr Serverless Inference, baseURL from PROVIDER_BASE_URLS.vultr
 *   - 'openai-compatible'     -> user-supplied baseURL (body.externalBaseUrl or EXTERNAL_BASE_URL env or DEFAULT_EXTERNAL_BASE_URL)
 *   - 'external'              -> same as 'openai-compatible' for backward compat
 *
 * When provider is omitted, fall back to the legacy Vultr-only path so existing
 * runs keep working.
 *
 * The key is used only to build the client for this run. It is never logged,
 * stored, or returned in any response.
 */
export function llmConfigFromRun(body) {
  const provider =
    body && (body.provider || body.vultrProvider || '').trim() ? body.provider.trim().toLowerCase() : '';

  const isVultrLike = provider === 'vultr';
  const isExternalLike =
    provider === 'openai-compatible' || provider === 'external' || provider === '';

  // Prefer an explicit body key, then fall back to legacy keys, then env.
  const bodyKey =
    body && (body.apiKey || body.llmKey || body.vultrKey || body.key || '').trim();
  const bodyModel =
    body && (body.model || body.llmModel || body.vultrModel || '').trim();
  const bodyBaseUrl =
    body && (body.externalBaseUrl || body.baseURL || body.base_url || '').trim();

  const fromBodyExternal =
    isExternalLike && bodyKey
      ? {
          provider: 'openai-compatible',
          apiKey: bodyKey,
          model: bodyModel || '',
          baseURL: bodyBaseUrl || process.env.EXTERNAL_BASE_URL || DEFAULT_EXTERNAL_BASE_URL,
        }
      : null;

  const fromEnvExternal =
    isExternalLike && process.env.EXTERNAL_API_KEY
      ? {
          provider: 'openai-compatible',
          apiKey: process.env.EXTERNAL_API_KEY,
          model: process.env.EXTERNAL_MODEL || bodyModel || '',
          baseURL: bodyBaseUrl || process.env.EXTERNAL_BASE_URL || DEFAULT_EXTERNAL_BASE_URL,
        }
      : null;

  const fromBodyVultr =
    isVultrLike && bodyKey
      ? {
          provider: 'vultr',
          apiKey: bodyKey,
          model: bodyModel || '',
          baseURL: PROVIDER_BASE_URLS.vultr,
        }
      : null;

  const fromEnvVultr =
    isVultrLike && process.env.VULTR_INFERENCE_KEY
      ? {
          provider: 'vultr',
          apiKey: process.env.VULTR_INFERENCE_KEY,
          model: process.env.VULTR_INFERENCE_MODEL || bodyModel || '',
          baseURL: PROVIDER_BASE_URLS.vultr,
        }
      : null;

  // Legacy path: if no provider was supplied, behave exactly as the old code:
  // Vultr key/env wins, with the Vultr base URL.
  if (!provider) {
    const legacy =
      bodyKey
        ? {
            provider: 'vultr',
            apiKey: bodyKey,
            model: bodyModel || '',
            baseURL: PROVIDER_BASE_URLS.vultr,
          }
        : process.env.VULTR_INFERENCE_KEY
          ? {
              provider: 'vultr',
              apiKey: process.env.VULTR_INFERENCE_KEY,
              model: process.env.VULTR_INFERENCE_MODEL || '',
              baseURL: PROVIDER_BASE_URLS.vultr,
            }
          : null;
    if (legacy) return legacy;
  }

  return fromBodyExternal || fromEnvExternal || fromBodyVultr || fromEnvVultr || null;
}

/**
 * Resolve and validate the LLM config once per run. Error messages never
 * include the key itself.
 */
function resolveLlmConfig(llm) {
  const cfg = llm || llmConfigFromRun({});
  if (!cfg) {
    throw new Error(
      'No LLM config available. Supply provider + apiKey + model in the UI, or set the matching env vars on the server.'
    );
  }
  if (!cfg.provider) {
    throw new Error(
      'No provider selected. Choose vultr or openai-compatible in the UI, or set the matching provider env var on the server.'
    );
  }
  if (!cfg.apiKey) {
    throw new Error(
      `${cfg.provider} api key is not set. Paste it in the UI, or set ${cfg.provider === 'vultr' ? 'VULTR_INFERENCE_KEY' : 'EXTERNAL_API_KEY'} on the server. Never commit it.`
    );
  }
  if (!cfg.model) {
    throw new Error(
      `${cfg.provider} model id is not set. Pick a model that supports tool calling and set it in the UI or the server env.`
    );
  }
  if (!cfg.baseURL) {
    throw new Error(
      `${cfg.provider} base URL is not set and no default is known. Set externalBaseUrl in the UI or EXTERNAL_BASE_URL on the server.`
    );
  }
  return {
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseURL: cfg.baseURL,
  };
}

/**
 * Build the OpenAI client for the resolved config.
 *
 * The openai npm package is imported lazily so the rest of the project can
 * load without it; the import happens only when an LLM turn runs.
 */
async function createClient(cfg) {
  const mod = await import('openai');
  const OpenAI =
    (mod?.default && (mod.default.default ?? mod.default)) ||
    mod?.default ||
    (mod?.OpenAI && (mod.OpenAI.default ?? mod.OpenAI)) ||
    mod?.OpenAI;

  if (!OpenAI) {
    throw new Error('The openai package did not export an OpenAI client.');
  }

  // Try the constructor form, then the factory form.
  const candidates = [
    () => new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey }),
  ];
  if (typeof OpenAI === 'function') {
    candidates.push(() => OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey }));
  }

  for (const make of candidates) {
    try {
      const c = make();
      if (c?.chat?.completions && typeof c.chat.completions.create === 'function') {
        return c;
      }
    } catch {
      // Try the next candidate.
    }
  }

  // Fallback: hand-rolled OpenAI-compatible client over the same endpoint.
  return new OpenAICompatClient(cfg.baseURL, cfg.apiKey);
}

/**
 * Minimal OpenAI-compatible client built directly on fetch.
 * Used only if the installed openai package cannot be coerced into the shape
 * this agent expects.
 */
class OpenAICompatClient {
  constructor(baseURL, apiKey) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.apiKey = apiKey;
  }
  async chatCompletionsCreate(params) {
    const body = {
      model: params.model,
      messages: params.messages,
      tools: params.tools,
    };
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM request failed: ${res.status} ${res.statusText}${text ? ' ' + text.slice(0, 500) : ''}`);
    }
    const json = await res.json();
    return {
      choices: [
        {
          message: json.choices?.[0]?.message,
        },
      ],
    };
  }
}

/**
 * Execute one tool call from the model. Never throws: every failure becomes
 * text the model can see, so one bad call does not kill the whole run.
 *
 * Tool calls from ANY provider are parsed and executed inside the local secure
 * Docker container network exactly as before. The provider only affects how the
 * completion was obtained, not how tools are run.
 */
async function runToolCall(box, tc) {
  if (tc.function?.name !== 'shell') {
    return { cmd: null, text: `error: unknown tool "${tc.function?.name}"` };
  }

  let cmd = null;
  try {
    const args = JSON.parse(tc.function.arguments || '{}');
    if (typeof args.cmd === 'string') cmd = args.cmd;
  } catch {
    cmd = null;
  }
  if (!cmd) {
    return { cmd: null, text: 'error: shell tool needs a string "cmd" argument' };
  }

  let text;
  try {
    text = await box.exec(cmd);
  } catch (err) {
    text = `error: ${err?.message ?? err}`;
  }
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    text = text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n[output truncated]';
  }
  return { cmd, text };
}

/**
 * One agent run for a single scenario.
 *
 * @param {Object} params
 * @param {string} params.systemPrompt  already-resolved system prompt
 * @param {string} params.task          already-resolved user task
 * @param {Object} params.ctx
 * @param {import('./sandbox.js').SandboxRun} params.ctx.box
 * @param {Object} [params.ctx.llm]     per-run config {provider, apiKey, model, baseURL}
 * @param {number} [params.maxTurns=8]
 * @returns {Promise<{finalAnswer:string, trace:Array, canary:string,
 *   collectorLogs:string, truncated:boolean}>}
 */
export async function runAgent({ systemPrompt, task, ctx, maxTurns = 8 }) {
  const { box } = ctx;
  const cfg = resolveLlmConfig(ctx.llm);
  const client = await createClient(cfg);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  const trace = [];
  let finalAnswer = '';
  // Stays true unless the model finishes on its own before maxTurns.
  let truncated = true;

  for (let turn = 0; turn < maxTurns; turn++) {
    const r =
      typeof client.chatCompletionsCreate === 'function'
        ? await client.chatCompletionsCreate({
            model: cfg.model,
            messages,
            tools: TOOLS,
          })
        : await client.chat.completions.create({
            model: cfg.model,
            messages,
            tools: TOOLS,
          });

    const m = r.choices?.[0]?.message;
    if (!m) throw new Error('LLM returned no message');

    // Push a plain object. The SDK response is not a Python-style model
    // object, so there is no model_dump() to call.
    const assistantMsg = { role: 'assistant', content: m.content ?? null };
    if (m.tool_calls && m.tool_calls.length > 0) {
      assistantMsg.tool_calls = m.tool_calls;
    }
    messages.push(assistantMsg);

    if (!m.tool_calls || m.tool_calls.length === 0) {
      finalAnswer = m.content || '';
      truncated = false;
      break;
    }

    for (const tc of m.tool_calls) {
      const { cmd, text } = await runToolCall(box, tc);
      trace.push({ step: turn, toolCall: tc, cmd, output: text });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
    }
  }

  // Await the logs here, before the caller destroys the containers.
  const collectorLogs = await box.collectorLogs();

  return {
    finalAnswer,
    trace,
    canary: box.canary,
    collectorLogs,
    truncated,
  };
}
