/**
 * Contributor Reputation — Fetches GitHub profile data to assess contributor trust
 */

import { Octokit } from '@octokit/rest';

export interface ReputationData {
  login: string;
  followers: number;
  publicRepos: number;
  accountAgeDays: number;
  suspicious: boolean;
  suspiciousReasons: string[];
  reputationScore: number; // 0-100
}

const cache = new Map<string, ReputationData>();

export async function getReputation(
  octokit: Octokit,
  login: string,
): Promise<ReputationData> {
  if (cache.has(login)) return cache.get(login)!;

  try {
    const { data } = await octokit.users.getByUsername({ username: login });
    const ageDays = Math.floor(
      (Date.now() - new Date(data.created_at).getTime()) / (1000 * 60 * 60 * 24),
    );
    const followers = data.followers ?? 0;
    const repos = data.public_repos ?? 0;

    const reasons: string[] = [];
    if (ageDays < 30) reasons.push(`Account age: ${ageDays}d`);
    if (followers === 0 && repos === 0) reasons.push('No followers or repos');

    // Score: base 50, +up to 20 for followers, +up to 15 for repos, +up to 15 for age
    let score = 50;
    score += Math.min(20, followers * 2);
    score += Math.min(15, repos);
    score += Math.min(15, Math.floor(ageDays / 30));
    if (reasons.length > 0) score = Math.max(10, score - 30);
    score = Math.min(100, score);

    const result: ReputationData = {
      login,
      followers,
      publicRepos: repos,
      accountAgeDays: ageDays,
      suspicious: reasons.length > 0,
      suspiciousReasons: reasons,
      reputationScore: score,
    };
    cache.set(login, result);
    return result;
  } catch {
    const fallback: ReputationData = {
      login,
      followers: 0,
      publicRepos: 0,
      accountAgeDays: 0,
      suspicious: false,
      suspiciousReasons: [],
      reputationScore: 50,
    };
    cache.set(login, fallback);
    return fallback;
  }
}

export function clearReputationCache() {
  cache.clear();
}
