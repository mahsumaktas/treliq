import { clearReputationCache, getReputation } from '../../src/core/reputation';

describe('reputation', () => {
  beforeEach(() => {
    clearReputationCache();
  });

  it('computes reputation from GitHub profile data', async () => {
    const octokit = {
      users: {
        getByUsername: jest.fn().mockResolvedValue({
          data: {
            created_at: '2025-02-01T00:00:00.000Z',
            followers: 3,
            public_repos: 4,
          },
        }),
      },
    } as any;

    const result = await getReputation(octokit, 'alice');

    expect(result.login).toBe('alice');
    expect(result.followers).toBe(3);
    expect(result.publicRepos).toBe(4);
    expect(result.suspicious).toBe(false);
    expect(result.reputationScore).toBeGreaterThan(50);
    expect(octokit.users.getByUsername).toHaveBeenCalledWith({ username: 'alice' });
  });

  it('marks very new empty profiles as suspicious', async () => {
    const octokit = {
      users: {
        getByUsername: jest.fn().mockResolvedValue({
          data: {
            created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
            followers: 0,
            public_repos: 0,
          },
        }),
      },
    } as any;

    const result = await getReputation(octokit, 'new-user');

    expect(result.suspicious).toBe(true);
    expect(result.suspiciousReasons.length).toBeGreaterThan(0);
    expect(result.reputationScore).toBeLessThanOrEqual(50);
  });

  it('returns fallback reputation when API fails', async () => {
    const octokit = {
      users: {
        getByUsername: jest.fn().mockRejectedValue(new Error('GitHub down')),
      },
    } as any;

    const result = await getReputation(octokit, 'offline-user');

    expect(result).toEqual({
      login: 'offline-user',
      followers: 0,
      publicRepos: 0,
      accountAgeDays: 0,
      suspicious: false,
      suspiciousReasons: [],
      reputationScore: 50,
    });
  });

  it('uses cache for repeated lookups', async () => {
    const octokit = {
      users: {
        getByUsername: jest.fn().mockResolvedValue({
          data: {
            created_at: '2024-01-01T00:00:00.000Z',
            followers: 10,
            public_repos: 20,
          },
        }),
      },
    } as any;

    const first = await getReputation(octokit, 'cached-user');
    const second = await getReputation(octokit, 'cached-user');

    expect(second).toBe(first);
    expect(octokit.users.getByUsername).toHaveBeenCalledTimes(1);
  });
});
