export function resolveInternalToolSecret(env: NodeJS.ProcessEnv = process.env) {
  return (env.BACKEND_INTERNAL_SECRET || env.HUB_INTERNAL_SECRET || '').trim();
}

export function isInternalToolSecretAuthorized(provided: string, expected: string) {
  return Boolean(expected) && provided === expected;
}