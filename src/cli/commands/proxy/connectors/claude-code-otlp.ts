/**
 * Writes/merges (`connect`) and strips/removes (`disconnect`) codemie's
 * OTel wiring in `.claude/settings.json`: the hook surface (8 events) pointed
 * at `codemie hook --agent claude-code-otlp`, and the OTel environment
 * variables pointing Claude Code's telemetry at the local proxy daemon.
 */

import { existsSync } from 'node:fs';
import type { HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { copyFile, readFile, unlink } from 'node:fs/promises';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { readState } from '../daemon-manager.js';
import { writeAtomically } from './vscode.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import {
  CODEMIE_ANALYTICS_PROJECT_FILTER_ENV,
  addProjectPath,
  canonicalizePath,
  getClaudeSettingsPath,
  parseAllowlist,
  removeProjectPath,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';

interface WriteClaudeCodeOtlpOptions {
  force?: boolean;
  scope?: 'user' | 'project';
}

interface WriteClaudeCodeOtlpResult {
  written: boolean;
  path: string;
  backupPath: string | null;
  hookEvents: number;
  envVars: number;
  /** Tracked project roots; empty means all projects. */
  allowlist: string[];
}

interface RemoveClaudeCodeOtlpOptions {
  scope?: 'user' | 'project';
}

interface RemoveClaudeCodeOtlpResult {
  removed: boolean;
  path: string | null;
  /** 'entry-removed': only this project's allowlist entry was dropped; 'full': all codemie wiring removed. */
  mode: 'entry-removed' | 'full' | 'noop';
  /** Human-readable reason when `removed` is false. */
  reason?: string;
  /** Remaining tracked project roots after an 'entry-removed' operation. */
  allowlist?: string[];
}

interface HookEntry {
  type: string;
  command: string;
  async?: boolean;
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: unknown[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  // Parsed from user-edited JSON, so an event's value is not guaranteed to be an array.
  hooks?: Record<string, unknown>;
  env?: Record<string, string>;
  [key: string]: unknown;
}

// CODEMIE_ANALYTICS_PROJECT_FILTER_ENV is deliberately not listed here: its value is managed per scope, not fixed.
export const CODEMIE_ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_LOG_TOOL_DETAILS',
] as const;

// Every CODEMIE_ENV_KEYS member except the two daemon-derived ones (their
// value embeds the live proxy URL/gateway key, so it can't be a fixed literal).
type FixedCodemieEnvKey = Exclude<
  (typeof CODEMIE_ENV_KEYS)[number],
  'OTEL_EXPORTER_OTLP_ENDPOINT' | 'OTEL_EXPORTER_OTLP_HEADERS'
>;

// Fixed values codemie writes for every key except the two daemon-derived
// ones. Lets disconnect recognize "codemie's own value" without a live
// daemon — disconnect never reads daemon state.
//
// Intentionally a full (non-Partial) Record over FixedCodemieEnvKey, not
// `Partial<Record<(typeof CODEMIE_ENV_KEYS)[number], string>>`: a Partial
// plus an `as Record<...>` cast at the `codemieEnv` call site would compile
// cleanly even if a future key were added to CODEMIE_ENV_KEYS without a
// fixed value defined for it here — silently leaving that key's merge,
// conflict-detection, and displaced-value restore all broken at runtime.
// This way, the compiler itself rejects an incomplete key set.
const CODEMIE_ENV_FIXED_VALUES: Record<FixedCodemieEnvKey, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_LOG_TOOL_DETAILS: '1',
};

/**
 * True if `value` is (still) codemie's own value for `key`, checked without
 * needing a live daemon: the two daemon-derived keys are matched by the fixed
 * suffix/prefix codemie always writes around the variable URL/token, the rest
 * by their fixed literal value.
 *
 * `value` is `unknown`, not `string`: settings are parsed from user-edited
 * JSON, so a key typed `string` in `ClaudeSettings.env` is not guaranteed to
 * actually hold one at runtime (e.g. a user nulling out a key in the file).
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` each
 * additionally require the OTHER to ALSO look like codemie's own (read from
 * `env`, the surrounding env block) — neither half is distinctive enough
 * alone: `Authorization=Bearer <token>` alone is the standard HTTP auth
 * scheme, and `/v1/analytics/otlp` alone is a plausible path on a user's own
 * unrelated OTLP collector that happens to follow a similar convention.
 * Pairing them sharply narrows false positives in both directions. `env`
 * must be a snapshot taken before any stripping mutates it — a caller
 * deleting one half earlier in the same pass must not make this check see
 * it as already gone.
 */
function isCodemieOwnedEnvValue(
  key: (typeof CODEMIE_ENV_KEYS)[number],
  value: unknown,
  env: Record<string, unknown>
): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (key === 'OTEL_EXPORTER_OTLP_ENDPOINT') {
    if (!value.endsWith('/v1/analytics/otlp')) {
      return false;
    }
    const headers = env.OTEL_EXPORTER_OTLP_HEADERS;
    return typeof headers === 'string' && headers.startsWith('Authorization=Bearer ');
  }
  if (key === 'OTEL_EXPORTER_OTLP_HEADERS') {
    if (!value.startsWith('Authorization=Bearer ')) {
      return false;
    }
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    return typeof endpoint === 'string' && endpoint.endsWith('/v1/analytics/otlp');
  }
  return CODEMIE_ENV_FIXED_VALUES[key] === value;
}

/**
 * Puts a value a `--force` connect once displaced into `backupEnv` back into
 * `baseEnv`, for any CODEMIE_ENV_KEYS key `baseEnv` doesn't already hold —
 * but only while `liveEnv` still carries codemie's OWN value for that key
 * right now. If the user touched it again since, the live value no longer
 * matches and this leaves `baseEnv` alone for that key.
 *
 * Shared by the connect-side backup refresh (carrying a displaced value
 * forward into the freshly rebuilt backup) and the disconnect-side restore
 * (putting a displaced value back into the live file being written).
 *
 * Returns `undefined` (never `{}`) when the result has no keys, so callers
 * can `delete` the settings' `env` key instead of leaving an empty object.
 */
function withDisplacedEnvValues(
  baseEnv: Record<string, string> | undefined,
  backupEnv: Record<string, string> | undefined,
  liveEnv: Record<string, string>
): Record<string, string> | undefined {
  if (!backupEnv) {
    return baseEnv;
  }
  const merged: Record<string, string> = { ...(baseEnv ?? {}) };
  for (const key of CODEMIE_ENV_KEYS) {
    if (merged[key] !== undefined) {
      continue;
    }
    const backupValue = backupEnv[key];
    const liveValue = liveEnv[key];
    if (backupValue !== undefined && liveValue !== undefined && isCodemieOwnedEnvValue(key, liveValue, liveEnv)) {
      merged[key] = backupValue;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Hook-events counterpart to `withDisplacedEnvValues`. A `--force` connect can
 * only ever displace a hook event's value by DROPPING it outright — a
 * malformed (non-array) value the user owns, which codemie never merges with
 * (see the "Phase 1" comment in `writeClaudeCodeOtlpConfig`). A well-formed
 * array value is never dropped; codemie always merges into it at the command
 * level instead. So the only thing this ever restores is a malformed value
 * `backupHooks` holds for an event `baseHooks` doesn't — and only while
 * `liveHooks` for that event is STILL an array containing codemie's own
 * command right now. If the user has since replaced that event with their own
 * array, or removed it, the live value no longer carries our command and this
 * leaves `baseHooks` alone for that key — the same AC3 guarantee
 * `withDisplacedEnvValues` gives env values.
 *
 * Shared by the connect-side backup refresh (carrying a displaced value
 * forward into the freshly rebuilt backup) and the disconnect-side restore
 * (putting a displaced value back into the live file being written).
 */
function withDisplacedHooks(
  baseHooks: Record<string, unknown> | undefined,
  backupHooks: Record<string, unknown> | undefined,
  liveHooks: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!backupHooks) {
    return baseHooks;
  }
  const merged: Record<string, unknown> = { ...(baseHooks ?? {}) };
  for (const [eventName, backupValue] of Object.entries(backupHooks)) {
    if (merged[eventName] !== undefined || Array.isArray(backupValue)) {
      continue;
    }
    const liveValue = liveHooks[eventName];
    if (Array.isArray(liveValue) && liveValue.some(groupContainsCodemieCommand)) {
      merged[eventName] = backupValue;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export const HOOK_EVENTS = [
  'SessionStart',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Notification',
] as const satisfies readonly HookEvent[];

export const SETTINGS_BACKUP_SUFFIX = '.codemie-backup';
export const CODEMIE_COMMAND_MARKER = `hook --agent ${CLAUDE_CODE_OTLP_AGENT_NAME}`;
export const CODEMIE_HOOK_TIMEOUT_SECONDS = 30;

async function readSettingsFile(settingsPath: string): Promise<ClaudeSettings> {
  if (!existsSync(settingsPath)) {
    return {};
  }

  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read Claude Code settings at ${settingsPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigurationError(`Claude Code settings must be a JSON object: ${settingsPath}`);
    }
    return parsed as ClaudeSettings;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(
      `Claude Code settings at ${settingsPath} is not valid JSON and was not changed.`
    );
  }
}

/**
 * True if a single hook entry (`{ type: 'command', command: '...' }`) is one
 * that codemie itself would write, identified by the command marker.
 *
 * This is intentionally the finest granularity we ever check at for
 * destructive operations (add/replace/remove) — never classify a whole hook
 * GROUP as "ours" for that purpose, since a group's `hooks[]` array may mix
 * our command with a user's own command(s).
 */
function isHookEntry(h: unknown): h is HookEntry {
  return typeof h === 'object' && h !== null && typeof (h as HookEntry).command === 'string';
}

function isHookGroup(group: unknown): group is HookGroup {
  return typeof group === 'object' && group !== null && Array.isArray((group as HookGroup).hooks);
}

function isCodemieCommand(h: unknown): boolean {
  return isHookEntry(h) && h.command.includes(CODEMIE_COMMAND_MARKER);
}

/**
 * True if a hook GROUP contains at least one codemie-owned command. Used only
 * for the "have we already touched this file before" backup heuristic in the
 * connect path — safe at group granularity since it's purely informational
 * (whether to snapshot a backup), never destructive.
 */
function groupContainsCodemieCommand(group: unknown): boolean {
  return isHookGroup(group) && group.hooks.some(isCodemieCommand);
}

/**
 * Given an existing array of hook groups for one event, returns a new array
 * with our own command(s) stripped out at the COMMAND level:
 *  - a group that still has foreign command(s) left is kept, with our
 *    command(s) removed and everything else (matcher, extra fields) intact;
 *  - a group that contained ONLY our command(s) is dropped entirely;
 *  - malformed/unrecognized entries are preserved as-is.
 *
 * Shared by both the connect (write) and disconnect (remove) paths.
 */
function stripCodemieCommandsFromGroups(existingGroups: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const group of existingGroups) {
    if (!isHookGroup(group)) {
      result.push(group);
      continue;
    }
    const remainingCommands = group.hooks.filter((h) => !isCodemieCommand(h));
    if (remainingCommands.length > 0) {
      result.push({ ...group, hooks: remainingCommands });
    }
  }
  return result;
}

interface StripCodemieManagedContentResult {
  stripped: ClaudeSettings;
  removedHookCommands: boolean;
  removedEnvKeys: boolean;
}

/**
 * Returns `existing` with every codemie-owned hook command and env key
 * removed, leaving only what the user owns. Used both to rebuild a missing
 * backup without re-copying our own writes (including the OTLP bearer
 * token), and to compute what disconnect should write back.
 *
 * Deliberately does NOT fall back to matching a live daemon's exact current
 * env values: the daemon's gateway key defaults to a fixed, non-secret,
 * user-visible string (`spawnDaemon`'s default in `daemon-manager.ts`) when
 * none is explicitly configured, so an exact-value match on
 * `OTEL_EXPORTER_OTLP_HEADERS` alone would be no stronger a signal than the
 * generic `Authorization=Bearer ` prefix `isCodemieOwnedEnvValue` already
 * refuses to trust by itself — it would silently reopen that exact false
 * positive. The structural pairing check alone is sufficient here: codemie
 * always writes `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`
 * together, and the ENDPOINT suffix it writes is invariant across daemon
 * restarts/port/key rotation, so there is no real scenario where ENDPOINT
 * fails the structural check for data codemie itself produced.
 */
function stripCodemieManagedContent(existing: ClaudeSettings): StripCodemieManagedContentResult {
  let removedHookCommands = false;
  const hooks: Record<string, unknown> = {};
  for (const [eventName, entries] of Object.entries(existing.hooks ?? {})) {
    if (!Array.isArray(entries)) {
      hooks[eventName] = entries;
      continue;
    }
    if (entries.some(groupContainsCodemieCommand)) {
      removedHookCommands = true;
    }
    const remainingGroups = stripCodemieCommandsFromGroups(entries);
    if (remainingGroups.length > 0) {
      hooks[eventName] = remainingGroups;
    }
  }

  const env: Record<string, string> = { ...(existing.env ?? {}) };
  // A snapshot taken BEFORE the loop below starts deleting keys from `env`.
  // isCodemieOwnedEnvValue's HEADERS check reads its sibling ENDPOINT key —
  // if we instead read the mutating `env`, ENDPOINT (checked earlier in
  // CODEMIE_ENV_KEYS order) could already be deleted by the time HEADERS is
  // checked, breaking the pairing check depending on iteration order.
  const originalEnv = existing.env ?? {};
  let removedEnvKeys = false;
  // Only strip a CODEMIE_ENV_KEYS entry whose VALUE is actually ours — a
  // foreign value that merely reuses one of our keys (e.g. the user's own
  // OTEL_EXPORTER_OTLP_ENDPOINT, or a coincidentally-matching
  // CLAUDE_CODE_ENABLE_TELEMETRY='1') must survive both the backup snapshot
  // and the disconnect result. Key-presence alone is not ownership.
  for (const key of CODEMIE_ENV_KEYS) {
    if (key in env && isCodemieOwnedEnvValue(key, env[key], originalEnv)) {
      removedEnvKeys = true;
      delete env[key];
    }
  }
  // Unlike CODEMIE_ENV_KEYS this key's value isn't a fixed literal (it's a
  // per-scope project list), so there is no exact-value check to gate on —
  // but presence alone is still not ownership, the same principle as every
  // CODEMIE_ENV_KEYS entry above. Gate on the value actually being a
  // well-formed allowlist (what codemie itself always writes there): an
  // unrelated env var that happens to share this exact, distinctive name
  // but holds some other kind of string is left alone rather than destroyed.
  if (CODEMIE_ANALYTICS_PROJECT_FILTER_ENV in env && parseAllowlist(env[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]).kind !== 'invalid') {
    removedEnvKeys = true;
    delete env[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV];
  }

  const stripped: ClaudeSettings = { ...existing };
  if (Object.keys(hooks).length > 0) {
    stripped.hooks = hooks;
  } else {
    delete stripped.hooks;
  }
  if (Object.keys(env).length > 0) {
    stripped.env = env;
  } else {
    delete stripped.env;
  }

  return { stripped, removedHookCommands, removedEnvKeys };
}

/**
 * Best-effort read of the backup file. Unlike `readSettingsFile`, never
 * throws: a missing, unreadable or corrupt backup just means nothing to
 * restore/carry forward from, not a connect/disconnect failure.
 *
 * Does NOT check the backup's age or which connect/disconnect "cycle" wrote
 * it — a value displaced by a `--force` connect long ago, with no
 * disconnect since, is still exactly as recoverable as one displaced a
 * moment ago; a time-based cutoff would silently drop it, trading one data-
 * loss bug for another. `withDisplacedEnvValues`/`withDisplacedHooks` already
 * gate every value this returns on the LIVE file currently holding codemie's
 * own value for that key — that is the staleness guard, not the backup's age.
 *
 * Does sanitize `env`: a hand-edited or foreign-tool-written backup could
 * hold a non-string value, which would otherwise flow untyped into the live
 * settings file through `withDisplacedEnvValues`. Any such entries are
 * dropped rather than letting the whole backup be discarded.
 */
async function readBackupSettings(backupPath: string): Promise<ClaudeSettings | null> {
  if (!existsSync(backupPath)) {
    return null;
  }
  try {
    const raw = await readFile(backupPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const settings = parsed as ClaudeSettings;
    if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
      const sanitizedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings.env)) {
        if (typeof value === 'string') {
          sanitizedEnv[key] = value;
        }
      }
      settings.env = sanitizedEnv;
    }
    return settings;
  } catch {
    // Corrupt/unreadable backup — nothing to restore, but the caller must still proceed.
  }
  return null;
}

export async function writeClaudeCodeOtlpConfig(
  opts: WriteClaudeCodeOtlpOptions = {}
): Promise<WriteClaudeCodeOtlpResult> {
  const state = await readState();
  if (!state) {
    throw new ConfigurationError('No live proxy daemon. Run: codemie proxy start');
  }

  // Always user-level: the allowlist (not the settings location) decides which projects are tracked.
  const settingsPath = getClaudeSettingsPath();

  const existing = await readSettingsFile(settingsPath);
  const existingHooksBlock = existing.hooks ?? {};

  const codemieEnv: Record<(typeof CODEMIE_ENV_KEYS)[number], string> = {
    ...CODEMIE_ENV_FIXED_VALUES,
    OTEL_EXPORTER_OTLP_ENDPOINT: `${state.url}/v1/analytics/otlp`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${state.gatewayKey}`,
  };

  // --- Conflict detection: env values AND malformed (non-array) hooks entries ---
  const existingEnv = existing.env ?? {};
  const envConflicts: string[] = [];
  for (const key of CODEMIE_ENV_KEYS) {
    const currentVal = existingEnv[key];
    const desiredVal = codemieEnv[key];
    if (currentVal !== undefined && currentVal !== desiredVal) {
      envConflicts.push(key);
    }
  }

  // A non-array value under ANY existing hooks event key (not just the ones we
  // currently manage) can't be safely merged with — silently discarding it
  // would be the same class of data loss this fix is about, just rarer.
  const malformedHookEvents: string[] = [];
  for (const [eventName, value] of Object.entries(existingHooksBlock)) {
    if (!Array.isArray(value)) {
      malformedHookEvents.push(eventName);
    }
  }

  if ((envConflicts.length > 0 || malformedHookEvents.length > 0) && !opts.force) {
    const parts: string[] = [];
    if (envConflicts.length > 0) {
      parts.push(`conflicting env values for: ${envConflicts.join(', ')}`);
    }
    if (malformedHookEvents.length > 0) {
      parts.push(`non-array hooks entries for: ${malformedHookEvents.join(', ')}`);
    }
    throw new ConfigurationError(
      `Claude Code settings already contain ${parts.join('; ')}. Re-run with --force to overwrite.`
    );
  }

  // --- Allowlist pre-check (before anything is written) ---
  const rawAllowlist: unknown = existingEnv[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV];
  const existingAllowlist = parseAllowlist(rawAllowlist);
  if (existingAllowlist.kind === 'invalid' && !opts.force) {
    throw new ConfigurationError(
      `Claude Code settings contain an invalid ${CODEMIE_ANALYTICS_PROJECT_FILTER_ENV} value: ${JSON.stringify(rawAllowlist)}. ` +
      `Fix it manually (expected a JSON array of absolute paths, e.g. '["/path/to/project"]') or re-run with --force to discard it.`
    );
  }

  let allowlist: string[] = [];
  if (opts.scope === 'project') {
    const current = existingAllowlist.kind === 'valid' ? existingAllowlist.paths : [];
    allowlist = await addProjectPath(current, resolveProjectRoot());
  }

  // --- Backup, keyed on whether CodeMie already owns part of the file (not on
  // whether a backup file happens to exist) ---
  let backupPath: string | null = null;
  if (existsSync(settingsPath)) {
    const backupPathCandidate = settingsPath + SETTINGS_BACKUP_SUFFIX;
    const alreadyManaged = Object.values(existingHooksBlock).some(
      (entries) => Array.isArray(entries) && entries.some(groupContainsCodemieCommand)
    ) || CODEMIE_ENV_KEYS.some((key) =>
      // The same structural ownership check used everywhere else in this
      // file (stripCodemieManagedContent, withDisplacedEnvValues) — not an
      // exact match against the CURRENT live daemon state. An exact match
      // would be strictly WEAKER for OTEL_EXPORTER_OTLP_HEADERS specifically:
      // the daemon's gateway key defaults to a fixed, non-secret, user-visible
      // string when none is configured (`spawnDaemon` in daemon-manager.ts),
      // so an exact match alone could be fooled by an unrelated collector
      // that happens to reuse that well-known default — exactly the false
      // positive the ENDPOINT/HEADERS pairing check exists to rule out. The
      // structural check is also rotation-invariant (the suffix/prefix it
      // looks for survives a daemon restart with a new port/key), so it loses
      // nothing an exact match would have caught.
      isCodemieOwnedEnvValue(key, existingEnv[key], existingEnv)
    );
    if (alreadyManaged) {
      // Already managed: always refresh (AC1 — a later connect can still
      // modify the live file further, e.g. an allowlist change, and the
      // backup must reflect THAT pre-connect state, not whichever one was
      // captured first). Rebuild by stripping our own content rather than
      // copying the file as-is, which would enshrine our own writes
      // (including the OTLP bearer token) as the "pre-connect original".
      const { stripped } = stripCodemieManagedContent(existing);

      // Carry forward a value a PRIOR --force connect displaced into the
      // existing backup: it is no longer present in `existing` itself
      // (codemie's own write replaced it), so stripping `existing` alone
      // would silently drop it from the refreshed backup.
      const oldBackup = await readBackupSettings(backupPathCandidate);
      const mergedEnv = withDisplacedEnvValues(stripped.env, oldBackup?.env, existingEnv);
      if (mergedEnv) {
        stripped.env = mergedEnv;
      } else {
        delete stripped.env;
      }

      // Same carry-forward for a hook event a PRIOR --force connect displaced
      // (dropped a malformed value) — otherwise it would be silently lost
      // from the refreshed backup before an eventual disconnect ever restores it.
      const mergedHooks = withDisplacedHooks(stripped.hooks, oldBackup?.hooks, existingHooksBlock);
      if (mergedHooks) {
        stripped.hooks = mergedHooks;
      } else {
        delete stripped.hooks;
      }

      // Nothing to protect (and no backup needed) if that leaves zero
      // foreign keys — e.g. a fresh install that only ever held our own
      // entries. Drop a stale backup from an earlier cycle rather than
      // leave outdated content behind.
      if (Object.keys(stripped).length > 0) {
        await writeAtomically(backupPathCandidate, JSON.stringify(stripped, null, 2) + '\n');
        backupPath = backupPathCandidate;
      } else if (existsSync(backupPathCandidate)) {
        // Best-effort, same reasoning as the disconnect-side backup unlink:
        // this is just dropping a now-unneeded stale backup, not the actual
        // state change this connect is making. A failure here (e.g. EPERM
        // from another process holding the file open) must not fail the
        // whole connect — worst case, a stale backup lingers until the next
        // connect/disconnect cycle removes or overwrites it.
        try {
          await unlink(backupPathCandidate);
        } catch (error) {
          logger.warn(
            '[proxy] Could not remove the now-unneeded stale backup file',
            ...sanitizeLogArgs({ backupPath: backupPathCandidate, error: error instanceof Error ? error.message : String(error) })
          );
        }
      }
    } else {
      // Not yet managed: always (re)snapshot, overwriting any stale previous backup.
      await copyFile(settingsPath, backupPathCandidate);
      backupPath = backupPathCandidate;
    }
  }

  // --- Merge hooks block ---
  const buildCodemieEntry = (): HookGroup => {
    const hook: HookEntry = {
      type: 'command',
      command: `codemie ${CODEMIE_COMMAND_MARKER}`,
      timeout: CODEMIE_HOOK_TIMEOUT_SECONDS,
    };
    return { matcher: '', hooks: [hook] };
  };

  // Phase 1: strip our own command from EVERY existing event key, not just the
  // ones we currently manage. This prevents orphaned commands if HOOK_EVENTS
  // ever shrinks between versions — an event this tool no longer manages
  // would otherwise keep a stale codemie command in it forever.
  const hooks: Record<string, unknown[]> = {};
  for (const [eventName, entries] of Object.entries(existingHooksBlock)) {
    if (!Array.isArray(entries)) {
      // Only reachable here when `force` is set (validated above) — an
      // explicit, consented overwrite. Drop the malformed value rather than
      // propagate it further.
      continue;
    }
    const strippedGroups = stripCodemieCommandsFromGroups(entries);
    if (strippedGroups.length > 0) {
      hooks[eventName] = strippedGroups;
    }
    // else: this event had ONLY our command(s) — drop the now-empty key
    // (this is also what cleans up orphans from a shrunk HOOK_EVENTS list).
  }

  // Phase 2: (re-)add our dedicated entry for every event we currently manage.
  for (const eventName of HOOK_EVENTS) {
    hooks[eventName] = [...(hooks[eventName] ?? []), buildCodemieEntry()];
  }

  // --- Merge env block ---
  const mergedEnv: Record<string, string> = {
    ...(existing.env ?? {}),
    ...codemieEnv,
    [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: JSON.stringify(allowlist),
  };

  const merged: ClaudeSettings = {
    ...existing,
    hooks,
    env: mergedEnv,
  };

  // `writeAtomically` creates the parent (`.claude`) directory itself.
  await writeAtomically(settingsPath, JSON.stringify(merged, null, 2) + '\n');

  const hookEventsCount = HOOK_EVENTS.length;
  const envVarsCount = CODEMIE_ENV_KEYS.length;

  logger.info(
    '[proxy] Configured Claude Code analytics',
    ...sanitizeLogArgs({ settingsPath, backupPath, hookEvents: hookEventsCount, envVars: envVarsCount, allowlist })
  );

  return {
    written: true,
    path: settingsPath,
    backupPath,
    hookEvents: hookEventsCount,
    envVars: envVarsCount,
    allowlist,
  };
}

export async function removeClaudeCodeOtlpConfig(
  opts: RemoveClaudeCodeOtlpOptions = {}
): Promise<RemoveClaudeCodeOtlpResult> {
  const settingsPath = getClaudeSettingsPath();

  if (!existsSync(settingsPath)) {
    return { removed: false, path: null, mode: 'noop', reason: 'no Claude Code settings file found' };
  }

  const existing = await readSettingsFile(settingsPath);

  if (opts.scope === 'project') {
    const allowlist = parseAllowlist(existing.env?.[CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]);
    if (allowlist.kind !== 'valid' || allowlist.paths.length === 0) {
      let reason: string;
      if (allowlist.kind === 'invalid') {
        reason = `${CODEMIE_ANALYTICS_PROJECT_FILTER_ENV} is invalid; fix it manually or run disconnect without --scope project`;
      } else if (allowlist.kind === 'absent') {
        reason = `${CODEMIE_ANALYTICS_PROJECT_FILTER_ENV} is not set`;
      } else {
        reason = 'all projects are tracked (no per-project entries)';
      }
      return { removed: false, path: settingsPath, mode: 'noop', reason };
    }

    const projectRoot = resolveProjectRoot();
    const remaining = await removeProjectPath(allowlist.paths, projectRoot);
    if (remaining.length === allowlist.paths.length) {
      return {
        removed: false,
        path: settingsPath,
        mode: 'noop',
        reason: `project ${await canonicalizePath(projectRoot)} is not in the allowlist`,
      };
    }

    if (remaining.length > 0) {
      const env = { ...(existing.env ?? {}), [CODEMIE_ANALYTICS_PROJECT_FILTER_ENV]: JSON.stringify(remaining) };
      await writeAtomically(settingsPath, JSON.stringify({ ...existing, env }, null, 2) + '\n');
      logger.info('[proxy] Removed project from Claude Code analytics allowlist', ...sanitizeLogArgs({ settingsPath, remaining }));
      return { removed: true, path: settingsPath, mode: 'entry-removed', allowlist: remaining };
    }
    // Last entry removed: fall through to the full removal below
  }

  const { stripped, removedHookCommands, removedEnvKeys } = stripCodemieManagedContent(existing);

  if (!removedHookCommands && !removedEnvKeys) {
    return { removed: false, path: settingsPath, mode: 'noop', reason: 'no CodeMie entries found' };
  }

  const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
  const backupSettings = await readBackupSettings(backupPath);

  // Put back a value a `--force` connect displaced into the backup (preserves
  // AC3 — never resurrects a value the user changed after connect; see
  // `withDisplacedEnvValues`).
  const restoredEnv = withDisplacedEnvValues(stripped.env, backupSettings?.env, existing.env ?? {});
  if (restoredEnv) {
    stripped.env = restoredEnv;
  } else {
    delete stripped.env;
  }

  // Same restore for a hook event a `--force` connect displaced (dropped a
  // malformed value) — see `withDisplacedHooks` for the AC3 guard.
  const restoredHooks = withDisplacedHooks(stripped.hooks, backupSettings?.hooks, existing.hooks ?? {});
  if (restoredHooks) {
    stripped.hooks = restoredHooks;
  } else {
    delete stripped.hooks;
  }

  const isEmpty = Object.keys(stripped).length === 0;

  // Always derive the result from the CURRENT live content (never restore raw
  // backup bytes, however fresh): a backup can still hold a value the user
  // changed or removed between the connect that captured it and this
  // disconnect, and restoring it would resurrect exactly that value. The
  // exception above is narrow and key-scoped: a value `--force` displaced and
  // that codemie still owns right now is put back instead of deleted.
  if (isEmpty) {
    await unlink(settingsPath);
  } else {
    await writeAtomically(settingsPath, JSON.stringify(stripped, null, 2) + '\n');
  }
  if (existsSync(backupPath)) {
    // Best-effort: the important state change (settings.json above) has
    // already landed by this point. A failure here (e.g. EPERM from another
    // process holding the file open) must not surface as "disconnect
    // failed" — that would mislead the user into thinking settings.json was
    // never touched. Worst case, a stale backup lingers on disk; the next
    // connect/disconnect cycle overwrites or removes it as usual.
    try {
      await unlink(backupPath);
    } catch (error) {
      logger.warn(
        '[proxy] Disconnected successfully but could not remove the stale backup file',
        ...sanitizeLogArgs({ backupPath, error: error instanceof Error ? error.message : String(error) })
      );
    }
  }

  logger.info(
    '[proxy] Removed Claude Code analytics entries from settings',
    ...sanitizeLogArgs({ settingsPath, deleted: isEmpty })
  );
  return { removed: true, path: settingsPath, mode: 'full' };
}
