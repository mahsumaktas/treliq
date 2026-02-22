import type { LLMProvider } from './provider';
import type { IntentCategory } from './types';
import { createLogger } from './logger';

export type { IntentCategory } from './types';

const log = createLogger('intent');

const VALID_INTENTS: IntentCategory[] = ['bugfix', 'feature', 'refactor', 'dependency', 'docs', 'chore'];

export interface IntentResult {
  intent: IntentCategory;
  confidence: number;
  reason: string;
}

const CONVENTIONAL_MAP: Record<string, IntentCategory> = {
  fix: 'bugfix',
  hotfix: 'bugfix',
  feat: 'feature',
  feature: 'feature',
  refactor: 'refactor',
  perf: 'refactor',
  docs: 'docs',
  doc: 'docs',
  ci: 'chore',
  build: 'chore',
  style: 'chore',
  test: 'chore',
  chore: 'chore',
};

const CONVENTIONAL_RE = /^(\w+)(\([^)]*\))?!?:/;

export class IntentClassifier {
  private provider?: LLMProvider;

  constructor(provider?: LLMProvider) {
    this.provider = provider;
  }

  /** Full classification pipeline: conventional -> LLM -> heuristic */
  async classify(title: string, body: string, changedFiles: string[]): Promise<IntentResult> {
    // 1. Try conventional commit
    const conventional = this.classifyFromTitle(title);
    if (conventional) return conventional;

    // 2. Try LLM
    if (this.provider) {
      try {
        return await this.classifyWithLLM(title, body, changedFiles);
      } catch (err) {
        log.warn({ err }, 'LLM intent classification failed, using heuristic');
      }
    }

    // 3. Heuristic fallback
    return this.classifyFromHeuristic(title, changedFiles);
  }

  classifyFromTitle(title: string): IntentResult | null {
    const match = title.match(CONVENTIONAL_RE);
    if (!match) return null;

    const prefix = match[1].toLowerCase();
    const scope = match[2] ?? '';

    // Special case: chore(deps) -> dependency
    if ((prefix === 'chore' || prefix === 'build') && /deps|dependencies/i.test(scope)) {
      return { intent: 'dependency', confidence: 1.0, reason: `Conventional commit: ${prefix}(deps)` };
    }

    const intent = CONVENTIONAL_MAP[prefix];
    if (!intent) return null;

    return { intent, confidence: 1.0, reason: `Conventional commit: ${prefix}` };
  }

  classifyFromHeuristic(title: string, changedFiles: string[]): IntentResult {
    const lower = title.toLowerCase();

    // Dependency signals
    if (/\b(bump|upgrade|update|dependabot|renovate)\b/i.test(lower)) {
      const depFiles = changedFiles.filter(f => /package\.json|package-lock|yarn\.lock|Gemfile|requirements\.txt|go\.mod|Cargo\.toml/i.test(f));
      if (depFiles.length > 0 || /bump|dependabot|renovate/i.test(lower)) {
        return { intent: 'dependency', confidence: 0.8, reason: 'Dependency update keywords' };
      }
    }

    // Docs signals
    const allDocs = changedFiles.length > 0 && changedFiles.every(f =>
      /\.(md|txt|rst|adoc)$/i.test(f) || /readme|license|changelog|contributing|docs\//i.test(f)
    );
    if (allDocs) {
      return { intent: 'docs', confidence: 0.8, reason: 'All changed files are documentation' };
    }

    // Bugfix signals
    if (/\b(fix|bug|crash|error|issue|resolve|patch|hotfix)\b/i.test(lower)) {
      return { intent: 'bugfix', confidence: 0.7, reason: 'Bugfix keywords in title' };
    }

    // Refactor signals
    if (/\b(refactor|restructure|reorganize|cleanup|clean up|simplify|extract|move)\b/i.test(lower)) {
      return { intent: 'refactor', confidence: 0.7, reason: 'Refactor keywords in title' };
    }

    // Default to feature
    return { intent: 'feature', confidence: 0.5, reason: 'Default classification' };
  }

  async classifyWithLLM(title: string, body: string, changedFiles: string[]): Promise<IntentResult> {
    const filesStr = changedFiles.slice(0, 20).join(', ');
    const input = `Title: ${title}\nBody: ${(body ?? '').slice(0, 1000)}\nFiles: ${filesStr}`.slice(0, 2000);

    const prompt = `Classify this PR/Issue intent into exactly one category: bugfix, feature, refactor, dependency, docs, chore.
Return JSON: {"intent": "<category>", "confidence": <0-1>, "reason": "<brief>"}
${input}`;

    const text = await this.provider!.generateText(prompt, { temperature: 0.1, maxTokens: 100 });

    try {
      const match = text.match(/\{[^}]+\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (VALID_INTENTS.includes(parsed.intent)) {
          return {
            intent: parsed.intent,
            confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
            reason: String(parsed.reason ?? ''),
          };
        }
      }
    } catch { /* invalid JSON, fall through to heuristic */ }

    return this.classifyFromHeuristic(title, changedFiles);
  }
}
