#!/usr/bin/env node

import { Command } from 'commander';
import { TreliqScanner } from './core/scanner';
import { ScoringEngine } from './core/scoring';
import { DedupEngine } from './core/dedup';
import type { TreliqConfig, TreliqResult, ScoredPR } from './core/types';
import { createProvider, type LLMProvider, type ProviderName } from './core/provider';

const program = new Command();

interface CLIOpts {
  repo: string;
  token?: string;
  geminiKey?: string;
  provider?: string;
  apiKey?: string;
  format?: string;
  max?: string;
  comment?: boolean;
  trustContributors?: boolean;
  noCache?: boolean;
  cacheFile?: string;
  pr?: string;
}

function resolveProvider(opts: CLIOpts): LLMProvider | undefined {
  const providerName = (opts.provider ?? 'gemini') as ProviderName;
  const envKeyMap: Record<ProviderName, string> = {
    gemini: 'GEMINI_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  };
  const apiKey = opts.apiKey || process.env[envKeyMap[providerName]];
  if (!apiKey) return undefined;

  // For Anthropic, create a Gemini fallback for embeddings if available
  let embeddingFallback: LLMProvider | undefined;
  if (providerName === 'anthropic') {
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (geminiKey) embeddingFallback = createProvider('gemini', geminiKey);
    else if (openaiKey) embeddingFallback = createProvider('openai', openaiKey);
  }

  return createProvider(providerName, apiKey, embeddingFallback);
}

function validateRepo(repo: string): void {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error('❌ Invalid repo format. Expected: owner/repo');
    process.exit(1);
  }
}

function validateMaxPRs(maxStr: string): number {
  const maxPRs = parseInt(maxStr, 10);
  if (isNaN(maxPRs) || maxPRs < 1 || maxPRs > 5000) {
    console.error('❌ Invalid --max value. Must be 1-5000.');
    process.exit(1);
  }
  return maxPRs;
}

function makeConfig(opts: CLIOpts): TreliqConfig {
  validateRepo(opts.repo);
  const token = opts.token || process.env.GITHUB_TOKEN || '';
  const provider = resolveProvider(opts);
  const maxPRs = validateMaxPRs(opts.max ?? '500');

  return {
    repo: opts.repo,
    token,
    provider,
    geminiApiKey: opts.geminiKey || process.env.GEMINI_API_KEY,
    duplicateThreshold: 0.85,
    relatedThreshold: 0.80,
    maxPRs,
    outputFormat: (opts.format ?? 'table') as TreliqConfig['outputFormat'],
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

function outputScoredPR(scored: ScoredPR, format: string) {
  if (format === 'json') {
    console.log(JSON.stringify(scored, null, 2));
  } else if (format === 'markdown') {
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
  .option('-p, --provider <name>', 'LLM provider: gemini|openai|anthropic', 'gemini')
  .option('--api-key <key>', 'API key for the selected provider')
  .option('-f, --format <format>', 'Output format: table|json|markdown', 'table')
  .option('-m, --max <number>', 'Max PRs to scan', '500')
  .option('--comment', 'Post results as PR comments', false)
  .option('--trust-contributors', 'Exempt known contributors from spam detection', false)
  .option('--no-cache', 'Force full rescan, ignore cache')
  .option('--cache-file <path>', 'Custom cache file path', '.treliq-cache.json')
  .action(async (opts: CLIOpts) => {
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
  .option('-p, --provider <name>', 'LLM provider: gemini|openai|anthropic', 'gemini')
  .option('--api-key <key>', 'API key for the selected provider')
  .option('-f, --format <format>', 'Output format', 'table')
  .action(async (opts: CLIOpts) => {
    const config = makeConfig(opts);
    if (!config.token) {
      console.error('❌ GITHUB_TOKEN required.');
      process.exit(1);
    }

    const prNum = parseInt(opts.pr!, 10);
    if (isNaN(prNum) || prNum < 1) {
      console.error('❌ Invalid PR number.');
      process.exit(1);
    }

    // Use scanner's fetchPRDetails to avoid code duplication
    const scanner = new TreliqScanner({ ...config, maxPRs: 1 });
    const prs = await scanner.fetchPRDetails([prNum]);
    if (prs.length === 0) {
      console.error(`❌ PR #${prNum} not found or could not be fetched.`);
      process.exit(1);
    }

    const engine = new ScoringEngine(config.provider, config.trustContributors);
    const scored = await engine.score(prs[0]);
    outputScoredPR(scored, opts.format ?? 'table');
  });

program
  .command('dedup')
  .description('Find duplicate PR groups')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .option('-t, --token <token>', 'GitHub token')
  .option('-k, --gemini-key <key>', 'Gemini API key')
  .option('-p, --provider <name>', 'LLM provider: gemini|openai|anthropic', 'gemini')
  .option('--api-key <key>', 'API key for the selected provider')
  .option('-f, --format <format>', 'Output format', 'table')
  .option('-m, --max <number>', 'Max PRs', '500')
  .action(async (opts: CLIOpts) => {
    const config = makeConfig(opts);
    if (!config.token) { console.error('❌ GITHUB_TOKEN required.'); process.exit(1); }
    if (!config.provider) { console.error('❌ API key required for dedup. Set via --api-key or env var.'); process.exit(1); }

    const scanner = new TreliqScanner(config);
    const prs = await scanner.fetchPRs();
    console.log(`📊 Scoring ${prs.length} PRs...`);
    const engine = new ScoringEngine(config.provider, config.trustContributors);
    const scored: ScoredPR[] = [];
    for (const pr of prs) scored.push(await engine.score(pr));

    const dedup = new DedupEngine(config.duplicateThreshold, config.relatedThreshold, config.provider);
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
