export interface TacticRecord {
  id: string;
  questionPattern: string;
  keywords: string[];
  tacticSequence: Array<{ tool: string; argsTemplate: string }>;
  successRate: number;
  usageCount: number;
}

export interface TacticRetrieval {
  matches: TacticRecord[];
  topMatch: TacticRecord | undefined;
  confidence: number;
}
