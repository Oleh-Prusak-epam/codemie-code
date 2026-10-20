/**
 * Real-life verification of CR-001 / CR-002 fixes (temporary — not part of the PR).
 *
 * Unlike cost-enricher.test.ts (which injects hand-built ParsedSession fixtures directly),
 * this drives the ACTUAL production file-parsing pipeline: real JSONL files written to a real
 * temp directory on disk, parsed by the real `ClaudeSessionAdapter` (the exact class
 * `realDeps.parseNative` uses in production — dedupeByUuid, timestamp extraction, sub-agent
 * discovery, metrics extraction all run for real), through the real `enrichCosts()` entrypoint.
 * Only `resolveAgentName`/`loadAgentSessionFile` are supplied directly (standing in for the
 * real CLI's correlation-file lookup); everything downstream is the unmodified, real code path.
 */
import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichCosts, type EnricherDeps } from '../cost-enricher.js';
import { ClaudeSessionAdapter } from '@/agents/plugins/claude/claude.session.js';
import { ClaudePluginMetadata } from '@/agents/plugins/claude/claude.plugin.js';

const adapter = new ClaudeSessionAdapter(ClaudePluginMetadata);

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('real-life verification (real JSONL file + real ClaudeSessionAdapter, not injected fixtures)', () => {
  it('CR-001: a crashed session does not swallow a later, cleanly-resumed session sharing one real transcript file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codemie-real-'));
    try {
      const filePath = join(dir, 'shared-resumed-transcript.jsonl');
      const base = Date.parse('2026-06-08T10:00:00Z');

      const turnA = {
        type: 'assistant',
        timestamp: new Date(base + 10_000).toISOString(),
        requestId: 'req-A',
        uuid: 'uuid-A',
        message: { id: 'msg-A', model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
      };
      const turnB1 = {
        type: 'assistant',
        timestamp: new Date(base + 130_000).toISOString(),
        requestId: 'req-B1',
        uuid: 'uuid-B1',
        message: { id: 'msg-B1', model: 'claude-sonnet-4-5', usage: { input_tokens: 500_000, output_tokens: 0 } },
      };
      const turnB2 = {
        type: 'assistant',
        timestamp: new Date(base + 140_000).toISOString(),
        requestId: 'req-B2',
        uuid: 'uuid-B2',
        message: { id: 'msg-B2', model: 'claude-sonnet-4-5', usage: { input_tokens: 500_000, output_tokens: 0 } },
      };
      await writeFile(filePath, jsonl([turnA, turnB1, turnB2]));

      const sessionA = { sessionId: 'A', startEvent: { agentName: 'claude', data: { startTime: base } }, deltas: [] };
      const sessionB = {
        sessionId: 'B',
        startEvent: { agentName: 'claude', data: { startTime: base + 120_000 } },
        endEvent: { data: { endTime: base + 180_000 } },
        deltas: [],
      };

      const deps: EnricherDeps = {
        resolveAgentName: () => 'claude',
        loadAgentSessionFile: async () => filePath, // real, shared path for both sessions
        parseNative: (_agentName, fp, sessionId) => adapter.parseSessionFile(fp, sessionId), // REAL parser, real disk I/O
      };

      const { index, summary } = await enrichCosts([sessionA, sessionB] as never[], deps);

      expect(index.get('A')!.tokens.total).toBe(1_000_000);
      expect(index.get('A')!.costUSD).toBeCloseTo(3, 6);
      expect(index.get('B')!.tokens.total).toBe(1_000_000);
      expect(index.get('B')!.costUSD).toBeCloseTo(3, 6);
      expect(summary.totalCostUSD).toBeCloseTo(6, 6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-002: two SDK-rollup runs sharing one real transcript file do not double-count each other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codemie-real-'));
    try {
      const filePath = join(dir, 'shared-sdk-rollups.jsonl');
      const resultA = { type: 'result', modelUsage: { 'claude-sonnet-4-5': { inputTokens: 1_000_000, outputTokens: 0 } } };
      const resultB = { type: 'result', modelUsage: { 'claude-sonnet-4-5': { inputTokens: 2_000_000, outputTokens: 0 } } };
      await writeFile(filePath, jsonl([resultA, resultB]));

      const base = Date.parse('2026-06-08T10:00:00Z');
      const sessionA = {
        sessionId: 'A',
        startEvent: { agentName: 'claude', data: { startTime: base } },
        endEvent: { data: { endTime: base + 30_000 } },
        deltas: [],
      };
      const sessionB = {
        sessionId: 'B',
        startEvent: { agentName: 'claude', data: { startTime: base + 60_000 } },
        endEvent: { data: { endTime: base + 90_000 } },
        deltas: [],
      };

      const deps: EnricherDeps = {
        resolveAgentName: () => 'claude',
        loadAgentSessionFile: async () => filePath,
        parseNative: (_agentName, fp, sessionId) => adapter.parseSessionFile(fp, sessionId), // REAL parser, real disk I/O
      };

      const { index } = await enrichCosts([sessionA, sessionB] as never[], deps);

      expect(index.get('A')!.tokens.total).not.toBe(3_000_000);
      expect(index.get('B')!.tokens.total).not.toBe(3_000_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
