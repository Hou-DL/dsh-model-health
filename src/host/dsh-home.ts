import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the DSH home directory. A machine may run several independent DSH
 * installs side by side; the active one advertises itself via `$DSH_HOME`, so
 * every path this plugin touches derives from it. Fallback `~/.dsh` only when
 * the variable is absent (mirrors core).
 */
export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  if (env) return env;
  return join(homedir(), ".dsh");
}

export function sessionsDir(): string {
  return join(dshHome(), "sessions");
}

export function storagesDir(): string {
  return join(dshHome(), "storages");
}
