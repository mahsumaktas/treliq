/**
 * Unit tests for webhook signature verification
 */

import { createHmac } from 'crypto';

// Mock @octokit/* ESM modules to avoid import errors
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(),
}));
jest.mock('@octokit/graphql', () => ({
  graphql: jest.fn(),
}));

import { verifySignature } from '../../src/server/webhooks';

describe('verifySignature', () => {
  const secret = 'test-webhook-secret';
  const payload = '{"action":"opened","number":1}';

  /**
   * Helper to compute HMAC-SHA256 signature
   */
  function computeSignature(payload: string, secret: string): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(payload, 'utf8');
    return `sha256=${hmac.digest('hex')}`;
  }

  it('should return true for valid signature', () => {
    const validSignature = computeSignature(payload, secret);
    expect(verifySignature(payload, validSignature, secret)).toBe(true);
  });

  it('should return false for invalid signature', () => {
    const invalidSignature = 'sha256=invalidhexstring';
    expect(verifySignature(payload, invalidSignature, secret)).toBe(false);
  });

  it('should return false for empty signature', () => {
    expect(verifySignature(payload, '', secret)).toBe(false);
  });

  it('should return false for tampered payload', () => {
    const validSignature = computeSignature(payload, secret);
    const tamperedPayload = '{"action":"closed","number":1}';
    expect(verifySignature(tamperedPayload, validSignature, secret)).toBe(false);
  });

  it('should return false for wrong secret', () => {
    const validSignature = computeSignature(payload, secret);
    const wrongSecret = 'wrong-secret';
    expect(verifySignature(payload, validSignature, wrongSecret)).toBe(false);
  });

  it('should return false for malformed signature (missing sha256 prefix)', () => {
    const hmac = createHmac('sha256', secret);
    hmac.update(payload, 'utf8');
    const signatureWithoutPrefix = hmac.digest('hex');
    expect(verifySignature(payload, signatureWithoutPrefix, secret)).toBe(false);
  });

  it('should handle different payload sizes', () => {
    const largePayload = JSON.stringify({ data: 'x'.repeat(10000) });
    const signature = computeSignature(largePayload, secret);
    expect(verifySignature(largePayload, signature, secret)).toBe(true);
  });

  it('should be case-sensitive for signature', () => {
    const validSignature = computeSignature(payload, secret);
    const uppercaseSignature = validSignature.toUpperCase();
    expect(verifySignature(payload, uppercaseSignature, secret)).toBe(false);
  });
});
