import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/*
 * Same stub as cloudflare.spec.ts: importing the real BaseProvider pulls in the
 * whole provider registry, which is unnecessary for a configuration assertion.
 */
vi.mock('~/lib/modules/llm/base-provider', () => ({
  BaseProvider: class {},
}));

import CloudflareProvider from './cloudflare';

/**
 * Configuration guards for the Cloudflare Workers AI deployment.
 *
 * These assertions protect settings that were deliberately chosen and must not
 * be "cleaned up" by accident:
 *  - the `[ai]` binding that makes `env.AI.run` available at runtime;
 *  - `keep_vars = true`;
 *  - the intentionally empty `[previews]` block required by `npx wrangler preview`.
 */

const root = process.cwd();
const wrangler = readFileSync(join(root, 'wrangler.toml'), 'utf8');

describe('Cloudflare Workers AI configuration', () => {
  it('declares the AI binding used by the provider', () => {
    expect(wrangler).toMatch(/\[ai\][\s\S]*?binding\s*=\s*"AI"/);
  });

  it('keeps the intentional Cloudflare settings', () => {
    expect(wrangler).toContain('keep_vars = true');
    expect(wrangler).toContain('[previews]');
    expect(wrangler).toContain('nodejs_compat');
  });

  it('ships the two verified Workers AI model ids without requiring an API key', () => {
    const provider = new CloudflareProvider();

    expect(provider.requiresApiKey).toBe(false);
    expect(provider.staticModels.map((model) => model.name)).toEqual([
      '@cf/meta/llama-3.1-8b-instruct-fp8',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    ]);
    expect(provider.labelForGetApiKey).toMatch(/no api key/i);
  });

  it('exposes the provider under the Cloudflare name so the model list can include it', () => {
    const provider = new CloudflareProvider();

    expect(provider.name).toBe('Cloudflare');
    expect(provider.staticModels.every((model) => model.provider === 'Cloudflare')).toBe(true);
  });
});
