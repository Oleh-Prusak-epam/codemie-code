import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { ConfigLoader, canUseSharedIdentity } from '../utils/config.js';
import type { MultiProviderConfig, ProviderProfile, WorkspaceConfig } from '../env/types.js';

/**
 * Isolates CodeMie identity per global profile. Each field is handled by name
 * rather than a generic keyof loop, since codeMieIntegration is an object and
 * the others are strings — a mixed-type loop needs an `any` escape hatch.
 */
function hasIdentity(source: WorkspaceConfig | ProviderProfile): boolean {
  return source.codeMieUrl !== undefined || source.codeMieProject !== undefined || source.codeMieIntegration !== undefined;
}

// Per-field gap-fill, not all-or-nothing: a profile with its own
// codeMieProject but no codeMieUrl still gets codeMieUrl filled in.
// canUseSharedIdentity() (shared with the read-time fallback in config.ts —
// see its own doc comment) refuses only on positive evidence the shared value
// belongs to a different profile/environment; a vendor-subscription profile or
// a lone split-host ai-run-sso profile is always allowed.
function withIdentityFrom(
  profile: ProviderProfile,
  source: WorkspaceConfig,
  allProfiles: Record<string, ProviderProfile>,
  ownName: string
): { profile: ProviderProfile; changed: boolean } {
  if (!canUseSharedIdentity(profile, allProfiles, ownName, source.codeMieUrl)) {
    return { profile, changed: false };
  }
  const cloned: ProviderProfile = { ...profile };
  let changed = false;
  if (cloned.codeMieUrl === undefined && source.codeMieUrl !== undefined) {
    cloned.codeMieUrl = source.codeMieUrl;
    changed = true;
  }
  if (cloned.codeMieProject === undefined && source.codeMieProject !== undefined) {
    cloned.codeMieProject = source.codeMieProject;
    changed = true;
  }
  if (cloned.codeMieIntegration === undefined && source.codeMieIntegration !== undefined) {
    cloned.codeMieIntegration = source.codeMieIntegration;
    changed = true;
  }
  return { profile: cloned, changed };
}

function withoutIdentity(workspace: WorkspaceConfig): WorkspaceConfig {
  const { codeMieUrl: _codeMieUrl, codeMieProject: _codeMieProject, codeMieIntegration: _codeMieIntegration, ...rest } = workspace;
  return rest;
}

class IsolateGlobalProfileIdentityMigration implements Migration {
  id = '008-isolate-global-profile-identity';
  description = 'Clone the shared global workspace identity trio onto every global profile so each resolves its own CodeMie identity';

  async up(): Promise<MigrationResult> {
    const hasGlobal = await ConfigLoader.hasGlobalConfig();
    if (!hasGlobal) {
      return { success: true, migrated: false };
    }

    const globalConfig = await ConfigLoader.loadMultiProviderConfig();
    const migratedGlobal = this.migrate(globalConfig);
    if (migratedGlobal === globalConfig) {
      return { success: true, migrated: false };
    }

    await ConfigLoader.saveMultiProviderConfig(migratedGlobal);
    return { success: true, migrated: true };
  }

  migrate(config: MultiProviderConfig): MultiProviderConfig {
    const sharedWorkspace: WorkspaceConfig = config.workspace ?? {};
    if (!hasIdentity(sharedWorkspace)) return config;

    const sourceProfiles = config.profiles ?? {};
    const profiles: Record<string, ProviderProfile> = {};
    let anyChanged = false;
    for (const [name, profile] of Object.entries(sourceProfiles)) {
      const result = withIdentityFrom(profile, sharedWorkspace, sourceProfiles, name);
      profiles[name] = result.profile;
      anyChanged = anyChanged || result.changed;
    }

    // Nobody actually received the shared identity (every profile already had
    // its own, or every CodeMie-platform profile was refused) — keep workspace
    // rather than deleting data nobody got a chance to claim.
    if (!anyChanged) return config;

    return { ...config, profiles, workspace: withoutIdentity(sharedWorkspace) };
  }
}

const migration = new IsolateGlobalProfileIdentityMigration();
MigrationRegistry.register(migration);
export { IsolateGlobalProfileIdentityMigration };
