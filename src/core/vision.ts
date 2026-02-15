/**
 * VisionChecker — Check PR alignment against project vision/roadmap using Gemini
 */

import type { ScoredPR } from './types';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

export class VisionChecker {
  private visionDoc: string;
  private geminiApiKey: string;

  constructor(visionDoc: string, geminiApiKey?: string) {
    this.visionDoc = visionDoc;
    this.geminiApiKey = geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';
  }

  async check(pr: ScoredPR): Promise<{
    alignment: 'aligned' | 'tangential' | 'off-roadmap';
    reason: string;
  }> {
    const prompt = `You are a project maintainer. Given the project vision document and a pull request, classify the PR's alignment.

VISION DOCUMENT:
${this.visionDoc.slice(0, 3000)}

PULL REQUEST:
Title: ${pr.title}
Description: ${(pr.body ?? '').slice(0, 1000)}
Files changed: ${pr.changedFiles.slice(0, 15).join(', ')}
Author: ${pr.author} (${pr.authorAssociation})

Respond with EXACTLY one JSON object (no markdown):
{"alignment": "aligned"|"tangential"|"off-roadmap", "reason": "one sentence explanation"}`;

    const res = await fetch(`${GEMINI_URL}?key=${this.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API error: ${res.status}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    try {
      const match = text.match(/\{[^}]+\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          alignment: parsed.alignment ?? 'unchecked',
          reason: parsed.reason ?? 'No reason provided',
        };
      }
    } catch { /* fallback */ }

    return { alignment: 'tangential', reason: 'Could not parse LLM response' };
  }
}
