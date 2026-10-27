import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { ConfigLoader } from '../utils/config.js';
import type { MultiProviderConfig, ProviderProfile, WorkspaceConfig } from '../env/types.js';

/**
 * CodeMie connectivity identity — isolated per global profile so switching
 * between global profiles never leaks one profile's identity onto another
 * (EPMCDME-15411). Handled as three explicit fields rather than a generic
 * keyof loop, mirroring migration 007's independence from ConfigLoader
 * internals: a generic loop over a mixed-type key union (codeMieIntegration
 * is an object, the other two are strings) cannot stay type-safe without an
 * `any` escape hatch, so each field is copied/stripped by name instead.
 */
function hasIdentity(source: WorkspaceConfig | ProviderProfile): boolean {
  return source.codeMieUrl !== undefined || source.codeMieProject !== undefined || source.codeMieIntegration !== undefined;
}

// Fills only the identity fields the profile is missing — a profile that
// already defines e.g. its own codeMieProject but not codeMieUrl must still
// receive codeMieUrl from the shared workspace, not be skipped wholesale
// (a per-field gap-fill, not an all-or-nothing clone).
function withIdentityFrom(profile: ProviderProfile, source: WorkspaceConfig): ProviderProfile {
  const cloned: ProviderProfile = { ...profile };
  if (cloned.codeMieUrl === undefined && source.codeMieUrl !== undefined) cloned.codeMieUrl = source.codeMieUrl;
  if (cloned.codeMieProject === undefined && source.codeMieProject !== undefined) cloned.codeMieProject = source.codeMieProject;
  if (cloned.codeMieIntegration === undefined && source.codeMieIntegration !== undefined) cloned.codeMieIntegration = source.codeMieIntegration;
  return cloned;
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

    const profiles: Record<string, ProviderProfile> = {};
    for (const [name, profile] of Object.entries(config.profiles ?? {})) {
      profiles[name] = withIdentityFrom(profile, sharedWorkspace);
    }

    return { ...config, profiles, workspace: withoutIdentity(sharedWorkspace) };
  }
}

const migration = new IsolateGlobalProfileIdentityMigration();
MigrationRegistry.register(migration);
export { IsolateGlobalProfileIdentityMigration };
