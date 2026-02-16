/**
 * VisionChecker — Check PR alignment against project vision/roadmap using Gemini
 */

import type { ScoredPR } from './types';
import type { LLMProvider } from './provider';

export class VisionChecker {
  private visionDoc: string;
  private provider: LLMProvider;

  constructor(visionDoc: string, provider: LLMProvider) {
    this.visionDoc = visionDoc;
    this.provider = provider;
  }

  async check(pr: ScoredPR): Promise<{
    alignment: 'aligned' | 'tangential' | 'off-roadmap';
    score: number;
    reason: string;
  }> {
    const prompt = `Given this project vision:
${this.visionDoc.slice(0, 3000)}

Rate how well this PR aligns with the vision (0-100) and explain briefly:
PR Title: ${pr.title}
PR Body: ${(pr.body ?? '').slice(0, 2000)}

Respond with EXACTLY one JSON object (no markdown):
{"score": <0-100>, "alignment": "aligned"|"tangential"|"off-roadmap", "reason": "one sentence"}`;

    const text = await this.provider.generateText(prompt, { temperature: 0.1, maxTokens: 200 });

    try {
      const match = text.match(/\{[^}]+\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          score: Math.max(0, Math.min(100, Number(parsed.score) || 50)),
          alignment: parsed.alignment ?? 'tangential',
          reason: parsed.reason ?? 'No reason provided',
        };
      }
    } catch { /* fallback */ }

    return { alignment: 'tangential', score: 50, reason: 'Could not parse LLM response' };
  }
}
