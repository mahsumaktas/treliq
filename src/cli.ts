#!/usr/bin/env node

/**
 * Treliq CLI
 *
 * Usage:
 *   treliq scan --repo owner/repo          Scan all open PRs
 *   treliq score --repo owner/repo --pr 123  Score a single PR
 *   treliq compare --repo owner/repo --pr 123 456 789  Compare PRs
 *   treliq dedup --repo owner/repo         Find duplicate PR groups
 */

import { Command } from 'commander';

const program = new Command();

program
  .name('treliq')
  .description('AI-Powered PR Triage for Open Source Maintainers')
  .version('0.1.0');

program
  .command('scan')
  .description('Scan all open PRs in a repository')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .option('-t, --token <token>', 'GitHub token (or GITHUB_TOKEN env)')
  .option('-k, --gemini-key <key>', 'Gemini API key (or GEMINI_API_KEY env)')
  .option('-v, --vision <path>', 'Path to VISION.md or ROADMAP.md')
  .option('-f, --format <format>', 'Output format: table|json|markdown', 'table')
  .option('-m, --max <number>', 'Max PRs to scan', '500')
  .option('--comment', 'Post results as PR comments', false)
  .action(async (opts) => {
    console.log('🔍 Treliq v0.1 — Scanning PRs...');
    console.log(`   Repo: ${opts.repo}`);
    console.log(`   Format: ${opts.format}`);
    console.log('');
    console.log('⚠️  Not implemented yet. v0.1 in progress.');
    console.log('   Run with Claude Code to implement the full pipeline.');
  });

program
  .command('score')
  .description('Score a single PR')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .requiredOption('-p, --pr <number>', 'PR number')
  .action(async (opts) => {
    console.log(`🎯 Scoring PR #${opts.pr} in ${opts.repo}...`);
    console.log('⚠️  Not implemented yet.');
  });

program
  .command('compare')
  .description('Compare multiple PRs (find the best one)')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .requiredOption('-p, --pr <numbers...>', 'PR numbers to compare')
  .action(async (opts) => {
    console.log(`⚖️  Comparing PRs: ${opts.pr.join(', ')} in ${opts.repo}...`);
    console.log('⚠️  Not implemented yet.');
  });

program
  .command('dedup')
  .description('Find duplicate PR groups')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .action(async (opts) => {
    console.log(`🔄 Finding duplicate PRs in ${opts.repo}...`);
    console.log('⚠️  Not implemented yet.');
  });

program.parse();
