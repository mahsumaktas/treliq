#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { Octokit } from '@octokit/rest';
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
  dbPath?: string;
  threshold?: string;
  dryRun?: boolean;
  message?: string;
  high?: string;
  medium?: string;
  port?: string;
  host?: string;
  schedule?: string;
  cron?: string;
  webhookSecret?: string;
  slackWebhook?: string;
  discordWebhook?: string;
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
    dbPath: opts.dbPath,
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
  .version('0.4.0');

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

program
  .command('close-spam')
  .description('Close PRs identified as spam')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .option('-t, --token <token>', 'GitHub token (or GITHUB_TOKEN env)')
  .option('-p, --provider <name>', 'LLM provider: gemini|openai|anthropic', 'gemini')
  .option('--api-key <key>', 'API key for the selected provider')
  .option('--threshold <score>', 'Score threshold for spam detection', '25')
  .option('--dry-run', 'Preview only, do not close PRs', false)
  .option('--message <text>', 'Custom close comment')
  .action(async (opts: CLIOpts) => {
    const config = makeConfig(opts);
    if (!config.token) {
      console.error('❌ GITHUB_TOKEN required.');
      process.exit(1);
    }

    const threshold = parseInt(opts.threshold ?? '25', 10);
    if (isNaN(threshold)) {
      console.error('❌ Invalid threshold value.');
      process.exit(1);
    }

    console.log(`🔍 Scanning for spam PRs (threshold: ${threshold})...`);
    const scanner = new TreliqScanner(config);
    const result = await scanner.scan();

    const spamPRs = result.rankedPRs.filter(pr => pr.isSpam && pr.totalScore <= threshold);

    if (spamPRs.length === 0) {
      console.log('✅ No spam PRs found matching criteria.');
      return;
    }

    console.log(`\n🚩 Found ${spamPRs.length} spam PRs:\n`);
    for (const pr of spamPRs) {
      console.log(`  #${pr.number} - ${pr.title} (score: ${pr.totalScore}, by @${pr.author})`);
    }

    if (opts.dryRun) {
      console.log('\n🔍 Dry run complete. No PRs were closed.');
      return;
    }

    // Prompt for confirmation
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>(resolve => {
      rl.question(`\n⚠️  Close ${spamPRs.length} spam PRs? (yes/no): `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'yes') {
      console.log('❌ Operation cancelled.');
      return;
    }

    const [owner, repo] = config.repo.split('/');
    const octokit = new Octokit({ auth: config.token });
    const closeMessage = opts.message || 'This PR has been automatically closed as it was identified as spam by Treliq.';

    console.log('\n🔨 Closing spam PRs...');
    for (const pr of spamPRs) {
      try {
        // Post comment
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: closeMessage,
        });

        // Close PR
        await octokit.pulls.update({
          owner,
          repo,
          pull_number: pr.number,
          state: 'closed',
        });

        console.log(`  ✅ Closed #${pr.number}`);
      } catch (error: any) {
        console.error(`  ❌ Failed to close #${pr.number}: ${error.message}`);
      }
    }

    console.log(`\n✅ Closed ${spamPRs.length} spam PRs.`);
  });

program
  .command('label-by-score')
  .description('Apply priority labels based on PR scores')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .option('-t, --token <token>', 'GitHub token (or GITHUB_TOKEN env)')
  .option('-p, --provider <name>', 'LLM provider: gemini|openai|anthropic', 'gemini')
  .option('--api-key <key>', 'API key for the selected provider')
  .option('--high <score>', 'High priority threshold', '80')
  .option('--medium <score>', 'Medium priority threshold', '50')
  .option('--dry-run', 'Preview only, do not apply labels', false)
  .action(async (opts: CLIOpts) => {
    const config = makeConfig(opts);
    if (!config.token) {
      console.error('❌ GITHUB_TOKEN required.');
      process.exit(1);
    }

    const highThreshold = parseInt(opts.high ?? '80', 10);
    const mediumThreshold = parseInt(opts.medium ?? '50', 10);

    if (isNaN(highThreshold) || isNaN(mediumThreshold)) {
      console.error('❌ Invalid threshold values.');
      process.exit(1);
    }

    console.log(`🔍 Scanning and scoring PRs...`);
    const scanner = new TreliqScanner(config);
    const result = await scanner.scan();

    const highPRs = result.rankedPRs.filter(pr => !pr.isSpam && pr.totalScore >= highThreshold);
    const mediumPRs = result.rankedPRs.filter(pr => !pr.isSpam && pr.totalScore >= mediumThreshold && pr.totalScore < highThreshold);
    const lowPRs = result.rankedPRs.filter(pr => !pr.isSpam && pr.totalScore < mediumThreshold);

    console.log(`\n📊 Label Distribution:\n`);
    console.log(`  🔴 High Priority (>=${highThreshold}): ${highPRs.length} PRs`);
    console.log(`  🟡 Medium Priority (${mediumThreshold}-${highThreshold}): ${mediumPRs.length} PRs`);
    console.log(`  🟢 Low Priority (<${mediumThreshold}): ${lowPRs.length} PRs`);

    if (opts.dryRun) {
      console.log('\n🔍 Dry run complete. No labels were applied.');
      return;
    }

    const [owner, repo] = config.repo.split('/');
    const octokit = new Octokit({ auth: config.token });

    console.log('\n🏷️  Applying labels...');

    const labelMap = [
      { prs: highPRs, label: 'treliq:high-priority', emoji: '🔴' },
      { prs: mediumPRs, label: 'treliq:medium-priority', emoji: '🟡' },
      { prs: lowPRs, label: 'treliq:low-priority', emoji: '🟢' },
    ];

    for (const { prs, label, emoji } of labelMap) {
      for (const pr of prs) {
        try {
          await octokit.issues.addLabels({
            owner,
            repo,
            issue_number: pr.number,
            labels: [label],
          });
          console.log(`  ${emoji} #${pr.number}: ${label}`);
        } catch (error: any) {
          console.error(`  ❌ Failed to label #${pr.number}: ${error.message}`);
        }
      }
    }

    console.log('\n✅ Labels applied successfully.');
  });

program
  .command('server')
  .description('Start Treliq server with web UI and scheduled scanning')
  .option('--port <number>', 'Server port', '3000')
  .option('--host <host>', 'Server host', '0.0.0.0')
  .option('--db-path <path>', 'SQLite database path', './treliq.db')
  .option('-t, --token <token>', 'GitHub token (or GITHUB_TOKEN env)')
  .option('-p, --provider <name>', 'LLM provider: gemini|openai|anthropic', 'gemini')
  .option('--api-key <key>', 'API key for the selected provider')
  .option('--schedule <repos>', 'Comma-separated repos for hourly scanning')
  .option('--cron <expression>', 'Custom cron expression', '0 * * * *')
  .option('--webhook-secret <secret>', 'GitHub webhook secret')
  .option('--slack-webhook <url>', 'Slack webhook URL')
  .option('--discord-webhook <url>', 'Discord webhook URL')
  .action(async (opts: CLIOpts) => {
    const token = opts.token || process.env.GITHUB_TOKEN;
    if (!token) {
      console.error('❌ GITHUB_TOKEN required for server mode.');
      process.exit(1);
    }

    const port = parseInt(opts.port ?? '3000', 10);
    const host = opts.host ?? '0.0.0.0';
    const dbPath = opts.dbPath ?? './treliq.db';
    const provider = resolveProvider(opts);

    const scheduledRepos = opts.schedule?.split(',').map(r => r.trim()).filter(Boolean) || [];
    const cronExpression = opts.cron ?? '0 * * * *';

    const serverConfig = {
      port,
      host,
      dbPath,
      treliqConfig: {
        repo: scheduledRepos[0] ?? '',
        token,
        provider,
        duplicateThreshold: 0.85,
        relatedThreshold: 0.80,
        maxPRs: 500,
        outputFormat: 'json' as const,
        comment: false,
        trustContributors: false,
        useCache: true,
        cacheFile: '.treliq-cache.json',
        dbPath,
      },
      webhookSecret: opts.webhookSecret,
      scheduledRepos,
      cronExpression,
      slackWebhook: opts.slackWebhook,
      discordWebhook: opts.discordWebhook,
    };

    console.log(`🚀 Starting Treliq server on ${host}:${port}...`);
    console.log(`   Database: ${dbPath}`);
    if (scheduledRepos.length > 0) {
      console.log(`   Scheduled repos: ${scheduledRepos.join(', ')}`);
      console.log(`   Cron: ${cronExpression}`);
    }

    try {
      // Dynamic import to avoid loading heavy dependencies for CLI-only users
      const { startServer } = await import('./server');
      await startServer(serverConfig);
    } catch (error: any) {
      console.error(`❌ Failed to start server: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
