/**
 * st_proof_mine — extrae lemmas auxiliares reutilizables de un corpus de
 * proofs ST usando el módulo `proof-mining` de @stevenvo780/st-lang.
 *
 * Detecta sub-árboles que aparecen en múltiples pruebas, los generaliza
 * por anti-unificación y los rankea por savings × usageCount.
 */
import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { ok, fail } from '../shared';
import { mineLemmas, type MiningResult } from '@stevenvo780/st-lang/reasoning/proof-mining';
import type { ProofTrace, MinedLemma } from '@stevenvo780/st-lang/reasoning/proof-mining';
import { z } from 'zod';

// ── Input schema ───────────────────────────────────────────────────

const proofStepSchema = z.object({
  rule: z.string().min(1),
  inputs: z.array(z.string()),
  output: z.string().min(1),
  depth: z.number().int().min(0),
});

const proofTraceSchema = z.object({
  conclusion: z.string().min(1),
  premises: z.array(z.string()),
  profile: z.string().min(1),
  steps: z.array(proofStepSchema).min(1),
  cost: z.number().nonnegative(),
});

const miningOptionsSchema = z.object({
  minReuseThreshold: z.number().int().min(2).max(20).optional().default(2),
  maxAbstractionLevel: z.number().int().min(0).max(5).optional().default(3),
  preserveSemantic: z.boolean().optional().default(true),
  topK: z.number().int().min(1).max(50).optional().default(5),
}).optional();

const inputSchema = z.object({
  proofs: z.array(proofTraceSchema).min(2).max(50),
  options: miningOptionsSchema,
});

// ── Output helpers ─────────────────────────────────────────────────

function serializeLemma(l: MinedLemma) {
  return {
    id: l.id,
    statement: l.statement,
    usageCount: l.usageCount,
    savings: l.savings,
    abstractionLevel: l.abstractionLevel,
    sourceProofs: l.sourceProofs,
  };
}

// ── Executor ───────────────────────────────────────────────────────

export async function stProofMine(
  call: AgentToolCall,
  _ctx: AgentExecutionContext
): Promise<AgentToolExecutionResult> {
  const parsed = inputSchema.safeParse(call.args);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return fail(call, new Error(`Argumentos inválidos: ${msg}`));
  }

  const { proofs, options } = parsed.data;
  const topK = options?.topK ?? 5;

  const miningOpts: Parameters<typeof mineLemmas>[1] = {
    minReuseThreshold: options?.minReuseThreshold ?? 2,
    minSubtreeSize: 2,
  };

  let result: MiningResult;
  try {
    result = mineLemmas(proofs as ProofTrace[], miningOpts);
  } catch (e) {
    return fail(call, e instanceof Error ? e : new Error(String(e)));
  }

  const topLemmas = result.lemmas.slice(0, topK).map(serializeLemma);

  const summary = result.lemmas.length === 0
    ? `No se encontraron lemmas reutilizables en el corpus (${proofs.length} pruebas, threshold=${miningOpts.minReuseThreshold}).`
    : `Se extrajeron ${result.lemmas.length} lemmas del corpus. Top-${topLemmas.length} devueltos.`;

  return ok(call, summary, {
    lemmasCount: result.lemmas.length,
    topLemmas,
    stats: result.stats ?? null,
    corpusSize: proofs.length,
    options: {
      minReuseThreshold: miningOpts.minReuseThreshold,
      topK,
    },
  });
}
