#!/usr/bin/env node

import { Command } from 'commander';
import { TreliqScanner } from './core/scanner';
import { ScoringEngine } from './core/scoring';
import { DedupEngine } from './core/dedup';
import type { TreliqConfig, TreliqResult, ScoredPR } from './core/types';

const program = new Command();

function makeConfig(opts: any): TreliqConfig {
  return {
    repo: opts.repo,
    token: opts.token || process.env.GITHUB_TOKEN || '',
    geminiApiKey: opts.geminiKey || process.env.GEMINI_API_KEY,
    duplicateThreshold: 0.85,
    relatedThreshold: 0.80,
    maxPRs: parseInt(opts.max ?? '500', 10),
    outputFormat: opts.format ?? 'table',
    comment: opts.comment ?? false,
    trustContributors: opts.trustContributors ?? false,
    useCache: opts.noCache ? false : true,
    cacheFile: opts.cacheFile ?? '.treliq-cache.json',
  };
}

function outputResult(result: TreliqResult, format: string) {
  if (format === 'json') {
    // Strip embeddings for cleaner output
    const clean = {
      ...result,
      rankedPRs: result.rankedPRs.map(({ embedding, ...rest }) => rest),
    };
    console.log(JSON.stringify(clean, null, 2));
    return;
  }

  if (format === 'markdown') {
    console.log(`# Treliq Report — ${result.repo}\n`);
    console.log(`- **Scanned:** ${result.totalPRs} PRs`);
    console.log(`- **Spam:** ${result.spamCount}`);
    console.log(`- **Duplicate clusters:** ${result.duplicateClusters.length}\n`);
    console.log('## Top PRs\n');
    console.log('| # | Score | LLM | Risk | Title | Author | Age | Conflict | Vision | V.Score |');
    console.log('|---|-------|-----|------|-------|--------|-----|----------|--------|---------|');
    for (const pr of result.rankedPRs.slice(0, 30)) {
      console.log(`| #${pr.number} | ${pr.totalScore} | ${pr.llmScore ?? '-'} | ${pr.llmRisk ?? '-'} | ${pr.title.slice(0, 50)} | @${pr.author} | ${pr.ageInDays}d | ${pr.mergeable} | ${pr.visionAlignment ?? '-'} | ${pr.visionScore ?? '-'} |`);
    }
    if (result.duplicateClusters.length > 0) {
      console.log('\n## Duplicate Clusters\n');
      for (const c of result.duplicateClusters) {
        console.log(`### Cluster ${c.id} (similarity: ${(c.similarity * 100).toFixed(1)}%)`);
        console.log(`Best: #${c.bestPR}`);
        console.log(`PRs: ${c.prs.map(p => `#${p.number}`).join(', ')}\n`);
      }
    }
    return;
  }

  // Table format (default)
  console.log(`\n🔍 Treliq Report — ${result.repo}`);
  console.log(`   ${result.totalPRs} PRs scanned | ${result.spamCount} spam | ${result.duplicateClusters.length} dup clusters\n`);

  const rows = result.rankedPRs.slice(0, 30).map(pr => ({
    '#': pr.number,
    Score: pr.totalScore,
    LLM: pr.llmScore ?? '-',
    Risk: pr.llmRisk ?? '-',
    Title: pr.title.slice(0, 45),
    Author: pr.author.slice(0, 12),
    Age: `${pr.ageInDays}d`,
    Conflict: pr.mergeable,
    CI: pr.ciStatus,
    'V.Score': pr.visionScore ?? '-',
    Vision: pr.visionAlignment === 'unchecked' ? 'N/A' : (pr.visionAlignment ?? 'No doc'),
    Spam: pr.isSpam ? '🚩 Spam' : 'Clean',
    Dup: pr.duplicateGroup !== undefined ? `G${pr.duplicateGroup}` : '—',
  }));
  console.table(rows);

  if (result.duplicateClusters.length > 0) {
    console.log('\n🔄 Duplicate Clusters:');
    for (const c of result.duplicateClusters) {
      console.log(`   Cluster ${c.id}: ${c.prs.map(p => `#${p.number}`).join(', ')} (best: #${c.bestPR}, sim: ${(c.similarity * 100).toFixed(1)}%)`);
    }
  }

  console.log(`\n📝 ${result.summary}`);
}

program
  .name('treliq')
  .description('AI-Powered PR Triage for Open Source Maintainers')
  .version('0.3.0');

program
  .command('scan')
  .description('Scan all open PRs in a repository')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .option('-t, --token <token>', 'GitHub token (or GITHUB_TOKEN env)')
  .option('-k, --gemini-key <key>', 'Gemini API key (or GEMINI_API_KEY env)')
  .option('-f, --format <format>', 'Output format: table|json|markdown', 'table')
  .option('-m, --max <number>', 'Max PRs to scan', '500')
  .option('--comment', 'Post results as PR comments', false)
  .option('--trust-contributors', 'Exempt known contributors from spam detection', false)
  .option('--no-cache', 'Force full rescan, ignore cache')
  .option('--cache-file <path>', 'Custom cache file path', '.treliq-cache.json')
  .action(async (opts) => {
    const config = makeConfig(opts);
    if (!config.token) {
      console.error('❌ GITHUB_TOKEN required. Set via env or --token flag.');
      process.exit(1);
    }
    const scanner = new TreliqScanner(config);
    const result = await scanner.scan();
    outputResult(result, config.outputFormat);
  });

program
  .command('score')
  .description('Score a single PR')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .requiredOption('-n, --pr <number>', 'PR number')
  .option('-t, --token <token>', 'GitHub token')
  .option('-f, --format <format>', 'Output format', 'table')
  .action(async (opts) => {
    const config = makeConfig(opts);
    if (!config.token) {
      console.error('❌ GITHUB_TOKEN required.');
      process.exit(1);
    }
    const scanner = new TreliqScanner({ ...config, maxPRs: 1 });
    // Fetch just this PR
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: config.token });
    const [owner, repo] = config.repo.split('/');
    const prNum = parseInt(opts.pr, 10);

    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNum });
    const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: prNum, per_page: 100 });
    const { data: reviews } = await octokit.pulls.listReviews({ owner, repo, pull_number: prNum });

    const TEST_PATTERNS = [/test\//, /spec\//, /__test__/, /__tests__/, /\.test\./, /\.spec\./, /_test\.go$/, /Test\.java$/];
    const changedFileNames = files.map(f => f.filename);
    const testFilesChanged = changedFileNames.filter(f => TEST_PATTERNS.some(p => p.test(f)));
    const ageInDays = Math.floor((Date.now() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60 * 24));
    const mergeableMap: Record<string, 'mergeable' | 'conflicting' | 'unknown'> = { clean: 'mergeable', unstable: 'mergeable', dirty: 'conflicting', blocked: 'mergeable' };
    const mergeable = mergeableMap[pr.mergeable_state ?? ''] ?? 'unknown';
    const reviewStates = reviews.map(r => r.state);
    let reviewState: 'approved' | 'changes_requested' | 'commented' | 'none' = 'none';
    if (reviewStates.includes('APPROVED')) reviewState = 'approved';
    else if (reviewStates.includes('CHANGES_REQUESTED')) reviewState = 'changes_requested';
    else if (reviewStates.some(s => s === 'COMMENTED')) reviewState = 'commented';

    const ISSUE_REF = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related\s+to|addresses|refs?)\s+#(\d+)/gi;
    const LOOSE_REF = /#(\d+)/g;
    const text = `${pr.title} ${pr.body ?? ''}`;
    const issueNumbers: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = ISSUE_REF.exec(text)) !== null) issueNumbers.push(parseInt(m[1], 10));
    if (issueNumbers.length === 0) {
      while ((m = LOOSE_REF.exec(text)) !== null) {
        const num = parseInt(m[1], 10);
        if (num > 0 && num < 100000) issueNumbers.push(num);
      }
    }

    const prData = {
      number: pr.number, title: pr.title, body: pr.body ?? '',
      author: pr.user?.login ?? 'unknown', authorAssociation: pr.author_association,
      createdAt: pr.created_at, updatedAt: pr.updated_at,
      headRef: pr.head.ref, baseRef: pr.base.ref,
      filesChanged: pr.changed_files, additions: pr.additions, deletions: pr.deletions,
      commits: pr.commits, labels: pr.labels.map((l: any) => l.name ?? ''),
      ciStatus: await (async () => {
        try {
          const checks = await octokit.checks.listForRef({ owner, repo, ref: pr.head.sha });
          if (checks.data.total_count > 0) {
            const conclusions = checks.data.check_runs.map((c: any) => c.conclusion);
            if (conclusions.some((c: any) => c === 'failure')) return 'failure' as const;
            if (conclusions.every((c: any) => c === 'success' || c === 'skipped')) return 'success' as const;
            return 'pending' as const;
          }
          return 'unknown' as const;
        } catch { return 'unknown' as const; }
      })(), hasIssueRef: issueNumbers.length > 0,
      issueNumbers, changedFiles: changedFileNames,
      diffUrl: pr.diff_url,
      hasTests: testFilesChanged.length > 0,
      testFilesChanged,
      ageInDays,
      mergeable,
      reviewState,
      reviewCount: reviews.length,
      commentCount: pr.comments ?? 0,
    };

    const engine = new ScoringEngine(config.geminiApiKey, config.trustContributors);
    const scored = await engine.score(prData);

    if (opts.format === 'json') {
      console.log(JSON.stringify(scored, null, 2));
    } else if (opts.format === 'markdown') {
      console.log(`## 🎯 Treliq Score — PR #${scored.number}\n`);
      console.log(`**${scored.title}** by @${scored.author}\n`);
      console.log(`| Metric | Value |`);
      console.log(`|--------|-------|`);
      console.log(`| **Total Score** | **${scored.totalScore}/100** |`);
      console.log(`| Spam | ${scored.isSpam ? '🚩 Spam' : '✅ Clean'} |`);
      console.log(`| Files Changed | ${scored.filesChanged} |`);
      console.log(`| +${scored.additions} / -${scored.deletions} | ${scored.commits} commits |`);
      if (scored.llmScore != null) console.log(`| LLM Quality | ${scored.llmScore}/100 (${scored.llmRisk}) |`);
      if (scored.visionScore != null) console.log(`| Vision Alignment | ${scored.visionScore}/100 (${scored.visionAlignment}) |`);
      console.log(`\n### Signal Breakdown\n`);
      console.log(`| Signal | Score | Weight | Reason |`);
      console.log(`|--------|-------|--------|--------|`);
      for (const s of scored.signals) {
        console.log(`| ${s.name} | ${s.score}/100 | ${s.weight} | ${s.reason} |`);
      }
    } else {
      console.log(`\n🎯 PR #${scored.number}: ${scored.title}`);
      console.log(`   Score: ${scored.totalScore}/100 | Spam: ${scored.isSpam ? 'Yes' : 'No'}\n`);
      console.log('   Signals:');
      for (const s of scored.signals) {
        console.log(`     ${s.name.padEnd(16)} ${String(s.score).padStart(3)}/100 (w: ${s.weight}) — ${s.reason}`);
      }
    }
  });

program
  .command('dedup')
  .description('Find duplicate PR groups')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .option('-t, --token <token>', 'GitHub token')
  .option('-k, --gemini-key <key>', 'Gemini API key')
  .option('-f, --format <format>', 'Output format', 'table')
  .option('-m, --max <number>', 'Max PRs', '500')
  .action(async (opts) => {
    const config = makeConfig(opts);
    if (!config.token) { console.error('❌ GITHUB_TOKEN required.'); process.exit(1); }
    if (!config.geminiApiKey) { console.error('❌ GEMINI_API_KEY required for dedup.'); process.exit(1); }

    const scanner = new TreliqScanner(config);
    const prs = await scanner.fetchPRs();
    console.log(`📊 Scoring ${prs.length} PRs...`);
    const engine = new ScoringEngine(config.geminiApiKey, config.trustContributors);
    const scored: ScoredPR[] = [];
    for (const pr of prs) scored.push(await engine.score(pr));

    const dedup = new DedupEngine(config.duplicateThreshold, config.relatedThreshold, config.geminiApiKey);
    const clusters = await dedup.findDuplicates(scored);

    if (opts.format === 'json') {
      console.log(JSON.stringify(clusters, null, 2));
    } else {
      console.log(`\n🔄 Found ${clusters.length} duplicate clusters:\n`);
      for (const c of clusters) {
        console.log(`  Cluster ${c.id} (sim: ${(c.similarity * 100).toFixed(1)}%):`);
        for (const pr of c.prs) {
          const marker = pr.number === c.bestPR ? '⭐' : '  ';
          console.log(`    ${marker} #${pr.number} (${pr.totalScore}) ${pr.title.slice(0, 60)}`);
        }
        console.log();
      }
    }
  });

program.parse();
