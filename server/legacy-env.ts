/**
 * Ovis read its settings from HERDR_WEB_* variables before the rename to OVIS_*. Installs keep
 * those in herdr's plugin env file, shell profiles and service units, so each one still works:
 * an OVIS_* variable that is not set takes the value of its old name, and one that is set wins.
 * Imported first by every entry point, before any module reads its settings.
 */

const LEGACY_PREFIX = "HERDR_WEB_";
/** old names that do not map by prefix alone */
const RENAMED: Record<string, string> = { HERDR_WEB_UI_REF: "OVIS_REF" };

/** The OVIS_* name an old HERDR_WEB_* variable now goes by, or null for any other name. */
export function ovisName(legacy: string): string | null {
  if (!legacy.startsWith(LEGACY_PREFIX)) return null;
  return RENAMED[legacy] ?? `OVIS_${legacy.slice(LEGACY_PREFIX.length)}`;
}

/** Fills each unset OVIS_* variable from its old name, in place. */
export function adoptLegacyEnv(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    const next = ovisName(name);
    if (next !== null && value !== undefined && env[next] === undefined) env[next] = value;
  }
}

adoptLegacyEnv(process.env);
