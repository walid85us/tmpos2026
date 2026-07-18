// Phase 4.0 M3 — fail-closed environment/config contract.
//
// PURE over an injected plain object: it reads only named keys and never
// enumerates or dumps the process environment. Production is never inferred
// from a permissive fallback. Failure carries only bounded field names and
// sanitized reason codes — never an environment value.
export type NodeEnvClass = 'test' | 'development' | 'staging' | 'production';

export type ConfigReason =
  | 'env_missing'
  | 'env_invalid'
  | 'port_missing'
  | 'port_invalid'
  | 'bool_invalid'
  | 'production_dev_flag_conflict';

export interface ConfigError {
  field: string;
  code: ConfigReason;
}

export interface RuntimeConfig {
  env: NodeEnvClass;
  port: number;
  isProduction: boolean;
  trustProxy: boolean;
}

// Single-interface (optional `config`) form: this repo is non-strict TS where
// discriminated-union narrowing on a boolean tag is lossy, so consumers read
// `config`/`errors` directly after checking `ok`.
export interface ConfigResult {
  ok: boolean;
  config?: RuntimeConfig;
  errors: ConfigError[];
}

const CLASSES: readonly NodeEnvClass[] = ['test', 'development', 'staging', 'production'];

// DEV-only action flags that must never be armed under a production classification.
const DEV_ACTION_FLAGS: readonly string[] = ['ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW'];

function parsePort(raw: string | undefined, errors: ConfigError[]): number | undefined {
  if (raw === undefined || raw === '') {
    errors.push({ field: 'PORT', code: 'port_missing' });
    return undefined;
  }
  // Base-10 digits only: rejects signed, hex, fractional, trailing chars, whitespace.
  if (!/^[0-9]+$/.test(raw)) {
    errors.push({ field: 'PORT', code: 'port_invalid' });
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    errors.push({ field: 'PORT', code: 'port_invalid' });
    return undefined;
  }
  return n;
}

function parseBool(field: string, raw: string | undefined, errors: ConfigError[]): boolean {
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  errors.push({ field, code: 'bool_invalid' });
  return false;
}

export function loadConfig(env: Record<string, string | undefined>): ConfigResult {
  const errors: ConfigError[] = [];

  const rawEnv = env.NODE_ENV;
  let envClass: NodeEnvClass | undefined;
  if (rawEnv === undefined || rawEnv === '') {
    errors.push({ field: 'NODE_ENV', code: 'env_missing' });
  } else if (!CLASSES.includes(rawEnv as NodeEnvClass)) {
    errors.push({ field: 'NODE_ENV', code: 'env_invalid' });
  } else {
    envClass = rawEnv as NodeEnvClass;
  }

  const port = parsePort(env.PORT, errors);
  const trustProxy = parseBool('TRUST_PROXY', env.TRUST_PROXY, errors);
  const isProduction = envClass === 'production';

  if (isProduction) {
    for (const flag of DEV_ACTION_FLAGS) {
      const v = env[flag];
      if (v !== undefined && v !== '' && v !== 'false') {
        errors.push({ field: flag, code: 'production_dev_flag_conflict' });
      }
    }
  }

  if (errors.length > 0 || envClass === undefined || port === undefined) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], config: { env: envClass, port, isProduction, trustProxy } };
}
