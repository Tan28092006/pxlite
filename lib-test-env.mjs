// Shared env helpers for node:test files (name avoids node's test-* auto-discovery).
export const GATE_ENV_OFF = {
  PXLITE_FORCE_COLLAPSE_TOKENS: undefined,
  PXLITE_MIN_COLLAPSE_MESSAGES: undefined,
  PXLITE_MIN_SHRINK_TOKENS: undefined,
  PXLITE_TOOL_ROUND_CUT: undefined,
};

// Run fn with env vars set (undefined = deleted). Always restores, even when an assert throws.
export async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = String(vars[k]);
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}
