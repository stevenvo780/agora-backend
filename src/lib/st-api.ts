import {
  check as rawCheck,
  completion as rawCompletion,
  createInterpreter as rawCreateInterpreter,
  evaluate as rawEvaluate,
  gotoDefinition as rawGotoDefinition,
  hover as rawHover,
  listProfiles as rawListProfiles,
  parse as rawParse,
  quickEval as rawQuickEval,
  symbols as rawSymbols,
  type CompletionItem,
  type STInterpreter
} from '@stevenvo780/st-lang/api';

export type {
  CompletionItem,
  Diagnostic,
  Formula,
  HoverInfo,
  Program,
  SourceLocation,
  Statement,
  STInterpreter,
  STEvalResult,
  SymbolInfo,
  TheorySummary
} from '@stevenvo780/st-lang/api';

export const ST_COMPAT_KEYWORDS = [
  'premise',
  'premisa',
  'conclusion',
  'therefore',
  'por_tanto'
] as const;

export const ST_COMPAT_OPERATORS = [
  '¬',
  '∧',
  '∨',
  '→',
  '↔',
  '⊢',
  '|-',
  '⊥',
  '⊤'
] as const;

export const completion = (): CompletionItem[] => rawCompletion();
export const check = rawCheck;
export const evaluate = rawEvaluate;
export const quickEval = rawQuickEval;
export const parse = rawParse;
export const symbols = rawSymbols;
export const hover = rawHover;
export const gotoDefinition = rawGotoDefinition;
export const listProfiles = rawListProfiles;
export const createInterpreter = (): STInterpreter => rawCreateInterpreter();
