/**
 * IssueScanner — Fetches and scores GitHub issues
 */

import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import type { TreliqConfig, IssueData, ScoredIssue, ScoredPR } from './types';
import { IssueScoringEngine } from './issue-scoring';
import { ISSUE_DETAILS_QUERY, mapGraphQLToIssueData } from './graphql';
import { createLogger } from './logger';

const log = createLogger('issue-scanner');

export interface IssueScanConfig {
  repo: string;
  token: string;
  maxIssues?: number;
  provider?: TreliqConfig['provider'];
}

export class IssueScanner {
  private config: IssueScanConfig;
  private octokit: Octokit;
  private graphqlClient: typeof graphql;
  private scoring: IssueScoringEngine;

  constructor(config: IssueScanConfig) {
    this.config = config;
    this.octokit = new Octokit({ auth: config.token, request: { timeout: 15000 } });
    this.graphqlClient = graphql.defaults({
      headers: { authorization: `token ${config.token}` },
    });
    this.scoring = new IssueScoringEngine(config.provider);
  }

  /**
   * Scan issues: fetch, link to PRs, score
   * @param scoredPRs - Optional scored PRs to cross-reference issue-PR links
   */
  async scan(scoredPRs: ScoredPR[] = []): Promise<ScoredIssue[]> {
    const [owner, repo] = this.config.repo.split('/');
    const maxIssues = this.config.maxIssues ?? 500;

    log.info({ repo: this.config.repo, maxIssues }, 'Fetching issues');

    let issues: IssueData[];
    try {
      issues = await this.fetchViaGraphQL(owner, repo, maxIssues);
    } catch (err) {
      log.warn({ err }, 'GraphQL failed, falling back to REST');
      issues = await this.fetchViaREST(owner, repo, maxIssues);
    }

    if (issues.length === 0) {
      log.info('No open issues found');
      return [];
    }

    // Cross-reference PR-Issue links
    this.linkPRsToIssues(issues, scoredPRs);

    log.info({ count: issues.length }, 'Scoring issues');
    return this.scoring.scoreMany(issues);
  }

  private async fetchViaGraphQL(owner: string, repo: string, max: number): Promise<IssueData[]> {
    const issues: IssueData[] = [];
    let cursor: string | null = null;
    const pageSize = Math.min(max, 100);

    while (issues.length < max) {
      const result: any = await this.graphqlClient(ISSUE_DETAILS_QUERY, {
        owner,
        repo,
        first: pageSize,
        after: cursor,
      });

      const nodes = result.repository.issues.nodes ?? [];
      for (const node of nodes) {
        issues.push(mapGraphQLToIssueData(node));
      }

      const pageInfo = result.repository.issues.pageInfo;
      if (!pageInfo.hasNextPage || issues.length >= max) break;
      cursor = pageInfo.endCursor;
    }

    log.info({ fetched: issues.length }, 'Fetched issues via GraphQL');
    return issues.slice(0, max);
  }

  private async fetchViaREST(owner: string, repo: string, max: number): Promise<IssueData[]> {
    const issues: IssueData[] = [];
    let page = 1;
    const perPage = Math.min(max, 100);

    while (issues.length < max) {
      const { data } = await this.octokit.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: perPage,
        page,
      });

      // Filter out pull requests (GitHub API includes them in issues endpoint)
      const realIssues = data.filter(item => !item.pull_request);
      if (realIssues.length === 0) break;

      for (const item of realIssues) {
        issues.push({
          number: item.number,
          title: item.title,
          body: item.body ?? '',
          author: item.user?.login ?? 'unknown',
          authorAssociation: item.author_association ?? 'NONE',
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          labels: (item.labels ?? []).map((l: any) => typeof l === 'string' ? l : l.name ?? ''),
          milestone: item.milestone?.title ?? undefined,
          commentCount: item.comments ?? 0,
          reactionCount: item.reactions?.total_count ?? 0,
          state: item.state as 'open' | 'closed',
          stateReason: (item as any).state_reason ?? null,
          isLocked: item.locked ?? false,
          assignees: (item.assignees ?? []).map((a: any) => a.login),
          linkedPRs: [],
        });
      }

      if (data.length < perPage) break;
      page++;
    }

    log.info({ fetched: issues.length }, 'Fetched issues via REST');
    return issues.slice(0, max);
  }

  /**
   * Cross-reference PRs to Issues using issueNumbers from PRData.
   * If PR #42 references issue #10, then issue #10 gets linkedPRs: [42].
   */
  linkPRsToIssues(issues: IssueData[], prs: ScoredPR[]): void {
    const issueMap = new Map<number, IssueData>();
    for (const issue of issues) {
      issueMap.set(issue.number, issue);
    }

    for (const pr of prs) {
      for (const issueNum of pr.issueNumbers) {
        const issue = issueMap.get(issueNum);
        if (issue && !issue.linkedPRs.includes(pr.number)) {
          issue.linkedPRs.push(pr.number);
        }
      }
    }
  }
}
