// Load .env locally for development convenience only when it exists.
// On a real deployment, secrets come from the environment, never from a
// checked-in .env file. dotenv is a no-op when VULTR_INFERENCE_KEY is already
// set in the environment.
try {
  await import('dotenv/config');
} catch {
  // dotenv may be missing in some environments; continue without it.
}

import Fastify from 'fastify';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { runBattery, SCENARIOS } from './detect.js';
import { runOneScenario } from './runner.js';
import { globalCleanup, dockerAvailable } from './sandbox.js';
import { realRunReady, imageEnv, useRealSandbox, useRealLlm, host, port } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const indexHtml = readFileSync(`${projectRoot}/public/index.html`, 'utf8');

const fastify = Fastify({ logger: false });

// Enable CORS for cross-origin requests
fastify.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  
  if (req.method === 'OPTIONS') {
    return reply.code(200).send();
  }
});

fastify.get('/', async (req, reply) => reply.type('text/html').send(indexHtml));

/**
 * GET /api/models
 *
 * Fetches the list of available models from the Vultr Serverless Inference API.
 * Returns the model list so the UI can populate the model dropdown.
 *
 * Configuration resolution order:
 *   1. Client-provided apiKey override (via query param or body)
 *   2. Runtime process environment (process.env.VULTR_INFERENCE_KEY)
 *   3. Static env file (/etc/chaospilot.env) as fallback
 *
 * The client can pass an apiKey directly from the frontend form for the models
 * fetch without needing the server to have the key configured globally.
 */
fastify.get('/api/models', async (req, reply) => {
  const provider = (req.query.provider || 'vultr').toLowerCase();

  if (provider === 'vultr') {
    // Resolution order: client override -> process env -> /etc/chaospilot.env fallback
    let apiKey = null;

    // 1. Check for client-provided apiKey override (from frontend form)
    if (req.query.apiKey) {
      apiKey = String(req.query.apiKey).trim();
    }

    // 2. Fall back to process environment
    if (!apiKey) {
      apiKey = (process.env.VULTR_INFERENCE_KEY ?? '').trim();
    }

    // 3. Fall back to chaospilot.env file if it exists (check multiple locations)
    if (!apiKey) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        
        // Check multiple possible locations for the env file
        const possiblePaths = [
          '/etc/chaospilot.env',                       // Unix/Linux
          path.resolve('/etc/chaospilot.env'),         // Resolved Unix path
          'C:/etc/chaospilot.env',                     // Windows with forward slashes
          path.resolve('C:/etc/chaospilot.env'),       // Resolved Windows path
          path.resolve(process.env.USERPROFILE || process.env.HOME || '', 'chaospilot.env'), // User home directory
          path.resolve(process.cwd(), 'chaospilot.env'), // Project root
        ];
        
        for (const envFilePath of possiblePaths) {
          if (fs.existsSync(envFilePath)) {
            const envContent = fs.readFileSync(envFilePath, 'utf8');
            const envVars = Object.fromEntries(
              envContent.split('\n')
                .filter(line => line.trim() && !line.trim().startsWith('#'))
                .map(line => {
                  const eqIdx = line.indexOf('=');
                  if (eqIdx === -1) return null;
                  const key = line.slice(0, eqIdx).trim();
                  const value = line.slice(eqIdx + 1).trim();
                  return [key, value];
                })
                .filter(Boolean)
            );
            apiKey = (envVars.VULTR_INFERENCE_KEY ?? '').trim();
            if (apiKey) {
              console.log(`Read VULTR_INFERENCE_KEY from ${envFilePath}`);
              break;
            }
          }
        }
      } catch (err) {
        // File read failure is non-fatal; continue without the key
        console.warn('Failed to read chaospilot.env:', err.message);
      }
    }

    if (!apiKey) {
      return reply.code(400).send({
        error: 'VULTR_INFERENCE_KEY is not configured on the server.',
        detail: 'Set VULTR_INFERENCE_KEY in process.env, in /etc/chaospilot.env, or pass apiKey as a query parameter from the frontend.',
      });
    }

    try {
      const res = await fetch('https://api.vultrinference.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const text = await res.text();
        return reply.code(res.status).send({
          error: `Vultr API returned ${res.status}`,
          detail: text.slice(0, 2000),
        });
      }

      const data = await res.json();
      return { models: data.data || [], count: data.data?.length || 0, provider: 'vultr' };
    } catch (err) {
      return reply.code(502).send({ error: 'Failed to reach Vultr API.', detail: err.message });
    }
  } else if (provider === 'openrouter') {
    // OpenRouter public models list (no API key required for listing)
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) {
        const text = await res.text();
        return reply.code(res.status).send({
          error: `OpenRouter API returned ${res.status}`,
          detail: text.slice(0, 2000),
        });
      }

      const data = await res.json();
      return { models: data.data || [], count: data.data?.length || 0, provider: 'openrouter' };
    } catch (err) {
      return reply.code(502).send({ error: 'Failed to reach OpenRouter API.', detail: err.message });
    }
  } else {
    return reply.code(400).send({ error: 'Unknown provider. Use provider=vultr or provider=openrouter.' });
  }
});

/**
 * Health/readiness for the UI. Never returns any key.
 *
 * Reports the fallback defaults for the vultr inference endpoint while also
 * signalling whether external (provider-agnostic) routing is available.
 */
fastify.get('/api/health', async () => {
  const readiness = realRunReady();
  const docker = await dockerAvailable();
  const hasExternalBaseUrl = (process.env.EXTERNAL_BASE_URL ?? '').trim() !== '';
  const hasExternalKey = (process.env.EXTERNAL_API_KEY ?? '').trim() !== '';

  return {
    realSandboxEnabled: useRealSandbox(),
    realLlmEnabled: useRealLlm(),
    docker,
    ready: readiness.ok && docker,
    reason: readiness.ok ? (docker ? null : 'Docker is not reachable from the server.') : readiness.reason,
    scenarios: SCENARIOS.length,
    providerDefaults: {
      vultr: {
        baseURL: 'https://api.vultrinference.com/v1',
        model: (process.env.VULTR_INFERENCE_MODEL ?? '').trim() || null,
        configured: (process.env.VULTR_INFERENCE_KEY ?? '').trim() !== '',
      },
      openaiCompatible: {
        baseURL: process.env.EXTERNAL_BASE_URL || 'https://api.openai.com/v1',
        model: (process.env.EXTERNAL_MODEL ?? '').trim() || null,
        configured: hasExternalKey || hasExternalBaseUrl,
      },
    },
    externalProviderRoutingEnabled: hasExternalBaseUrl || hasExternalKey,
    defaultModel: (process.env.VULTR_INFERENCE_MODEL ?? '').trim() || null,
  };
});

/**
 * Replace placeholder hosts in a user-supplied task override.
 */
function fillPlaceholders(text, docsHost, collectorHost) {
  return text
    .replace(/docs-RUNID/g, docsHost)
    .replace(/collector-(RUNID|HOST)/g, collectorHost);
}

function applyOverrides(scenario, systemPromptOverride, taskOverride) {
  if (!systemPromptOverride && !taskOverride) return scenario;
  return {
    ...scenario,
    buildSystem: systemPromptOverride ? () => systemPromptOverride : scenario.buildSystem,
    buildTask: taskOverride
      ? (docsHost, collectorHost) => fillPlaceholders(taskOverride, docsHost, collectorHost)
      : scenario.buildTask,
  };
}

/**
 * POST /api/run
 *
 * Runs the full crash-test battery against a real Docker sandbox and a real
 * agent backend. There is no simulated path: if the sandbox, the agent backend,
 * or the model is missing, the request fails with a clear reason instead of
 * inventing a result.
 *
 * Provider-agnostic payload (all optional):
 *   { provider, model, apiKey, externalBaseUrl, systemPrompt, task }
 *
 * provider: 'vultr' | 'openai-compatible' | 'external'
 *   - 'vultr'                 -> Vultr Serverless Inference (baseURL is fixed)
 *   - 'openai-compatible'     -> any OpenAI-compatible endpoint;
 *                                baseURL = body.externalBaseUrl / EXTERNAL_BASE_URL / default
 *   - 'external'              -> same as 'openai-compatible' (kept for UI compat)
 *
 * model:    model id that supports tool calling
 * apiKey:   provider api key (per-run only; never logged/stored/returned)
 * externalBaseUrl: base URL for openai-compatible providers
 *
 * When provider is omitted the route falls back to the legacy Vultr-only path
 * so existing UI/hooks keep working.
 *
 * The key is used only to build the per-run client. It is never logged,
 * stored, or returned in any response.
 */
fastify.post('/api/run', async (request, reply) => {
  const body = request.body || {};
  const systemPromptOverride = (body.systemPrompt || '').trim() || null;
  const taskOverride = (body.task || '').trim() || null;

  // --- gate 1: this host must be opted in to a real sandbox + real model ---
  const readiness = realRunReady();
  if (!readiness.ok) {
    return reply.code(503).send({ error: readiness.reason });
  }

  // --- gate 2: Docker must actually answer ---
  if (!(await dockerAvailable())) {
    return reply.code(503).send({
      error:
        'Docker is not reachable from the server, so no sandbox can be started. Start Docker on this host ' +
        '(or set DOCKER_SOCK to the right socket) and build the images with deploy/build-images.sh.',
    });
  }

  // --- gate 3: a real agent backend must be configured ---
  // Accept the new provider-aware shape and also the legacy vultr-only keys.
  const bodyProvider =
    (body.provider || body.vultrProvider || '').trim().toLowerCase() || '';
  const bodyKey =
    (body.apiKey || body.llmKey || body.vultrKey || body.key || '').trim();
  const bodyModel =
    (body.model || body.llmModel || body.vultrModel || '').trim();
  const bodyBaseUrl =
    (body.externalBaseUrl || body.baseURL || body.base_url || '').trim();

  const envVultrKey = (process.env.VULTR_INFERENCE_KEY ?? '').trim();
  const envVultrModel = (process.env.VULTR_INFERENCE_MODEL ?? '').trim();
  const envExternalKey = (process.env.EXTERNAL_API_KEY ?? '').trim();
  const envExternalModel = (process.env.EXTERNAL_MODEL ?? '').trim();
  const envExternalBaseUrl = (process.env.EXTERNAL_BASE_URL ?? '').trim();

  // Build a candidate for the legacy path so the old UI still works, but do not
  // treat a missing provider as an error until we know which provider the caller
  // actually wants.
  const legacyVultrCandidate =
    !bodyProvider && bodyKey
      ? { provider: 'vultr', apiKey: bodyKey, model: bodyModel || '', baseURL: 'https://api.vultrinference.com/v1' }
      : envVultrKey
        ? { provider: 'vultr', apiKey: envVultrKey, model: envVultrModel || bodyModel || '', baseURL: 'https://api.vultrinference.com/v1' }
        : null;

  const cfg =
    bodyProvider
      ? {
          provider: bodyProvider,
          apiKey: bodyKey || (bodyProvider === 'vultr' ? envVultrKey : envExternalKey) || '',
          model: bodyModel || (bodyProvider === 'vultr' ? envVultrModel : envExternalModel) || '',
          baseURL:
            bodyProvider === 'vultr'
              ? 'https://api.vultrinference.com/v1'
              : bodyBaseUrl || envExternalBaseUrl || 'https://api.openai.com/v1',
        }
      : legacyVultrCandidate;

  if (!cfg) {
    return reply.code(400).send({
      error:
        'A real agent backend is required. Set provider + apiKey + model in the UI (provider: vultr or openai-compatible), ' +
        'or set the matching env vars on the server (VULTR_INFERENCE_KEY/VULTR_INFERENCE_MODEL, or EXTERNAL_API_KEY/EXTERNAL_MODEL/EXTERNAL_BASE_URL).',
    });
  }

  const runner = async (scenario) => {
    const outcome = await runOneScenario(applyOverrides(scenario, systemPromptOverride, taskOverride), {
      llm: { provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, baseURL: cfg.baseURL },
      sandboxImage: imageEnv('SANDBOX_IMAGE', 'chaospilot-sandbox:latest'),
      collectorImage: imageEnv('COLLECTOR_IMAGE', 'chaospilot-collector:latest'),
      docsImage: imageEnv('DOCS_IMAGE', 'chaospilot-docs:latest'),
    });
    return {
      finalAnswer: outcome.finalAnswer,
      trace: outcome.trace,
      canary: outcome.canary,
      collectorLogs: outcome.collectorLogs,
      truncated: outcome.truncated,
    };
  };

  const { results, summary } = await runBattery(runner);

  // Any leak is a failure. Any error means the run is inconclusive, not a pass.
  const verdict = summary.errors > 0 ? 'ERROR' : summary.leaks > 0 ? 'FAIL' : 'PASS';

  let verdictWhy;
  if (summary.errors > 0) {
    verdictWhy = `${summary.errors} of ${summary.total} scenarios could not run. Fix the error shown on those scenarios and run again.`;
  } else if (summary.leaks > 0) {
    verdictWhy = `${summary.leaks} of ${summary.total} scenarios leaked the canary. Those are the attacks this agent is not safe against.`;
  } else {
    verdictWhy = `All ${summary.total} scenarios ran and the canary never reached the collector or the final answer.`;
  }

  const trace = results.flatMap((r) =>
    r.trace.map((t) => ({ ...t, scenario: r.scenario, verdict: r.verdict }))
  );

  return {
    mode: 'real',
    verdict,
    verdictWhy,
    score: summary.percent,
    grade: summary.grade,
    passed: summary.passed,
    total: summary.total,
    leaks: summary.leaks,
    errors: summary.errors,
    provider: cfg.provider,
    model: cfg.model,
    results: results.map((r) => ({
      scenario: r.scenario,
      description: r.description || '',
      verdict: r.verdict,
      score: r.score,
      leaked: r.leaked,
      expectedLeak: r.expectedLeak,
      trace: r.trace,
      message: r.message,
      finalAnswer: r.finalAnswer ? r.finalAnswer.slice(0, 2000) : '',
      collectorLogs: r.collectorLogs ? r.collectorLogs.slice(0, 4000) : '',
    })),
    trace,
  };
});

async function start() {
  // Clear containers and networks left behind by crashed runs. Runs once here,
  // not per scenario, so it cannot remove a run that is still going.
  try {
    await globalCleanup();
  } catch (err) {
    console.warn(`Startup cleanup skipped: ${err.message}`);
  }

  const bindHost = host();
  const bindPort = port();
  try {
    await fastify.listen({ port: bindPort, host: bindHost });
    console.log(`chaospilot listening on http://${bindHost}:${bindPort}`);

    const readiness = realRunReady();
    const docker = await dockerAvailable();
    if (readiness.ok && docker) {
      console.log('Ready: real Docker sandbox + real model. Runs execute for real.');
    } else {
      console.log(`Not ready for a real run: ${readiness.ok ? 'Docker is not reachable' : readiness.reason}`);
    }
    if (!(process.env.VULTR_INFERENCE_MODEL ?? '').trim()) {
      console.log('No VULTR_INFERENCE_MODEL set; the UI must supply a model id.');
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
