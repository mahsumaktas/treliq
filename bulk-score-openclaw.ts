// Bulk score OpenClaw PRs using cascade pipeline: Haiku pre-filter → Sonnet re-score
// Embedding: OpenAI text-embedding-3-small
import { ScoringEngine } from './src/core/scoring.js';
import { createProvider, OpenAIProvider } from './src/core/provider.js';
import { ConcurrencyController } from './src/core/concurrency.js';
import type { PRData, ScoredPR } from './src/core/types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const CANDIDATES_FILE = process.env.TRELIQ_INPUT || '/tmp/openclaw-full-scan/treliq-input.json';
const OUTPUT_FILE = process.env.TRELIQ_OUTPUT || '/tmp/openclaw-full-scan/treliq-scored.json';

interface Candidate {
  number: number;
  title: string;
  author: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  ci: string;
  approved: boolean;
  categories: string[];
  ageDays: number;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergeable: string;
  state?: string; // open, closed, merged
}

function mapPRState(ghPR: any): 'open' | 'closed' | 'merged' {
  if (ghPR.merged_at || ghPR.merged) return 'merged';
  if (ghPR.state === 'closed') return 'closed';
  return 'open';
}

async function main() {
  const candidates: Candidate[] = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf8'));
  console.error(`Loading ${candidates.length} candidates...`);

  // Provider setup
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY not set!');
    process.exit(1);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiEmbedding = openaiKey ? new OpenAIProvider(openaiKey) : undefined;

  // Cascade mode: TRELIQ_CASCADE=1 enables Haiku → Sonnet pipeline
  const cascadeEnabled = process.env.TRELIQ_CASCADE === '1';
  const haikuModel = process.env.TRELIQ_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
  const sonnetModel = process.env.TRELIQ_SONNET_MODEL || 'claude-sonnet-4-6';
  const preFilterThreshold = parseInt(process.env.TRELIQ_PREFILTER || '15', 10);
  const haikuThreshold = parseInt(process.env.TRELIQ_HAIKU_THRESHOLD || '40', 10);

  let engine: ScoringEngine;

  if (cascadeEnabled) {
    const haiku = createProvider('anthropic', anthropicKey, haikuModel, openaiEmbedding);
    const sonnet = createProvider('anthropic', anthropicKey, sonnetModel, openaiEmbedding);
    engine = new ScoringEngine({
      provider: haiku,
      maxConcurrent: 5,
      cascade: {
        enabled: true,
        reScoreProvider: sonnet,
        preFilterThreshold,
        haikuThreshold,
      },
    });
    console.error(`Cascade: Haiku(${haikuModel}) → Sonnet(${sonnetModel})`);
    console.error(`Thresholds: preFilter=${preFilterThreshold}, haiku=${haikuThreshold}`);
  } else {
    const model = process.env.TRELIQ_MODEL || undefined;
    const provider = createProvider('anthropic', anthropicKey, model, openaiEmbedding);
    engine = new ScoringEngine(provider, false, 5);
    console.error(`Single model: ${model || 'default (haiku)'}`);
  }

  if (openaiEmbedding) {
    console.error('Embedding: OpenAI text-embedding-3-small');
  }

  const cc = new ConcurrencyController(3, 2, 1000);

  // Resume support: load existing results
  let results: ScoredPR[] = [];
  const scoredNumbers = new Set<number>();
  if (existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
      if (existing.rankedPRs?.length > 0) {
        results = existing.rankedPRs;
        for (const pr of results) scoredNumbers.add(pr.number);
        console.error(`Resuming: ${results.length} already scored, skipping...`);
      }
    } catch {}
  }

  const remaining = candidates.filter(c => !scoredNumbers.has(c.number));
  console.error(`To score: ${remaining.length} (skipped ${candidates.length - remaining.length})`);

  let scored = 0;
  let failed = 0;
  const BATCH_SIZE = 10;

  // Cascade stats tracking
  const cascadeStats = { heuristic: 0, haiku: 0, sonnet: 0 };

  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    const batch = remaining.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (candidate) => {
      return cc.execute(async () => {
        try {
          const raw = execFileSync('gh', [
            'api', `repos/openclaw/openclaw/pulls/${candidate.number}`
          ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });

          const ghPR = JSON.parse(raw);

          let files: string[] = [];
          try {
            const filesRaw = execFileSync('gh', [
              'api', `repos/openclaw/openclaw/pulls/${candidate.number}/files`,
              '--jq', '.[].filename'
            ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
            files = filesRaw.trim().split('\n').filter(f => f);
          } catch {}

          const testFiles = files.filter(f => /test|spec|__tests__/i.test(f));
          const body = (ghPR.body || '').substring(0, 3000);
          const issueRefs = body.match(/#(\d+)/g)?.map((m: string) => parseInt(m.slice(1))) || [];

          const prData: PRData = {
            number: ghPR.number,
            title: ghPR.title,
            body,
            author: ghPR.user?.login || 'unknown',
            authorAssociation: ghPR.author_association || 'NONE',
            createdAt: ghPR.created_at,
            updatedAt: ghPR.updated_at,
            headRef: ghPR.head?.ref || '',
            baseRef: ghPR.base?.ref || 'main',
            filesChanged: ghPR.changed_files || files.length,
            additions: ghPR.additions || 0,
            deletions: ghPR.deletions || 0,
            commits: ghPR.commits || 1,
            labels: (ghPR.labels || []).map((l: any) => l.name),
            ciStatus: candidate.ci === 'SUCCESS' ? 'success' : 'unknown',
            hasIssueRef: issueRefs.length > 0,
            issueNumbers: issueRefs,
            changedFiles: files,
            diffUrl: ghPR.diff_url || '',
            hasTests: testFiles.length > 0,
            testFilesChanged: testFiles,
            ageInDays: candidate.ageDays,
            mergeable: candidate.mergeable === 'MERGEABLE' ? 'mergeable' :
                       candidate.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
            reviewState: candidate.approved ? 'approved' : 'none',
            reviewCount: candidate.approved ? 1 : 0,
            commentCount: ghPR.comments || 0,
            isDraft: ghPR.draft || false,
            milestone: ghPR.milestone?.title,
            requestedReviewers: (ghPR.requested_reviewers || []).map((r: any) => r.login),
            codeowners: [],
            state: mapPRState(ghPR),
          };

          const result = await engine.score(prData);
          scored++;

          const tag = result.scoredBy ? `[${result.scoredBy}]` : '';
          const steal = result.readyToSteal ? ' STEAL' : '';
          process.stderr.write(`[${scored + failed}/${remaining.length}] #${candidate.number}: score=${result.totalScore} ${tag}${steal} (${result.intent})\n`);

          if (result.scoredBy) cascadeStats[result.scoredBy]++;

          return result;
        } catch (err: any) {
          failed++;
          process.stderr.write(`[${scored + failed}/${remaining.length}] #${candidate.number}: FAILED - ${err.message?.substring(0, 100)}\n`);
          return null;
        }
      });
    });

    const batchResults = await Promise.allSettled(batchPromises);
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      }
    }

    // Save intermediate results every 50 PRs
    if (scored % 50 < BATCH_SIZE) {
      writeFileSync(OUTPUT_FILE, JSON.stringify({
        scannedAt: new Date().toISOString(),
        scored: results.length,
        failed,
        cascadeStats,
        rankedPRs: results.sort((a, b) => b.totalScore - a.totalScore),
      }, null, 2));
      process.stderr.write(`\n--- Save: ${results.length} scored, ${failed} failed | cascade: H=${cascadeStats.heuristic} K=${cascadeStats.haiku} S=${cascadeStats.sonnet} ---\n\n`);
    }
  }

  // Final save
  const sorted = results.sort((a, b) => b.totalScore - a.totalScore);
  writeFileSync(OUTPUT_FILE, JSON.stringify({
    scannedAt: new Date().toISOString(),
    totalCandidates: candidates.length,
    scored: results.length,
    failed,
    cascadeStats,
    rankedPRs: sorted,
  }, null, 2));

  console.error(`\nDone: ${results.length} scored, ${failed} failed`);
  console.error(`Results saved to ${OUTPUT_FILE}`);

  // Summary
  console.log('\n=== TRELIQ SCORING COMPLETE ===');
  console.log(`Scored: ${results.length}, Failed: ${failed}`);

  if (cascadeEnabled) {
    console.log(`\nCascade pipeline:`);
    console.log(`  Heuristic (pre-filtered): ${cascadeStats.heuristic}`);
    console.log(`  Haiku (final):            ${cascadeStats.haiku}`);
    console.log(`  Sonnet (re-scored):       ${cascadeStats.sonnet}`);
    const haikuCalls = cascadeStats.haiku + cascadeStats.sonnet;
    const sonnetCalls = cascadeStats.sonnet;
    console.log(`  LLM calls: ${haikuCalls} Haiku + ${sonnetCalls} Sonnet`);
  }

  console.log('\nScore distribution:');
  const brackets: Record<string, number> = { '90+': 0, '80-89': 0, '70-79': 0, '60-69': 0, '<60': 0 };
  for (const pr of sorted) {
    if (pr.totalScore >= 90) brackets['90+']++;
    else if (pr.totalScore >= 80) brackets['80-89']++;
    else if (pr.totalScore >= 70) brackets['70-79']++;
    else if (pr.totalScore >= 60) brackets['60-69']++;
    else brackets['<60']++;
  }
  for (const [k, v] of Object.entries(brackets)) console.log(`  ${k}: ${v}`);

  console.log('\nTier distribution:');
  const tiers: Record<string, number> = { critical: 0, high: 0, normal: 0, low: 0 };
  for (const pr of sorted) {
    if (pr.tier) tiers[pr.tier]++;
  }
  for (const [k, v] of Object.entries(tiers)) console.log(`  ${k}: ${v}`);

  // readyToSteal PRs
  const stealable = sorted.filter(pr => pr.readyToSteal);
  if (stealable.length > 0) {
    console.log(`\nReady to steal (${stealable.length}):`);
    stealable.slice(0, 20).forEach((pr, i) => {
      console.log(`${(i+1).toString().padStart(2)}. #${pr.number} | idea=${pr.ideaScore} impl=${pr.implementationScore} | ${pr.title}`);
    });
  }

  console.log('\nTop 30:');
  sorted.slice(0, 30).forEach((pr, i) => {
    const tag = pr.scoredBy ? `[${pr.scoredBy}]` : '';
    const steal = pr.readyToSteal ? ' STEAL' : '';
    console.log(`${(i+1).toString().padStart(2)}. #${pr.number} | Score: ${pr.totalScore} idea=${pr.ideaScore ?? '-'} impl=${pr.implementationScore ?? '-'} ${tag}${steal} | ${pr.intent}`);
    console.log(`    ${pr.title}`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
