import { IntentClassifier } from '../../src/core/intent';
import { MockLLMProvider } from '../fixtures/mock-provider';
import { createPRData } from '../fixtures/pr-factory';

describe('IntentClassifier', () => {
  describe('classifyFromTitle (conventional commit)', () => {
    it('detects bugfix from fix: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('fix: resolve null pointer in auth');
      expect(result).toEqual({ intent: 'bugfix', confidence: 1.0, reason: 'Conventional commit: fix' });
    });

    it('detects feature from feat: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('feat: add dark mode support');
      expect(result).toEqual({ intent: 'feature', confidence: 1.0, reason: 'Conventional commit: feat' });
    });

    it('detects refactor from refactor: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('refactor(auth): extract service layer');
      expect(result).toEqual({ intent: 'refactor', confidence: 1.0, reason: 'Conventional commit: refactor' });
    });

    it('detects dependency from chore(deps): prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('chore(deps): bump lodash from 4.17.20 to 4.17.21');
      expect(result).toEqual({ intent: 'dependency', confidence: 1.0, reason: 'Conventional commit: chore(deps)' });
    });

    it('detects docs from docs: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('docs: update API reference');
      expect(result).toEqual({ intent: 'docs', confidence: 1.0, reason: 'Conventional commit: docs' });
    });

    it('detects chore from ci:/build:/style:/test: prefixes', () => {
      const classifier = new IntentClassifier();
      expect(classifier.classifyFromTitle('ci: fix GitHub Actions workflow')!.intent).toBe('chore');
      expect(classifier.classifyFromTitle('build: update webpack config')!.intent).toBe('chore');
      expect(classifier.classifyFromTitle('test: add unit tests for auth')!.intent).toBe('chore');
    });

    it('detects bugfix from hotfix: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('hotfix: critical auth fix');
      expect(result).toEqual({ intent: 'bugfix', confidence: 1.0, reason: 'Conventional commit: hotfix' });
    });

    it('detects feature from feature: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('feature: add payment flow');
      expect(result).toEqual({ intent: 'feature', confidence: 1.0, reason: 'Conventional commit: feature' });
    });

    it('detects refactor from perf: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('perf: optimize db queries');
      expect(result).toEqual({ intent: 'refactor', confidence: 1.0, reason: 'Conventional commit: perf' });
    });

    it('detects docs from doc: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('doc: fix typo in readme');
      expect(result).toEqual({ intent: 'docs', confidence: 1.0, reason: 'Conventional commit: doc' });
    });

    it('detects dependency from build(deps): prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('build(deps): bump webpack from 5.0 to 5.1');
      expect(result).toEqual({ intent: 'dependency', confidence: 1.0, reason: 'Conventional commit: build(deps)' });
    });

    it('returns null for non-conventional titles', () => {
      const classifier = new IntentClassifier();
      expect(classifier.classifyFromTitle('Update the login page')).toBeNull();
      expect(classifier.classifyFromTitle('Bump dependencies')).toBeNull();
    });
  });

  describe('classifyFromHeuristic (keyword fallback)', () => {
    it('detects dependency from bump/update keywords', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Bump lodash to 4.17.21', changedFiles: ['package.json', 'package-lock.json'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('dependency');
    });

    it('detects docs from all-docs files', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Update getting started guide', changedFiles: ['README.md', 'docs/setup.md'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('docs');
    });

    it('detects bugfix from fix keywords', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Fix crash on login page', changedFiles: ['src/auth.ts'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('bugfix');
    });

    it('defaults to feature for unknown patterns', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Add new dashboard component', changedFiles: ['src/dashboard.tsx'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('feature');
    });

    it('detects refactor from refactor keywords', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Restructure the auth module', changedFiles: ['src/auth.ts'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('refactor');
    });

    it('detects dependency from dependabot/renovate titles', () => {
      const classifier = new IntentClassifier();
      const pr1 = createPRData({ title: 'Update lodash by dependabot', changedFiles: ['package.json'] });
      expect(classifier.classifyFromHeuristic(pr1.title, pr1.changedFiles).intent).toBe('dependency');

      const pr2 = createPRData({ title: 'Configure renovate for deps', changedFiles: ['renovate.json'] });
      expect(classifier.classifyFromHeuristic(pr2.title, pr2.changedFiles).intent).toBe('dependency');
    });
  });

  describe('classifyWithLLM', () => {
    it('parses valid LLM JSON response', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"intent": "bugfix", "confidence": 0.95, "reason": "Fixes null pointer"}';
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classifyWithLLM('Fix null pointer', 'Resolves crash', ['src/auth.ts']);
      expect(result).toEqual({ intent: 'bugfix', confidence: 0.95, reason: 'Fixes null pointer' });
    });

    it('throws on LLM failure (classify handles fallback)', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = () => { throw new Error('LLM down'); };
      const classifier = new IntentClassifier(provider);
      await expect(classifier.classifyWithLLM('fix: auth crash', 'Fixes auth', ['src/auth.ts']))
        .rejects.toThrow('LLM down');
    });

    it('falls back on invalid JSON', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = 'not json at all';
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classifyWithLLM('Add new feature', '', ['src/new.ts']);
      expect(result.intent).toBe('feature');
      expect(result.confidence).toBe(0.5);
    });
  });

  describe('classify (full pipeline)', () => {
    it('uses conventional commit first, skips LLM', async () => {
      const provider = new MockLLMProvider();
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classify('feat: add dark mode', '', []);
      expect(result.intent).toBe('feature');
      expect(result.confidence).toBe(1.0);
      expect(provider.generateTextCalls).toHaveLength(0);
    });

    it('falls through to LLM for non-conventional titles', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"intent": "refactor", "confidence": 0.88, "reason": "Restructuring code"}';
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classify('Restructure the auth module', '', ['src/auth.ts']);
      expect(result.intent).toBe('refactor');
      expect(provider.generateTextCalls).toHaveLength(1);
    });

    it('works without LLM provider (heuristic only)', async () => {
      const classifier = new IntentClassifier();
      const result = await classifier.classify('Fix login crash', '', ['src/auth.ts']);
      expect(result.intent).toBe('bugfix');
    });
  });
});
