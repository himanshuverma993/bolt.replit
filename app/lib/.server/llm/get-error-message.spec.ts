import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './get-error-message';

describe('getErrorMessage', () => {
  it('returns a bounded message for a normal provider error', () => {
    expect(getErrorMessage(new Error('Workers AI request failed'))).toBe('Workers AI request failed');
  });

  it('unwraps retry errors and redacts bearer credentials', () => {
    const message = getErrorMessage({
      lastError: {
        message: 'Authorization: Bearer do-not-send-this-value',
        statusCode: 401,
      },
    });

    expect(message).toContain('Authorization: Bearer [redacted]');
    expect(message).toContain('(HTTP 401)');
    expect(message).not.toContain('do-not-send-this-value');
  });

  it('redacts bare vendor key shapes that appear without a key= prefix', () => {
    const message = getErrorMessage(new Error('Upstream rejected sk-ant-api03-abcdefghijklmnopqrstuvwxyz'));

    expect(message).toContain('[redacted-api-key]');
    expect(message).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  });

  it('summarizes structured provider responses without returning the request body', () => {
    const message = getErrorMessage({
      message: 'Provider request failed',
      responseBody: JSON.stringify({ error: { message: 'Model is unavailable', code: 'model_not_found' } }),
    });

    expect(message).toContain('Model is unavailable');
    expect(message).toContain('model_not_found');
    expect(message).not.toContain('responseBody');
  });

  it('answers the FreeLLMAPI loopback 403 with actionable router guidance', () => {
    const message = getErrorMessage({
      message: 'Forbidden',
      statusCode: 403,
      url: 'http://localhost:3001/v1/chat/completions',
    });

    expect(message).toContain('FreeLLMAPI router is not reachable');
    expect(message).toContain('Settings → Providers → FreeLLMAPI');
    expect(message).toContain('FREELLM_API_BASE_URL');
  });

  it('covers the 127.0.0.1 form and connection failures, but leaves real router statuses alone', () => {
    const loopbackIp = getErrorMessage({
      message: 'Forbidden',
      statusCode: 403,
      url: 'http://127.0.0.1:3001/v1/chat/completions',
    });

    expect(loopbackIp).toContain('FreeLLMAPI router is not reachable');

    const noRouter = getErrorMessage({ message: 'fetch failed', url: 'http://localhost:3001/v1/chat/completions' });

    expect(noRouter).toContain('FreeLLMAPI router is not reachable');

    const realRouterError = getErrorMessage({
      message: 'Too Many Requests',
      statusCode: 429,
      url: 'http://localhost:3001/v1/chat/completions',
    });

    expect(realRouterError).toContain('Too Many Requests');
    expect(realRouterError).toContain('(HTTP 429)');
    expect(realRouterError).not.toContain('FreeLLMAPI router is not reachable');
  });
});
