/**
 * st_tactic_apply — aplica una táctica del DSL estilo Lean/Coq sobre un
 * goal ST y retorna el nuevo estado de la prueba.
 *
 * Tácticas soportadas (string libre que el usuario escribe):
 *   intro [name]  — introduce antecedente de P → Q como hipótesis
 *   exact <hyp>   — cierra goal con hipótesis exacta
 *   assumption    — busca hipótesis que pruebe el goal
 *   apply <hyp>   — backward chaining
 *   rewrite <eq> [right-to-left] — reescritura
 *   rfl           — reflexividad
 *   trivial       — cierra goals triviales (True / ex falso)
 *   split         — separa ∧ en dos sub-goals
 *   left | right  — ∨-intro
 *   destruct <hyp> — destruye conjunción en contexto
 *   induction <hyp>
 *   case <tag>
 *   unfold <name>
 *   simp
 */
import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { ok, fail } from '../shared';
import { z } from 'zod';
import {
  startProof,
  runTactic,
  isProven,
  summary,
  intro,
  exact,
  assumption,
  apply,
  rewrite,
  rfl,
  trivial,
  split,
  left,
  right,
  destruct,
  induction,
  caseAnalysis,
  unfold,
  simp,
  type Goal,
  type ProofState,
  type Tactic,
} from '@stevenvo780/st-lang/reasoning/tactic-dsl';

// ── Input schema ──────────────────────────────────────────────────

const contextHypSchema = z.object({
  name: z.string().min(1),
  statement: z.string().min(1),
});

const inputSchema = z.object({
  goal: z.string().min(1).max(10000),
  tactic: z.string().min(1).max(500),
  profile: z.string().optional().default('classical.propositional'),
  context: z.array(contextHypSchema).optional(),
});

// ── Tactic parser ──────────────────────────────────────────────────

/**
 * Parsea el string de táctica que escribe el usuario y devuelve la Tactic
 * correspondiente del DSL. Soporta: intro, exact, assumption, apply, rewrite,
 * rfl, trivial, split, left, right, destruct, induction, case, unfold, simp.
 */
function parseTacticString(raw: string): Tactic {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';
  const arg1 = parts[1];
  const arg2 = parts[2];

  switch (cmd) {
    case 'intro':
      return intro(arg1);
    case 'exact':
      if (!arg1) throw new Error('exact requiere un argumento (nombre de hipótesis o término).');
      return exact(arg1);
    case 'assumption':
      return assumption();
    case 'apply': {
      if (!arg1) throw new Error('apply requiere un argumento (nombre de hipótesis o lema).');
      const applyArgs = parts.slice(2).length > 0 ? parts.slice(2) : undefined;
      return apply(arg1, applyArgs);
    }
    case 'rewrite': {
      if (!arg1) throw new Error('rewrite requiere el nombre de la igualdad.');
      const dir: 'left-to-right' | 'right-to-left' | undefined =
        arg2 === 'right-to-left' ? 'right-to-left' :
        arg2 === 'left-to-right' ? 'left-to-right' :
        undefined;
      return rewrite(arg1, dir);
    }
    case 'rfl':
      return rfl();
    case 'trivial':
      return trivial();
    case 'split':
      return split();
    case 'left':
      return left();
    case 'right':
      return right();
    case 'destruct':
      if (!arg1) throw new Error('destruct requiere el nombre de la hipótesis a destruir.');
      return destruct(arg1);
    case 'induction':
      if (!arg1) throw new Error('induction requiere el nombre de la variable.');
      return induction(arg1);
    case 'case':
      if (!arg1) throw new Error('case requiere la etiqueta del caso.');
      return caseAnalysis(arg1);
    case 'unfold':
      if (!arg1) throw new Error('unfold requiere el nombre de la definición a expandir.');
      return unfold(arg1);
    case 'simp':
      return simp();
    default:
      throw new Error(
        `Táctica desconocida: "${cmd}". Tácticas soportadas: intro, exact, assumption, apply, rewrite, rfl, trivial, split, left, right, destruct, induction, case, unfold, simp.`
      );
  }
}

// ── Executor ───────────────────────────────────────────────────────

export async function stTacticApply(
  call: AgentToolCall,
  _ctx: AgentExecutionContext
): Promise<AgentToolExecutionResult> {
  const parsed = inputSchema.safeParse(call.args);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return fail(call, new Error(`Argumentos inválidos: ${msg}`));
  }

  const { goal, tactic, context } = parsed.data;

  // Build initial proof state
  const hyps: Record<string, string> = {};
  for (const h of context ?? []) {
    hyps[h.name] = h.statement;
  }

  let state: ProofState;
  try {
    state = startProof(goal, Object.keys(hyps).length > 0 ? hyps : undefined);
  } catch (e) {
    return fail(call, new Error(`Goal inválido: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Parse tactic string
  let tacticFn: Tactic;
  try {
    tacticFn = parseTacticString(tactic);
  } catch (e) {
    return fail(call, e instanceof Error ? e : new Error(String(e)));
  }

  // Apply tactic
  let newState: ProofState;
  try {
    newState = runTactic(state, tacticFn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return ok(call, `Táctica falló: ${msg}`, {
      complete: false,
      error: msg,
      goal,
      tactic,
      openGoals: state.goals.map((g: Goal) => ({ id: g.id, concl: g.concl, hyps: g.hyps })),
      newGoals: [],
      history: state.history.map(h => h.tactic),
    });
  }

  const complete = isProven(newState);
  const summaryStr = summary(newState);

  const openGoals = newState.goals.map((g: Goal) => ({
    id: g.id,
    concl: g.concl,
    hyps: g.hyps,
  }));

  const summarizedMsg = complete
    ? `Prueba completa. ${summaryStr}`
    : `Táctica aplicada. ${newState.goals.length} goal(s) restante(s).`;

  return ok(call, summarizedMsg, {
    complete,
    goal,
    tactic,
    openGoals,
    newGoals: openGoals,
    history: newState.history.map(h => h.tactic),
    summary: summaryStr,
  });
}
