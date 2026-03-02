// Run DedupEngine on all 4051 scored openclaw PRs
import { DedupEngine } from './src/core/dedup.js';
import { createProvider } from './src/core/provider.js';
import { ConcurrencyController } from './src/core/concurrency.js';
import type { ScoredPR } from './src/core/types.js';
import { readFileSync, writeFileSync } from 'fs';

const INPUT = process.env.DEDUP_INPUT || '/tmp/openclaw-full-scan/sonnet-full-scored.json';
const OUTPUT = process.env.DEDUP_OUTPUT || '/tmp/openclaw-full-scan/dedup-results.json';

async function main() {
  // Load scored PRs
  const data = JSON.parse(readFileSync(INPUT, 'utf8'));
  const prs: ScoredPR[] = data.rankedPRs;
  console.error(`Loaded ${prs.length} scored PRs`);

  // Create OpenAI provider for embeddings
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY not set!');
    process.exit(1);
  }

  const provider = createProvider('openai', apiKey);
  console.error(`Provider: OpenAI (text-embedding-3-small)`);

  // Create concurrency controller - generous for embeddings
  const cc = new ConcurrencyController(20, 3, 500);

  // Create DedupEngine
  // Lower threshold to catch more related PRs
  const duplicateThreshold = 0.85;
  const relatedThreshold = 0.75;
  const dedup = new DedupEngine(duplicateThreshold, relatedThreshold, provider);

  console.error(`Thresholds: duplicate=${duplicateThreshold}, related=${relatedThreshold}`);
  console.error(`Starting dedup on ${prs.length} PRs...`);
  console.error('');

  const startTime = Date.now();

  // Run dedup WITHOUT LLM verification (too expensive for 4051 PRs)
  const clusters = await dedup.findDuplicates(prs, cc, false);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\nDedup complete in ${elapsed}s`);
  console.error(`Found ${clusters.length} duplicate clusters`);

  // Analyze clusters
  const totalDuplicatePRs = clusters.reduce((sum, c) => sum + c.prs.length, 0);
  const uniquePRs = prs.length - totalDuplicatePRs + clusters.length; // each cluster counts as 1

  console.error(`Total PRs in clusters: ${totalDuplicatePRs}`);
  console.error(`Unique PRs (after dedup): ~${uniquePRs}`);
  console.error('');

  // Check current patches for duplicates
  const confLines = readFileSync('/Users/mahsum/.openclaw/my-patches/pr-patches.conf', 'utf8').split('\n');
  const patchedNums = new Set<number>();
  for (const line of confLines) {
    const m = line.match(/^\s*(\d+)\s*\|/);
    if (m) patchedNums.add(parseInt(m[1]));
  }

  // Find clusters containing our patches
  const patchClusters: any[] = [];
  for (const cluster of clusters) {
    const patchedInCluster = cluster.prs.filter((p: any) => patchedNums.has(p.number));
    if (patchedInCluster.length > 1) {
      // Multiple of our patches are in the same cluster = we have duplicates!
      patchClusters.push({
        clusterId: cluster.id,
        similarity: cluster.similarity,
        bestPR: cluster.bestPR,
        reason: cluster.reason,
        patchedPRs: patchedInCluster.map((p: any) => ({
          number: p.number,
          title: p.title,
          score: p.totalScore,
        })),
        allPRs: cluster.prs.map((p: any) => ({
          number: p.number,
          title: p.title,
          score: p.totalScore,
          isPatched: patchedNums.has(p.number),
        })),
      });
    }
  }

  // Summary output
  const result = {
    scannedAt: new Date().toISOString(),
    totalPRs: prs.length,
    totalClusters: clusters.length,
    totalDuplicatePRs,
    estimatedUniquePRs: uniquePRs,
    duplicateThreshold,
    relatedThreshold,
    elapsedSeconds: parseFloat(elapsed),

    // Clusters with multiple patched PRs (DUPLICATES IN OUR PATCHES)
    patchDuplicates: patchClusters,

    // All clusters sorted by size
    clustersBySize: clusters
      .map(c => ({
        id: c.id,
        size: c.prs.length,
        similarity: c.similarity,
        bestPR: c.bestPR,
        reason: c.reason,
        prs: c.prs.map((p: any) => ({
          number: p.number,
          title: p.title,
          score: p.totalScore,
          isPatched: patchedNums.has(p.number),
        })),
      }))
      .sort((a, b) => b.size - a.size),

    // Score distribution after dedup (unique PRs only)
    scoreDistAfterDedup: (() => {
      const bestNums = new Set(clusters.map(c => c.bestPR));
      const inCluster = new Set(clusters.flatMap(c => c.prs.map((p: any) => p.number)));
      // Keep: PRs not in any cluster + best PR from each cluster
      const uniquePRList = prs.filter(p => !inCluster.has(p.number) || bestNums.has(p.number));
      const dist: Record<string, number> = { '80+': 0, '75-79': 0, '70-74': 0, '65-69': 0, '60-64': 0, '<60': 0 };
      for (const p of uniquePRList) {
        if (p.totalScore >= 80) dist['80+']++;
        else if (p.totalScore >= 75) dist['75-79']++;
        else if (p.totalScore >= 70) dist['70-74']++;
        else if (p.totalScore >= 65) dist['65-69']++;
        else if (p.totalScore >= 60) dist['60-64']++;
        else dist['<60']++;
      }
      return { total: uniquePRList.length, distribution: dist };
    })(),
  };

  writeFileSync(OUTPUT, JSON.stringify(result, null, 2));

  // Console report
  console.log('\n=== DEDUP REPORT ===');
  console.log(`Total PRs: ${prs.length}`);
  console.log(`Clusters found: ${clusters.length}`);
  console.log(`PRs in clusters: ${totalDuplicatePRs}`);
  console.log(`Estimated unique PRs: ~${uniquePRs}`);
  console.log('');

  if (patchClusters.length > 0) {
    console.log('!!! DUPLICATE PATCHES FOUND !!!');
    console.log(`${patchClusters.length} cluster(s) contain multiple of our 90 patches:`);
    for (const pc of patchClusters) {
      console.log(`\n  Cluster ${pc.clusterId} (similarity: ${pc.similarity.toFixed(2)}):`);
      for (const p of pc.patchedPRs) {
        console.log(`    #${p.number} (score: ${p.score}) — ${p.title}`);
      }
      console.log(`    Best PR: #${pc.bestPR}`);
    }
  } else {
    console.log('No duplicate patches found in our 90 patches.');
  }

  console.log('');
  console.log('Largest clusters:');
  result.clustersBySize.slice(0, 15).forEach(c => {
    const patchMark = c.prs.some((p: any) => p.isPatched) ? ' [HAS PATCH]' : '';
    console.log(`  Cluster ${c.id}: ${c.size} PRs, sim=${c.similarity.toFixed(2)}${patchMark}`);
    c.prs.forEach((p: any) => {
      const mark = p.isPatched ? ' ***PATCHED***' : '';
      console.log(`    #${p.number} (${p.score}) ${p.title}${mark}`);
    });
  });

  console.log('');
  console.log('Score distribution after dedup:');
  for (const [k, v] of Object.entries(result.scoreDistAfterDedup.distribution)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`  Total unique: ${result.scoreDistAfterDedup.total}`);

  console.log(`\nFull results: ${OUTPUT}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
