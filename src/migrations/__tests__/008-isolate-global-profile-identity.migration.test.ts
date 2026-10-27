import { describe, it, expect } from 'vitest';
import { IsolateGlobalProfileIdentityMigration } from '../008-isolate-global-profile-identity.migration.js';
import type { MultiProviderConfig } from '../../env/types.js';

const migration = new IsolateGlobalProfileIdentityMigration();
const migrate = (config: any): MultiProviderConfig => migration.migrate(config);

describe('IsolateGlobalProfileIdentityMigration', () => {
  it('clones the shared workspace identity trio onto every global profile and strips it from workspace', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        'env-a': { provider: 'ai-run-sso', model: 'claude-sonnet-4-6' },
        'env-b': { provider: 'ai-run-sso', model: 'claude-sonnet-4-6' }
      },
      workspace: {
        codeMieUrl: 'https://shared.example.com',
        codeMieProject: 'shared-proj',
        hooks: { PreToolUse: [] }
      }
    };

    const result = migrate(config);

    expect((result.profiles['env-a'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-a'] as any).codeMieProject).toBe('shared-proj');
    expect((result.profiles['env-b'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-b'] as any).codeMieProject).toBe('shared-proj');
    expect(result.workspace?.codeMieUrl).toBeUndefined();
    expect(result.workspace?.codeMieProject).toBeUndefined();
    expect(result.workspace?.hooks).toEqual({ PreToolUse: [] });
  });

  it('does not overwrite a profile that already defines its own identity', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        'env-a': { provider: 'ai-run-sso', codeMieUrl: 'https://already-own.example.com' }
      },
      workspace: { codeMieUrl: 'https://shared.example.com' }
    };

    const result = migrate(config);

    expect((result.profiles['env-a'] as any).codeMieUrl).toBe('https://already-own.example.com');
  });

  it('fills only the missing identity fields on a profile that already defines some of its own, without dropping shared fields for other profiles', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: {
        // Already has its own codeMieProject but no codeMieUrl — a prior
        // partial-identity skip would leave codeMieUrl unrecoverable once the
        // shared workspace value is stripped below.
        'env-a': { provider: 'ai-run-sso', codeMieProject: 'env-a-own-proj' },
        'env-b': { provider: 'ai-run-sso' }
      },
      workspace: {
        codeMieUrl: 'https://shared.example.com',
        codeMieProject: 'shared-proj'
      }
    };

    const result = migrate(config);

    expect((result.profiles['env-a'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-a'] as any).codeMieProject).toBe('env-a-own-proj');
    expect((result.profiles['env-b'] as any).codeMieUrl).toBe('https://shared.example.com');
    expect((result.profiles['env-b'] as any).codeMieProject).toBe('shared-proj');
    expect(result.workspace?.codeMieUrl).toBeUndefined();
  });

  it('is a no-op when workspace has no identity fields', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: { 'env-a': { provider: 'anthropic-subscription' } },
      workspace: { hooks: { PreToolUse: [] } }
    };

    expect(migrate(config)).toBe(config);
  });

  it('is a no-op when workspace is undefined (not yet run through migration 007)', () => {
    const config: any = {
      version: 2,
      activeProfile: 'env-a',
      profiles: { 'env-a': { provider: 'anthropic-subscription' } }
    };

    expect(migrate(config)).toBe(config);
  });
});
