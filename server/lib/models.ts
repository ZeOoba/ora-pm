// Single source of the default Anthropic model id for this repo (OI-256). Callers import this
// instead of hardcoding an id, so a model bump is a one-line change. The INTAKE_MODEL env override
// and its allowlist (server/routes/intake.ts) are unchanged.
export const ANTHROPIC_MODEL = 'claude-opus-5'
