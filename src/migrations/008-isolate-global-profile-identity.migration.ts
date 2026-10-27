import type { Migration, MigrationResult } from './types.js';
import { MigrationRegistry } from './registry.js';
import { ConfigLoader } from '../utils/config.js';
import type { MultiProviderConfig, ProviderProfile, WorkspaceConfig } from '../env/types.js';

/**
 * CodeMie connectivity identity — isolated per global profile so switching
 * between global profiles never leaks one profile's identity onto another
 * (EPMCDME-15411). Kept as an independent literal here, mirroring migration
 * 007, so the migration has no runtime dependency on ConfigLoader internals.
 */
const IDENTITY_KEYS: (keyof WorkspaceConfig)[] = ['codeMieUrl', 'codeMieProject', 'codeMieIntegration'];

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
    const hasIdentity = IDENTITY_KEYS.some(key => (config.workspace as any)?.[key] !== undefined);
    if (!hasIdentity) return config;

    const sharedWorkspace = config.workspace as WorkspaceConfig;
    const profiles: Record<string, ProviderProfile> = {};
    for (const [name, profile] of Object.entries(config.profiles ?? {})) {
      const definesOwnIdentity = IDENTITY_KEYS.some(key => (profile as any)[key] !== undefined);
      if (definesOwnIdentity) {
        profiles[name] = profile;
        continue;
      }

      const cloned: ProviderProfile = { ...profile };
      for (const key of IDENTITY_KEYS) {
        const value = (sharedWorkspace as any)[key];
        if (value !== undefined) {
          (cloned as any)[key] = value;
        }
      }
      profiles[name] = cloned;
    }

    const workspace: WorkspaceConfig = { ...sharedWorkspace };
    for (const key of IDENTITY_KEYS) {
      delete (workspace as any)[key];
    }

    return { ...config, profiles, workspace };
  }
}

const migration = new IsolateGlobalProfileIdentityMigration();
MigrationRegistry.register(migration);
export { IsolateGlobalProfileIdentityMigration };
