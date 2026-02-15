/**
 * VisionChecker — Check PR alignment against project vision/roadmap using Gemini
 */

import type { ScoredPR } from './types';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export class VisionChecker {
  private visionDoc: string;
  private geminiApiKey: string;

  constructor(visionDoc: string, geminiApiKey?: string) {
    this.visionDoc = visionDoc;
    this.geminiApiKey = geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';
  }

  async check(pr: ScoredPR): Promise<{
    alignment: 'aligned' | 'tangential' | 'off-roadmap';
    score: number;
    reason: string;
  }> {
    await sleep(100); // Rate limiting

    const prompt = `Given this project vision:
${this.visionDoc.slice(0, 3000)}

Rate how well this PR aligns with the vision (0-100) and explain briefly:
PR Title: ${pr.title}
PR Body: ${(pr.body ?? '').slice(0, 2000)}

Respond with EXACTLY one JSON object (no markdown):
{"score": <0-100>, "alignment": "aligned"|"tangential"|"off-roadmap", "reason": "one sentence"}`;

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

    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

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
