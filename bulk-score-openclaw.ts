// Bulk score candidates using treliq's ScoringEngine with LLM
import { ScoringEngine } from './src/core/scoring.js';
import { IntentClassifier } from './src/core/intent.js';
import { createProvider } from './src/core/provider.js';
import { ConcurrencyController } from './src/core/concurrency.js';
import type { PRData, ScoredPR } from './src/core/types.js';
import { readFileSync, writeFileSync } from 'fs';
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
}

// Fetch detailed PR data from GitHub
async function fetchPRDetail(prNumber: number): Promise<PRData | null> {
  try {
    const raw = execFileSync('gh', [
      'api', `repos/openclaw/openclaw/pulls/${prNumber}`,
      '--jq', JSON.stringify({
        number: '.number',
        title: '.title',
        body: '(.body // "")[0:3000]',
        author: '.user.login',
        authorAssociation: '.author_association',
        createdAt: '.created_at',
        updatedAt: '.updated_at',
        headRef: '.head.ref',
        baseRef: '.base.ref',
        additions: '.additions',
        deletions: '.deletions',
        commits: '.commits',
        isDraft: '.draft',
        mergeable: '.mergeable_state',
      })
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });

    // gh api --jq with object template doesn't work well, use raw JSON
    return null; // Will use alternative approach
  } catch {
    return null;
  }
}

async function main() {
  const candidates: Candidate[] = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf8'));
  console.error(`Loading ${candidates.length} candidates...`);

  // Create provider
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set!');
    process.exit(1);
  }

  const model = process.env.TRELIQ_MODEL || undefined;
  const provider = createProvider('anthropic', apiKey, model);
  const engine = new ScoringEngine(provider, false, 5);
  const cc = new ConcurrencyController(3, 2, 1000);

  console.error(`Model: ${model || 'default (haiku)'}`);
  console.error(`Concurrency: 3, retry: 2, delay: 1000ms`);

  // Fetch detailed data for each PR and score
  let scored = 0;
  let failed = 0;
  const results: ScoredPR[] = [];

  // Process in batches
  const BATCH_SIZE = 10;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (candidate) => {
      return cc.execute(async () => {
        try {
          // Fetch full PR data from GitHub REST API
          const raw = execFileSync('gh', [
            'api', `repos/openclaw/openclaw/pulls/${candidate.number}`
          ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });

          const ghPR = JSON.parse(raw);

          // Fetch files
          let files: string[] = [];
          try {
            const filesRaw = execFileSync('gh', [
              'api', `repos/openclaw/openclaw/pulls/${candidate.number}/files`,
              '--jq', '.[].filename'
            ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
            files = filesRaw.trim().split('\n').filter(f => f);
          } catch {}

          // Build PRData
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
          };

          const result = await engine.score(prData);
          scored++;
          process.stderr.write(`[${scored + failed}/${candidates.length}] #${candidate.number}: score=${result.totalScore} (${result.intent})\n`);
          return result;
        } catch (err: any) {
          failed++;
          process.stderr.write(`[${scored + failed}/${candidates.length}] #${candidate.number}: FAILED - ${err.message?.substring(0, 100)}\n`);
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
    if (results.length % 50 < BATCH_SIZE) {
      writeFileSync(OUTPUT_FILE, JSON.stringify({
        scannedAt: new Date().toISOString(),
        scored: results.length,
        failed,
        rankedPRs: results.sort((a, b) => b.totalScore - a.totalScore),
      }, null, 2));
      process.stderr.write(`\n--- Intermediate save: ${results.length} scored, ${failed} failed ---\n\n`);
    }
  }

  // Final save
  const sorted = results.sort((a, b) => b.totalScore - a.totalScore);
  writeFileSync(OUTPUT_FILE, JSON.stringify({
    scannedAt: new Date().toISOString(),
    totalCandidates: candidates.length,
    scored: results.length,
    failed,
    rankedPRs: sorted,
  }, null, 2));

  console.error(`\nDone: ${results.length} scored, ${failed} failed`);
  console.error(`Results saved to ${OUTPUT_FILE}`);

  // Quick summary
  console.log('\n=== TRELIQ SCORING COMPLETE ===');
  console.log(`Scored: ${results.length}, Failed: ${failed}`);
  console.log('');
  console.log('Score distribution:');
  const brackets: Record<string, number> = { '90+': 0, '80-89': 0, '70-79': 0, '60-69': 0, '<60': 0 };
  for (const pr of sorted) {
    if (pr.totalScore >= 90) brackets['90+']++;
    else if (pr.totalScore >= 80) brackets['80-89']++;
    else if (pr.totalScore >= 70) brackets['70-79']++;
    else if (pr.totalScore >= 60) brackets['60-69']++;
    else brackets['<60']++;
  }
  for (const [k, v] of Object.entries(brackets)) console.log(`  ${k}: ${v}`);

  console.log('\nTop 30:');
  sorted.slice(0, 30).forEach((pr, i) => {
    console.log(`${(i+1).toString().padStart(2)}. #${pr.number} | Score: ${pr.totalScore} | ${pr.intent} | +${pr.additions}/-${pr.deletions}`);
    console.log(`    ${pr.title}`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
