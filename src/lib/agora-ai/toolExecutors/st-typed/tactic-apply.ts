/**
 * st_tactic_apply — aplica una táctica del DSL estilo Lean/Coq sobre un
 * goal ST y retorna el nuevo estado de la prueba.
 *
 * El módulo tactic-dsl de @stevenvo780/st-lang no está registrado en los
 * "exports" del package.json (es un módulo interno). Se carga en runtime
 * vía createRequire para no violar el contrato de la API pública del paquete.
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
import { createRequire } from 'node:module';
import { createRequire as createRequireAlt } from 'module';
import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { ok, fail } from '../shared';
import { z } from 'zod';

// ── Minimal types for tactic-dsl (not publicly exported) ───────────

interface Goal {
  id: string;
  hyps: Record<string, string>;
  concl: string;
}

interface TacticInvocation {
  tactic: string;
  args: unknown[];
}

interface ProofState {
  goals: Goal[];
  history: TacticInvocation[];
  done: boolean;
}

type Tactic = (state: ProofState) => ProofState;

interface TacticDSLModule {
  startProof: (goal: string, hyps?: Record<string, string>) => ProofState;
  runTactic: (state: ProofState, t: Tactic) => ProofState;
  isProven: (state: ProofState) => boolean;
  summary: (state: ProofState) => string;
  TacticError: new (tactic: string, message: string) => Error & { tactic: string };
  intro: (name?: string) => Tactic;
  exact: (term: string) => Tactic;
  assumption: () => Tactic;
  apply: (thm: string, args?: string[]) => Tactic;
  rewrite: (eq: string, dir?: 'left-to-right' | 'right-to-left') => Tactic;
  rfl: () => Tactic;
  trivial: () => Tactic;
  split: () => Tactic;
  left: () => Tactic;
  right: () => Tactic;
  destruct: (hyp: string) => Tactic;
  induction: (hyp: string) => Tactic;
  caseAnalysis: (tag: string) => Tactic;
  unfold: (name: string) => Tactic;
  simp: () => Tactic;
}

// ── Lazy singleton loader ──────────────────────────────────────────

let _td: TacticDSLModule | undefined;

function loadTacticDSL(): TacticDSLModule {
  if (_td) return _td;
  // tactic-dsl is an internal module not registered in package.json exports.
  // We resolve the package root and then load the dist file directly.
  const req = createRequire(import.meta.url);
  const stLangRoot = req.resolve('@stevenvo780/st-lang');
  // stLangRoot = .../node_modules/@stevenvo780/st-lang/dist/index.js
  // We go 3 levels up to reach the package root, then load the internal subpath.
  const pkgRoot = stLangRoot.replace(/[\\/]dist[\\/]index\.js$/, '');
  const tacticPath = `${pkgRoot}/dist/reasoning/tactic-dsl/index.js`;
  _td = req(tacticPath) as TacticDSLModule;
  return _td;
}

// ── Input schema ───────────────────────────────────────────────────

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
function parseTacticString(raw: string, td: TacticDSLModule): Tactic {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';
  const arg1 = parts[1];
  const arg2 = parts[2];

  switch (cmd) {
    case 'intro':
      return td.intro(arg1);
    case 'exact':
      if (!arg1) throw new Error('exact requiere un argumento (nombre de hipótesis o término).');
      return td.exact(arg1);
    case 'assumption':
      return td.assumption();
    case 'apply': {
      if (!arg1) throw new Error('apply requiere un argumento (nombre de hipótesis o lema).');
      const applyArgs = parts.slice(2).length > 0 ? parts.slice(2) : undefined;
      return td.apply(arg1, applyArgs);
    }
    case 'rewrite': {
      if (!arg1) throw new Error('rewrite requiere el nombre de la igualdad.');
      const dir: 'left-to-right' | 'right-to-left' | undefined =
        arg2 === 'right-to-left' ? 'right-to-left' :
        arg2 === 'left-to-right' ? 'left-to-right' :
        undefined;
      return td.rewrite(arg1, dir);
    }
    case 'rfl':
      return td.rfl();
    case 'trivial':
      return td.trivial();
    case 'split':
      return td.split();
    case 'left':
      return td.left();
    case 'right':
      return td.right();
    case 'destruct':
      if (!arg1) throw new Error('destruct requiere el nombre de la hipótesis a destruir.');
      return td.destruct(arg1);
    case 'induction':
      if (!arg1) throw new Error('induction requiere el nombre de la variable.');
      return td.induction(arg1);
    case 'case':
      if (!arg1) throw new Error('case requiere la etiqueta del caso.');
      return td.caseAnalysis(arg1);
    case 'unfold':
      if (!arg1) throw new Error('unfold requiere el nombre de la definición a expandir.');
      return td.unfold(arg1);
    case 'simp':
      return td.simp();
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

  let td: TacticDSLModule;
  try {
    td = loadTacticDSL();
  } catch (e) {
    return fail(call, new Error(`No se pudo cargar el módulo tactic-dsl: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Build initial proof state
  const hyps: Record<string, string> = {};
  for (const h of context ?? []) {
    hyps[h.name] = h.statement;
  }

  let state: ProofState;
  try {
    state = td.startProof(goal, Object.keys(hyps).length > 0 ? hyps : undefined);
  } catch (e) {
    return fail(call, new Error(`Goal inválido: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Parse tactic string
  let tacticFn: Tactic;
  try {
    tacticFn = parseTacticString(tactic, td);
  } catch (e) {
    return fail(call, e instanceof Error ? e : new Error(String(e)));
  }

  // Apply tactic
  let newState: ProofState;
  try {
    newState = td.runTactic(state, tacticFn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return ok(call, `Táctica falló: ${msg}`, {
      complete: false,
      error: msg,
      goal,
      tactic,
      openGoals: state.goals.map(g => ({ id: g.id, concl: g.concl, hyps: g.hyps })),
      newGoals: [],
      history: state.history.map(h => h.tactic),
    });
  }

  const complete = td.isProven(newState);
  const summaryStr = td.summary(newState);

  const openGoals = newState.goals.map(g => ({
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
