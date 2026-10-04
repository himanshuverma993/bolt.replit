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
});
