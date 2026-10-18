import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fixtureDocument from '../../../docs/agent-refactor-v3.2-r4-final/schema-fixtures/fixtures.json';
import counterexampleDocument from '../../../docs/agent-refactor-v3.2-r4-final/source/R3_新增聚合状态反例.json';
import {
  registry, R4_REGISTRY_SHA256, R4_TOOL_NAMES, r4Tool,
  validateR4Input, validateR4Result,
} from '../../src/agent/r4-contracts';
import { validateR4ExecutionSemantics, type R4ExecutionSemanticInput } from '../../src/agent/r4-execution-semantics';
import { R4_SYSTEM_PROMPT, R4_USER_DECISION_AMENDMENT } from '../../src/agent/r4-system-prompt';
import { r4SdkInputFallbacks } from '../../src/agent/r4-sdk-input-fallbacks';

type Fixture = {
  id: string;
  tool: string;
  target: 'input' | 'result';
  valid: boolean;
  instance: unknown;
};

const fixtures = (fixtureDocument as { fixtures: Fixture[] }).fixtures;

describe('R4 registry contracts', () => {
  it('keeps the byte-identical Final registry and all canonical tools', () => {
    const path = fileURLToPath(new URL('../../src/agent/r4-registry.json', import.meta.url));
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(hash).toBe(R4_REGISTRY_SHA256);
    expect(registry.tools).toHaveLength(36);
    expect(new Set(registry.tools.map(tool => tool.canonical)).size).toBe(36);
    expect(registry.tools.map(tool => tool.canonical)).toEqual([...R4_TOOL_NAMES]);
    expect(r4Tool('read_creation')?.effect).toBe('read');
    expect(r4Tool('patch_creation_inputs')?.effect).toBe('creation_input_write');
    expect(r4Tool('not_a_tool')).toBeUndefined();
  });

  it('classifies strict input failures as preflight failures', () => {
    const invalid = validateR4Input('search_tags', { query: 'cat', unexpected: true });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) expect(invalid.resultKind).toBe('preflight_failure');
  });

  it('keeps all Pi transport fallbacks schema-valid without replacing raw host arguments', () => {
    expect(Object.keys(r4SdkInputFallbacks).sort()).toEqual([...R4_TOOL_NAMES].sort());
    for (const name of R4_TOOL_NAMES) expect(validateR4Input(name, r4SdkInputFallbacks[name]).valid, name).toBe(true);
  });

  it('does not label invalid results as preflight failures after a possible side effect', () => {
    const invalid = validateR4Result('generate_image', {
      resultKind: 'business', status: 'completed', data: { executionStatus: 'running' },
    });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) expect(invalid.kind).toBe('invalid_result');
  });

  it('matches every one of the 239 supplied input and result schema fixtures', () => {
    expect(fixtures).toHaveLength(239);
    const mismatches = fixtures.flatMap(fixture => {
      const outcome = fixture.target === 'input'
        ? validateR4Input(fixture.tool, fixture.instance)
        : validateR4Result(fixture.tool, fixture.instance);
      return outcome.valid === fixture.valid ? [] : [{ id: fixture.id, expected: fixture.valid, outcome }];
    });
    expect(mismatches).toEqual([]);
  });

  it('matches all 50 execution semantic cases with the product guard', () => {
    const cases = (fixtureDocument as { semanticCases: Array<{
      id: string; schemaValid: boolean; semanticValid: boolean;
      instance: { data: unknown };
    }> }).semanticCases;
    expect(cases).toHaveLength(50);
    const mismatches = cases.flatMap(testCase => {
      const outcome = validateR4ExecutionSemantics(testCase.instance.data as Parameters<typeof validateR4ExecutionSemantics>[0]);
      return outcome.valid === testCase.semanticValid ? [] : [{ id: testCase.id, expected: testCase.semanticValid, outcome }];
    });
    expect(mismatches).toEqual([]);
  });

  it('checks the durable execution model and reads immutable seed policy from its approved input', () => {
    const testCase = (fixtureDocument as { semanticCases: Array<{
      id: string; instance: { data: Record<string, unknown> };
    }> }).semanticCases.find(item => item.id === 'execution-running-pending-valid')!;
    const { executionStatus, readStatus: _readStatus, requestedSeedPolicy, requestedSeed, ...shared } = testCase.instance.data;
    const persisted = {
      ...shared,
      status: executionStatus,
      approvedInput: { publicParameters: { requestedSeedPolicy, requestedSeed } },
    } as unknown as R4ExecutionSemanticInput;
    expect(validateR4ExecutionSemantics(persisted).valid).toBe(true);

    const invalidSeed = {
      ...persisted,
      approvedInput: { publicParameters: { requestedSeedPolicy: 'random', requestedSeed: 42 } },
    } as unknown as R4ExecutionSemanticInput;
    expect(validateR4ExecutionSemantics(invalidSeed)).toMatchObject({
      valid: false, issues: [{ code: 'seed' }],
    });

    const pendingBoundary = {
      ...persisted,
      events: [
        { id: 'event_boundary_1', kind: 'native_request_boundary', at: '2026-10-18T00:00:00Z', detail: {
          kind: 'vibe_encode', sequence: 1, outputIndex: 0, dispatchClaimId: 'claim_1',
        } },
        { id: 'event_receipt_1', kind: 'native_request_receipt', at: '2026-10-18T00:00:01Z', detail: {
          kind: 'vibe_encode', sequence: 1, status: 'pending',
        } },
      ],
    } as unknown as R4ExecutionSemanticInput;
    expect(validateR4ExecutionSemantics(pendingBoundary).valid).toBe(true);
    const mismatchedSlot = {
      ...pendingBoundary,
      outputs: [{ outputIndex: 0, status: 'not_dispatched' }],
    } as unknown as R4ExecutionSemanticInput;
    expect(validateR4ExecutionSemantics(mismatchedSlot)).toMatchObject({
      valid: false, issues: [{ code: 'event:slot' }],
    });
  });

  it('keeps the frozen executable prompt candidate intact and appends the confirmed implementation amendment', () => {
    const path = fileURLToPath(new URL('../../../docs/agent-refactor-v3.2-r4-final/SYSTEM_PROMPT.md', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const candidate = source.match(/## 基础提示词候选\s+```text\r?\n([\s\S]*?)\r?\n```/);
    expect(candidate?.[1]).toBeDefined();
    expect(R4_SYSTEM_PROMPT).toBe(candidate![1] + R4_USER_DECISION_AMENDMENT);
    expect(R4_USER_DECISION_AMENDMENT).toContain('助手每次生图的正向词、负向词和风格词');
    expect(R4_USER_DECISION_AMENDMENT).toContain('read_generation_state 只读工作台');
    expect(R4_USER_DECISION_AMENDMENT).toContain('apply_prompt 只在用户明确要求应用时使用');
    expect(R4_SYSTEM_PROMPT).not.toContain('尚未替换产品提示词');
  });

  it('rejects all three R3 terminal aggregates that conceal pending work', () => {
    const cases = (counterexampleDocument as { cases: Array<{
      label: string; instance: unknown; schemaAccepted: boolean; expectedByWrittenContract: boolean;
    }> }).cases;
    expect(cases).toHaveLength(3);
    for (const testCase of cases) {
      const result = validateR4Result('get_execution', testCase.instance);
      expect(result.valid, `${testCase.label}: schema`).toBe(testCase.schemaAccepted);
      expect(testCase.expectedByWrittenContract).toBe(false);
      const data = (testCase.instance as { data: unknown }).data;
      const semantics = validateR4ExecutionSemantics(data as Parameters<typeof validateR4ExecutionSemantics>[0]);
      expect(semantics.valid, testCase.label).toBe(false);
    }
  });
});
