// Runtime opt-in switches for real runs.
//
// Every run is real: real Docker sandbox, real model. This module decides
// whether this host is allowed and able to run one at all, so the server can
// refuse with a clear reason instead of producing a result it did not measure.
//
// Secrets (for example VULTR_INFERENCE_KEY) must come from the environment or
// from the UI for a single run. They are not read from any checked-in env file
// and are never stored by the server.

const STRIP = new Set(['', '0', 'false', 'no', 'off', 'n']);

function isTrue(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && !STRIP.has(s);
}

function get(name, defaultVal = false) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return Boolean(defaultVal);
  return isTrue(raw);
}

// Read lazily: static imports are evaluated before a top-level `await import`
// can load .env, so these must be read at call time, not at module load.
export function useRealSandbox() {
  return get('USE_REAL_SANDBOX', false);
}

export function useRealLlm() {
  return get('USE_REAL_LLM', false);
}

export function realRunReady() {
  // A real run needs both the real sandbox path and the real LLM path opted in.
  if (!useRealSandbox()) {
    return {
      ok: false,
      reason: 'Real runs are disabled on this host because USE_REAL_SANDBOX is not set to true. Set USE_REAL_SANDBOX=true and supply Docker access before running a real crash test.',
    };
  }
  if (!useRealLlm()) {
    return {
      ok: false,
      reason: 'Real runs are disabled because USE_REAL_LLM is not set to true. Set USE_REAL_LLM=true and supply a Vultr Serverless Inference API key + model before running a real crash test.',
    };
  }
  return { ok: true };
}

// Optional per-host overrides for the real run images. These are used only when
// USE_REAL_SANDBOX is true. They are still opt-in env vars, not secrets.
export function imageEnv(name, defaultTag) {
  const v = (process.env[name] ?? '').trim();
  return v || defaultTag;
}

export function dockerSock() {
  const raw = (process.env.DOCKER_SOCK ?? '').trim();
  if (raw) return raw;
  if (process.platform === 'win32') return '//./pipe/docker_engine';
  return '/var/run/docker.sock';
}

export function host() {
  const raw = (process.env.HOST ?? '').trim();
  return raw || '127.0.0.1';
}

export function port() {
  const raw = (process.env.PORT ?? '').trim();
  if (raw === '') return 3000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3000;
}
