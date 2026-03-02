// Bulk score OpenClaw PRs
// Legacy mode: cascade pipeline via env vars + input file
// Nightly mode: Sonnet-only, fetch from GitHub, cumulative cache
import { Command } from 'commander';
import { ScoringEngine } from './src/core/scoring.js';
import { createProvider, OpenAIProvider } from './src/core/provider.js';
import { ConcurrencyController } from './src/core/concurrency.js';
import type { PRData, ScoredPR } from './src/core/types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';

// ─── CLI ────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .option('--nightly', 'Nightly scan: Sonnet-only, fetch from GitHub')
  .option('--limit <n>', 'Max PRs to score', '500')
  .option('--sort <order>', 'newest|oldest', 'newest')
  .option('--skip-cached', 'Skip PRs already in score-cache.json')
  .option('--include-closed <period>', 'Include closed PRs merged within period (e.g. 28d)')
  .option('--force-rescore', 'Ignore cache, re-score all')
  .parse();

const opts = program.opts();

// ─── Shared types ───────────────────────────────────────────────────────────

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
  state?: string;
}

interface FetchedPR {
  number: number;
  title: string;
  body: string;
  author: string;
  authorAssociation: string;
  state: 'open' | 'closed' | 'merged';
  createdAt: string;
  updatedAt: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  commits: number;
  labels: string[];
  draft: boolean;
  milestone?: string;
  mergeable: string;
  commentCount: number;
}

interface NightlyCachedScore {
  totalScore: number;
  ideaScore: number;
  implementationScore: number;
  readinessScore: number;
  tier: string;
  readyToSteal: boolean;
  scoredBy: string;
  intent: string;
  noveltyBonus: number;
  title: string;
  author: string;
  state: string;
  scoredAt: string;
  updatedAt: string;
  headSha: string;
}

interface NightlyScoreCache {
  version: 1;
  repo: string;
  lastUpdated: string;
  prs: Record<string, NightlyCachedScore>;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

const REPO = 'openclaw/openclaw';
const RESULTS_DIR = 'results';

function mapPRState(ghPR: any): 'open' | 'closed' | 'merged' {
  if (ghPR.merged_at || ghPR.merged) return 'merged';
  if (ghPR.state === 'closed') return 'closed';
  return 'open';
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function ensureResultsDir(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(`${RESULTS_DIR}/logs`, { recursive: true });
}

/** Build PRData from a GitHub API PR object */
function ghPRtoPRData(ghPR: any, files: string[]): PRData {
  const testFiles = files.filter(f => /test|spec|__tests__/i.test(f));
  const body = (ghPR.body || '').substring(0, 3000);
  const issueRefs = body.match(/#(\d+)/g)?.map((m: string) => parseInt(m.slice(1))) || [];
  const ageMs = Date.now() - new Date(ghPR.created_at).getTime();
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  return {
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
    ciStatus: 'unknown',
    hasIssueRef: issueRefs.length > 0,
    issueNumbers: issueRefs,
    changedFiles: files,
    diffUrl: ghPR.diff_url || '',
    hasTests: testFiles.length > 0,
    testFilesChanged: testFiles,
    ageInDays: ageDays,
    mergeable: ghPR.mergeable_state === 'clean' ? 'mergeable' :
               ghPR.mergeable_state === 'dirty' ? 'conflicting' : 'unknown',
    reviewState: 'none',
    reviewCount: 0,
    commentCount: ghPR.comments || 0,
    isDraft: ghPR.draft || false,
    milestone: ghPR.milestone?.title,
    requestedReviewers: (ghPR.requested_reviewers || []).map((r: any) => r.login),
    codeowners: [],
    state: mapPRState(ghPR),
  };
}

// ─── Nightly: fetchPRsFromGitHub ────────────────────────────────────────────

function fetchPRsFromGitHub(limit: number, sort: 'newest' | 'oldest', includeClosedDays?: number): FetchedPR[] {
  const direction = sort === 'newest' ? 'desc' : 'asc';
  const results: FetchedPR[] = [];
  const seen = new Set<number>();

  // Fetch open PRs (manual pagination, no --paginate)
  let page = 1;
  while (results.length < limit) {
    const perPage = Math.min(100, limit - results.length);
    try {
      const raw = execFileSync('gh', [
        'api', `repos/${REPO}/pulls?state=open&per_page=${perPage}&sort=created&direction=${direction}&page=${page}`,
      ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

      const prs = JSON.parse(raw);
      if (!Array.isArray(prs) || prs.length === 0) break;

      for (const pr of prs) {
        if (seen.has(pr.number)) continue;
        seen.add(pr.number);
        results.push(mapGitHubPR(pr));
        if (results.length >= limit) break;
      }

      if (prs.length < perPage) break;
      page++;
    } catch (err: any) {
      process.stderr.write(`[fetchPRs] Open page ${page} failed: ${err.message?.substring(0, 100)}\n`);
      break;
    }
  }

  process.stderr.write(`[fetchPRs] Open PRs fetched: ${results.length}\n`);

  // Fetch closed/merged PRs (optional)
  if (includeClosedDays && includeClosedDays > 0 && results.length < limit) {
    const cutoff = new Date(Date.now() - includeClosedDays * 24 * 60 * 60 * 1000);
    let closedPage = 1;
    let done = false;

    while (!done && results.length < limit) {
      const perPage = Math.min(100, limit - results.length);
      try {
        const raw = execFileSync('gh', [
          'api', `repos/${REPO}/pulls?state=closed&per_page=${perPage}&sort=updated&direction=desc&page=${closedPage}`,
        ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

        const prs = JSON.parse(raw);
        if (!Array.isArray(prs) || prs.length === 0) break;

        for (const pr of prs) {
          const updatedAt = new Date(pr.updated_at);
          if (updatedAt < cutoff) { done = true; break; }
          if (seen.has(pr.number)) continue;
          seen.add(pr.number);
          results.push(mapGitHubPR(pr));
          if (results.length >= limit) break;
        }

        if (prs.length < perPage) break;
        closedPage++;
      } catch (err: any) {
        process.stderr.write(`[fetchPRs] Closed page ${closedPage} failed: ${err.message?.substring(0, 100)}\n`);
        break;
      }
    }

    process.stderr.write(`[fetchPRs] Total with closed: ${results.length}\n`);
  }

  // Sort final list
  results.sort((a, b) => {
    const d = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return sort === 'newest' ? d : -d;
  });

  return results.slice(0, limit);
}

function mapGitHubPR(ghPR: any): FetchedPR {
  return {
    number: ghPR.number,
    title: ghPR.title,
    body: (ghPR.body || '').substring(0, 3000),
    author: ghPR.user?.login || 'unknown',
    authorAssociation: ghPR.author_association || 'NONE',
    state: mapPRState(ghPR),
    createdAt: ghPR.created_at,
    updatedAt: ghPR.updated_at,
    headRef: ghPR.head?.ref || '',
    headSha: ghPR.head?.sha || '',
    baseRef: ghPR.base?.ref || 'main',
    additions: ghPR.additions || 0,
    deletions: ghPR.deletions || 0,
    filesChanged: ghPR.changed_files || 0,
    commits: ghPR.commits || 1,
    labels: (ghPR.labels || []).map((l: any) => l.name),
    draft: ghPR.draft || false,
    milestone: ghPR.milestone?.title,
    mergeable: ghPR.mergeable_state || 'unknown',
    commentCount: ghPR.comments || 0,
  };
}

// ─── Nightly: Score Cache ───────────────────────────────────────────────────

const CACHE_PATH = `${RESULTS_DIR}/score-cache.json`;

function loadScoreCache(): NightlyScoreCache | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (data.version === 1) return data;
  } catch {}
  return null;
}

function saveScoreCache(cache: NightlyScoreCache): void {
  ensureResultsDir();
  cache.lastUpdated = new Date().toISOString();
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function isCacheHit(cache: NightlyScoreCache | null, pr: FetchedPR): NightlyCachedScore | null {
  if (!cache) return null;
  const cached = cache.prs[String(pr.number)];
  if (!cached) return null;
  // Invalidate if PR was updated or head SHA changed
  if (cached.headSha && pr.headSha && cached.headSha !== pr.headSha) return null;
  if (cached.updatedAt && pr.updatedAt && cached.updatedAt !== pr.updatedAt) return null;
  return cached;
}

function scoredPRToCacheEntry(result: ScoredPR, pr: FetchedPR): NightlyCachedScore {
  return {
    totalScore: result.totalScore,
    ideaScore: result.ideaScore ?? 0,
    implementationScore: result.implementationScore ?? 0,
    readinessScore: result.readinessScore ?? 0,
    tier: result.tier || 'low',
    readyToSteal: result.readyToSteal ?? false,
    scoredBy: result.scoredBy || 'unknown',
    intent: result.intent || 'chore',
    noveltyBonus: result.noveltyBonus ?? 0,
    title: result.title,
    author: result.author,
    state: pr.state,
    scoredAt: new Date().toISOString(),
    updatedAt: pr.updatedAt,
    headSha: pr.headSha,
  };
}

// ─── Nightly: updateReadyToSteal ────────────────────────────────────────────

function updateReadyToSteal(cache: NightlyScoreCache): void {
  const stealable = Object.entries(cache.prs)
    .filter(([, pr]) => pr.readyToSteal)
    .map(([num, pr]) => ({ number: parseInt(num), ...pr }))
    .sort((a, b) => b.totalScore - a.totalScore);

  writeFileSync(`${RESULTS_DIR}/ready-to-steal.json`, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: stealable.length,
    prs: stealable,
  }, null, 2));
}

// ─── Nightly: generateSummary ───────────────────────────────────────────────

interface NightlySummaryData {
  newScored: number;
  cacheHit: number;
  failedCount: number;
  durationMs: number;
  cache: NightlyScoreCache;
  todayResults: ScoredPR[];
}

function generateSummary(data: NightlySummaryData): void {
  const { newScored, cacheHit, failedCount, durationMs, cache, todayResults } = data;
  const date = today();
  const totalCached = Object.keys(cache.prs).length;
  const durationMin = (durationMs / 60000).toFixed(1);

  // Tier distribution (cumulative cache)
  const tiers: Record<string, number> = { critical: 0, high: 0, normal: 0, low: 0 };
  for (const pr of Object.values(cache.prs)) {
    if (pr.tier in tiers) tiers[pr.tier]++;
  }

  // Score distribution (cumulative)
  const brackets: Record<string, number> = { '90+': 0, '80-89': 0, '70-79': 0, '60-69': 0, '50-59': 0, '<50': 0 };
  for (const pr of Object.values(cache.prs)) {
    if (pr.totalScore >= 90) brackets['90+']++;
    else if (pr.totalScore >= 80) brackets['80-89']++;
    else if (pr.totalScore >= 70) brackets['70-79']++;
    else if (pr.totalScore >= 60) brackets['60-69']++;
    else if (pr.totalScore >= 50) brackets['50-59']++;
    else brackets['<50']++;
  }

  // New readyToSteal from today
  const newStealable = todayResults
    .filter(pr => pr.readyToSteal)
    .sort((a, b) => b.totalScore - a.totalScore);

  // Top 10 from today
  const top10 = [...todayResults]
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 10);

  let md = `# Treliq Nightly Scan — ${date}\n\n`;
  md += `## Overview\n`;
  md += `- Yeni skorlanan: ${newScored}\n`;
  md += `- Cache hit: ${cacheHit}\n`;
  md += `- Basarisiz: ${failedCount}\n`;
  md += `- Sure: ${durationMin} dakika\n`;
  md += `- Kumlatif: ${totalCached}\n\n`;

  md += `## Tier Dagilimi (kumlatif)\n`;
  md += `| Tier | Sayi |\n|------|------|\n`;
  for (const [tier, count] of Object.entries(tiers)) {
    md += `| ${tier} | ${count} |\n`;
  }
  md += '\n';

  if (newStealable.length > 0) {
    md += `## Ready to Steal (Yeni)\n`;
    md += `| # | Score | Idea | Impl | Title |\n|---|-------|------|------|-------|\n`;
    for (const pr of newStealable) {
      md += `| ${pr.number} | ${pr.totalScore} | ${pr.ideaScore ?? '-'} | ${pr.implementationScore ?? '-'} | ${pr.title.substring(0, 60)} |\n`;
    }
    md += '\n';
  }

  if (top10.length > 0) {
    md += `## Top 10 (bugun)\n`;
    md += `| # | Score | Tier | Intent | Title |\n|---|-------|------|--------|-------|\n`;
    for (const pr of top10) {
      md += `| ${pr.number} | ${pr.totalScore} | ${pr.tier || '-'} | ${pr.intent || '-'} | ${pr.title.substring(0, 60)} |\n`;
    }
    md += '\n';
  }

  md += `## Score Dagilimi (kumlatif)\n`;
  md += `| Aralik | Sayi |\n|--------|------|\n`;
  for (const [range, count] of Object.entries(brackets)) {
    md += `| ${range} | ${count} |\n`;
  }

  writeFileSync(`${RESULTS_DIR}/${date}-summary.md`, md);
}

// ─── nightlyMain ────────────────────────────────────────────────────────────

async function nightlyMain(cliOpts: Record<string, any>): Promise<void> {
  const startTime = Date.now();
  const limit = parseInt(cliOpts.limit, 10) || 500;
  const sort = cliOpts.sort === 'oldest' ? 'oldest' as const : 'newest' as const;
  const skipCached = !!cliOpts.skipCached;
  const forceRescore = !!cliOpts.forceRescore;
  const includeClosedDays = cliOpts.includeClosed ? parseInt(cliOpts.includeClosed.replace(/d$/, ''), 10) : undefined;

  ensureResultsDir();

  // Provider: Sonnet-only, no cascade
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY not set!');
    process.exit(1);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiEmbedding = openaiKey ? new OpenAIProvider(openaiKey) : undefined;
  const sonnetModel = process.env.TRELIQ_SONNET_MODEL || 'claude-sonnet-4-6';

  const provider = createProvider('anthropic', anthropicKey, sonnetModel, openaiEmbedding);
  const engine = new ScoringEngine(provider, false, 5);
  console.error(`Nightly mode: Sonnet(${sonnetModel}), limit=${limit}, sort=${sort}`);

  if (openaiEmbedding) {
    console.error('Embedding: OpenAI text-embedding-3-small');
  }

  const cc = new ConcurrencyController(3, 2, 1000);

  // Load cache
  let cache: NightlyScoreCache = forceRescore ? null! : loadScoreCache() ?? null!;
  if (!cache) {
    cache = { version: 1, repo: REPO, lastUpdated: new Date().toISOString(), prs: {} };
  }
  console.error(`Cache: ${Object.keys(cache.prs).length} entries loaded`);

  // Resume: absorb intermediate file into cache
  const intermediateFile = `${RESULTS_DIR}/${today()}-intermediate.json`;
  if (existsSync(intermediateFile)) {
    try {
      const intermediate: ScoredPR[] = JSON.parse(readFileSync(intermediateFile, 'utf8'));
      let absorbed = 0;
      for (const pr of intermediate) {
        const key = String(pr.number);
        if (!cache.prs[key]) {
          cache.prs[key] = {
            totalScore: pr.totalScore,
            ideaScore: pr.ideaScore ?? 0,
            implementationScore: pr.implementationScore ?? 0,
            readinessScore: pr.readinessScore ?? 0,
            tier: pr.tier || 'low',
            readyToSteal: pr.readyToSteal ?? false,
            scoredBy: pr.scoredBy || 'unknown',
            intent: pr.intent || 'chore',
            noveltyBonus: pr.noveltyBonus ?? 0,
            title: pr.title,
            author: pr.author,
            state: pr.state || 'open',
            scoredAt: new Date().toISOString(),
            updatedAt: pr.updatedAt,
            headSha: pr.headRef || '',
          };
          absorbed++;
        }
      }
      if (absorbed > 0) {
        saveScoreCache(cache);
        console.error(`Resume: absorbed ${absorbed} entries from intermediate file`);
      }
      // Remove intermediate file after absorption
      const { unlinkSync } = await import('fs');
      unlinkSync(intermediateFile);
    } catch (err: any) {
      console.error(`Resume: intermediate file parse failed: ${err.message}`);
    }
  }

  // Fetch PRs from GitHub
  console.error(`\nFetching PRs from GitHub...`);
  const fetchedPRs = fetchPRsFromGitHub(limit, sort, includeClosedDays);
  console.error(`Fetched: ${fetchedPRs.length} PRs\n`);

  // Split: cache hit vs need scoring
  const toScore: FetchedPR[] = [];
  const fromCache: FetchedPR[] = [];

  for (const pr of fetchedPRs) {
    if (skipCached && !forceRescore) {
      const hit = isCacheHit(cache, pr);
      if (hit) {
        fromCache.push(pr);
        continue;
      }
    }
    toScore.push(pr);
  }

  console.error(`To score: ${toScore.length}, cache hit: ${fromCache.length}\n`);

  // Scoring loop
  let scored = 0;
  let failed = 0;
  const todayResults: ScoredPR[] = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < toScore.length; i += BATCH_SIZE) {
    const batch = toScore.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (fetchedPR) => {
      return cc.execute(async () => {
        try {
          // Fetch full PR detail
          const raw = execFileSync('gh', [
            'api', `repos/${REPO}/pulls/${fetchedPR.number}`
          ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
          const ghPR = JSON.parse(raw);

          // Fetch file list
          let files: string[] = [];
          try {
            const filesRaw = execFileSync('gh', [
              'api', `repos/${REPO}/pulls/${fetchedPR.number}/files`,
              '--jq', '.[].filename'
            ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
            files = filesRaw.trim().split('\n').filter(f => f);
          } catch {}

          const prData = ghPRtoPRData(ghPR, files);
          const result = await engine.score(prData);
          scored++;

          const tag = result.scoredBy ? `[${result.scoredBy}]` : '';
          const steal = result.readyToSteal ? ' STEAL' : '';
          process.stderr.write(`[${scored + failed}/${toScore.length}] #${fetchedPR.number}: score=${result.totalScore} ${tag}${steal} (${result.intent})\n`);

          // Update cache
          cache.prs[String(fetchedPR.number)] = scoredPRToCacheEntry(result, fetchedPR);

          return result;
        } catch (err: any) {
          failed++;
          process.stderr.write(`[${scored + failed}/${toScore.length}] #${fetchedPR.number}: FAILED - ${err.message?.substring(0, 100)}\n`);
          return null;
        }
      });
    });

    const batchResults = await Promise.allSettled(batchPromises);
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) {
        todayResults.push(r.value);
      }
    }

    // Intermediate save every 50 PRs
    if (scored > 0 && scored % 50 < BATCH_SIZE) {
      writeFileSync(intermediateFile, JSON.stringify(todayResults));
      saveScoreCache(cache);
      process.stderr.write(`\n--- Checkpoint: ${scored} scored, ${failed} failed, cache=${Object.keys(cache.prs).length} ---\n\n`);
    }
  }

  // Final saves
  saveScoreCache(cache);
  updateReadyToSteal(cache);

  // Remove intermediate file on success
  if (existsSync(intermediateFile)) {
    const { unlinkSync } = await import('fs');
    unlinkSync(intermediateFile);
  }

  // Generate summary
  const durationMs = Date.now() - startTime;
  generateSummary({
    newScored: scored,
    cacheHit: fromCache.length,
    failedCount: failed,
    durationMs,
    cache,
    todayResults,
  });

  // Full day output
  const sorted = [...todayResults].sort((a, b) => b.totalScore - a.totalScore);
  writeFileSync(`${RESULTS_DIR}/${today()}.json`, JSON.stringify({
    scannedAt: new Date().toISOString(),
    newScored: scored,
    cacheHit: fromCache.length,
    failed,
    durationMs,
    rankedPRs: sorted,
  }, null, 2));

  // Stdout summary (for cron)
  const totalCached = Object.keys(cache.prs).length;
  console.log(`\n=== TRELIQ NIGHTLY SCAN — ${today()} ===`);
  console.log(`Scored: ${scored}, Cache hit: ${fromCache.length}, Failed: ${failed}`);
  console.log(`Kumlatif cache: ${totalCached}`);
  console.log(`Sure: ${(durationMs / 60000).toFixed(1)} dakika`);

  // Tier distribution
  const tiers: Record<string, number> = { critical: 0, high: 0, normal: 0, low: 0 };
  for (const pr of Object.values(cache.prs)) {
    if (pr.tier in tiers) tiers[pr.tier]++;
  }
  console.log('\nTier dagilimi (kumlatif):');
  for (const [k, v] of Object.entries(tiers)) console.log(`  ${k}: ${v}`);

  // Ready to steal
  const stealable = Object.values(cache.prs).filter(pr => pr.readyToSteal);
  console.log(`\nReady to steal: ${stealable.length}`);

  if (todayResults.length > 0) {
    console.log(`\nTop 10 (bugun):`);
    sorted.slice(0, 10).forEach((pr, i) => {
      const tag = pr.scoredBy ? `[${pr.scoredBy}]` : '';
      const steal = pr.readyToSteal ? ' STEAL' : '';
      console.log(`${(i+1).toString().padStart(2)}. #${pr.number} | ${pr.totalScore} ${tag}${steal} | ${pr.title.substring(0, 60)}`);
    });
  }

  console.error(`\nResults: ${RESULTS_DIR}/${today()}.json`);
  console.error(`Summary: ${RESULTS_DIR}/${today()}-summary.md`);
  console.error(`Cache: ${CACHE_PATH} (${totalCached} entries)`);
}

// ─── Legacy main (env var based, input file) ────────────────────────────────

async function legacyMain(): Promise<void> {
  const CANDIDATES_FILE = process.env.TRELIQ_INPUT || '/tmp/openclaw-full-scan/treliq-input.json';
  const OUTPUT_FILE = process.env.TRELIQ_OUTPUT || '/tmp/openclaw-full-scan/treliq-scored.json';

  const candidates: Candidate[] = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf8'));
  console.error(`Loading ${candidates.length} candidates...`);

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY not set!');
    process.exit(1);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiEmbedding = openaiKey ? new OpenAIProvider(openaiKey) : undefined;

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
  const cascadeStats = { heuristic: 0, haiku: 0, sonnet: 0 };

  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    const batch = remaining.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (candidate) => {
      return cc.execute(async () => {
        try {
          const raw = execFileSync('gh', [
            'api', `repos/${REPO}/pulls/${candidate.number}`
          ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });

          const ghPR = JSON.parse(raw);

          let files: string[] = [];
          try {
            const filesRaw = execFileSync('gh', [
              'api', `repos/${REPO}/pulls/${candidate.number}/files`,
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

// ─── Entrypoint ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  if (opts.nightly) {
    await nightlyMain(opts);
  } else {
    await legacyMain();
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
