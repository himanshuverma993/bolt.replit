// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { ProviderInfo } from '~/types/model';

/**
 * The provider key panel is where "Cloudflare needs no API key" becomes visible
 * to the user, so it is pinned here: the Cloudflare provider is rendered as a
 * keyless provider, and a keyed provider still shows/hides/masks its key.
 */

const refreshGlobals = globalThis as unknown as Record<string, unknown>;
refreshGlobals.$RefreshReg$ = () => undefined;
refreshGlobals.$RefreshSig$ = () => (type: unknown) => type;
refreshGlobals.__vite_plugin_react_preamble_installed__ = true;

const { APIKeyManager: apiKeyManager } = await import('./APIKeyManager');

function provider(name: string, requiresApiKey: boolean, noApiKeyNote?: string): ProviderInfo {
  return { name, staticModels: [], requiresApiKey, noApiKeyNote };
}

/**
 * Kept in sync with `noApiKeyNote` on CloudflareProvider /
 * FreeLLMAPIProvider — the panel must surface each provider's own
 * explanation of why no key is needed.
 */
const CLOUDFLARE_NOTE = "no API key needed — runs on your Cloudflare account's Workers AI free tier.";
const FREELLM_NOTE =
  'no API key needed — free agentic coding models (GLM 5.3, Kimi K3) run through your FreeLLMAPI router. ' +
  'Local bolt builds reach it at the default localhost:3001; hosted builds (e.g. Cloudflare Workers) need the ' +
  "router's public URL under Settings → Providers.";

function element(info: ProviderInfo, apiKey: string, setApiKey: (key: string) => void = () => undefined) {
  return React.createElement(apiKeyManager, { provider: info, apiKey, setApiKey });
}

afterEach(cleanup);

describe('provider API key panel', () => {
  it('tells the user the Cloudflare provider needs no API key', () => {
    render(element(provider('Cloudflare', false, CLOUDFLARE_NOTE), ''));

    const note = screen.getByText(/no API key needed/);
    expect(note.textContent).toContain('Cloudflare');
    expect(note.textContent).toContain('Workers AI');
    expect(screen.getByText(/Optional key:/)).toBeTruthy();
    expect(screen.getByText('not set (works without a key)')).toBeTruthy();
  });

  it('shows the FreeLLMAPI provider note instead of asking for a key', () => {
    render(element(provider('FreeLLMAPI', false, FREELLM_NOTE), ''));

    const note = screen.getByText(/no API key needed/);
    expect(note.textContent).toContain('FreeLLMAPI');
    expect(note.textContent).toContain('GLM 5.3');
    expect(note.textContent).toContain('Kimi K3');
  });

  it('lets a keyless provider store an optional key (UnoRouter / HuggingFace token)', () => {
    const setApiKey = vi.fn();

    render(element(provider('FreeLLMAPI', false, FREELLM_NOTE), '', setApiKey));

    fireEvent.click(screen.getByTitle('Edit API Key'));

    const input = screen.getByPlaceholderText(/Optional key/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'unr-free-key' } });
    fireEvent.click(screen.getByTitle('Save API Key'));

    expect(setApiKey).toHaveBeenCalledWith('unr-free-key');
  });

  it('falls back to a generic note for keyless providers without one', () => {
    render(element(provider('Keyless', false), ''));

    expect(screen.getByText(/no API key needed/)).toBeTruthy();
  });

  it('shows a masked key for a keyed provider and saves an edit through setApiKey', () => {
    const setApiKey = vi.fn();

    render(element(provider('OpenAI', true), 'sk-existing', setApiKey));

    expect(screen.getByText(/OpenAI API Key:/)).toBeTruthy();
    expect(screen.getByText('••••••••')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Edit API Key'));

    const input = screen.getByPlaceholderText('Your API Key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByTitle('Save API Key'));

    expect(setApiKey).toHaveBeenCalledWith('sk-new');
    expect(screen.queryByPlaceholderText('Your API Key')).toBeNull();
  });

  it('does not treat an unset key as a failure for a keyed provider', () => {
    render(element(provider('Anthropic', true), ''));

    expect(screen.getByText(/Not set \(will still work if set in .env file\)/)).toBeTruthy();
  });
});
