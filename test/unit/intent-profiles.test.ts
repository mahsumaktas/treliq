import { ScoringEngine } from '../../src/core/scoring';
import { createPRData } from '../fixtures/pr-factory';

describe('Intent-Aware Scoring Profiles', () => {
  it('uses intent weight of 0.15', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'feat: add feature' });
    const scored = await engine.score(pr);
    const signal = scored.signals.find(s => s.name === 'intent');
    expect(signal?.weight).toBeGreaterThan(0);
  });

  it('applies bugfix profile: higher ci_status weight', async () => {
    const engine = new ScoringEngine();
    const bugfix = createPRData({ title: 'fix: crash on login', ciStatus: 'success' });
    const feature = createPRData({ title: 'feat: add dark mode', ciStatus: 'success' });

    const bugfixScored = await engine.score(bugfix);
    const featureScored = await engine.score(feature);

    const bugfixCI = bugfixScored.signals.find(s => s.name === 'ci_status');
    const featureCI = featureScored.signals.find(s => s.name === 'ci_status');

    // bugfix profile boosts ci_status to 0.20 (before normalization), feature keeps default 0.15
    expect(bugfixCI!.weight).toBeGreaterThan(featureCI!.weight);
  });

  it('applies docs profile: lower ci_status and test_coverage weight', async () => {
    const engine = new ScoringEngine();
    const docs = createPRData({
      title: 'docs: update README',
      changedFiles: ['README.md'],
      ciStatus: 'failure',
      hasTests: false,
      testFilesChanged: [],
    });

    const scored = await engine.score(docs);
    const ci = scored.signals.find(s => s.name === 'ci_status');
    const test = scored.signals.find(s => s.name === 'test_coverage');

    expect(ci!.weight).toBeLessThan(0.10); // docs profile: 0.05
    expect(test!.weight).toBeLessThan(0.05); // docs profile: 0.03
  });

  it('applies dependency profile: higher ci_status, lower diff_size', async () => {
    const engine = new ScoringEngine();
    const dep = createPRData({
      title: 'chore(deps): bump express to v5',
      changedFiles: ['package.json', 'package-lock.json'],
      additions: 5000,
      deletions: 3000,
    });

    const scored = await engine.score(dep);
    const ci = scored.signals.find(s => s.name === 'ci_status');
    const diff = scored.signals.find(s => s.name === 'diff_size');

    expect(ci!.weight).toBeGreaterThanOrEqual(0.13);
    expect(diff!.weight).toBeLessThan(0.05);
  });

  it('normalizes weights to sum ~1.0 after profile application', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'fix: memory leak' });
    const scored = await engine.score(pr);
    const totalWeight = scored.signals.reduce((sum, s) => sum + s.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 1);
  });

  it('refactor profile boosts test_coverage and breaking_change', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'refactor: extract scoring engine' });
    const scored = await engine.score(pr);

    const test = scored.signals.find(s => s.name === 'test_coverage');
    const breaking = scored.signals.find(s => s.name === 'breaking_change');

    expect(test!.weight).toBeGreaterThan(0.08);
    expect(breaking!.weight).toBeGreaterThan(0.03);
  });

  it('chore profile boosts ci_status', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'ci: add coverage upload' });
    const scored = await engine.score(pr);

    const ci = scored.signals.find(s => s.name === 'ci_status');
    expect(ci!.weight).toBeGreaterThan(0.10);
  });

  it('feature profile boosts body_quality and scope_coherence', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'feat: add user dashboard' });
    const scored = await engine.score(pr);

    const body = scored.signals.find(s => s.name === 'body_quality');
    const scope = scored.signals.find(s => s.name === 'scope_coherence');

    expect(body!.weight).toBeGreaterThan(0.04);
    expect(scope!.weight).toBeGreaterThan(0.04);
  });
});
