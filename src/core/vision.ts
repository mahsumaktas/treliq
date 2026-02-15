/**
 * VisionChecker — Check PR alignment against project vision/roadmap
 *
 * Reads VISION.md or ROADMAP.md from repo, then uses LLM to judge
 * whether a PR aligns with the project direction.
 *
 * TODO: Implement in v0.1
 */

import type { ScoredPR } from './types';

export class VisionChecker {
  private visionDoc: string;

  constructor(visionDoc: string) {
    this.visionDoc = visionDoc;
  }

  async check(pr: ScoredPR): Promise<{
    alignment: 'aligned' | 'tangential' | 'off-roadmap';
    reason: string;
  }> {
    // TODO: Implement with Gemini/Claude
    // Prompt: "Given this project vision document and this PR,
    //          is the PR aligned with the project direction?"
    throw new Error('Not implemented yet');
  }
}
