const MAX_ERROR_LENGTH = 800;
const MAX_RETRY_DEPTH = 5;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function redactSensitiveValues(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, '$1[redacted]')
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,}]+/gi, '$1[redacted]')
    .replace(/(token\s*[:=]\s*)[^\s,}]+/gi, '$1[redacted]')
    .replace(/(secret\s*[:=]\s*)[^\s,}]+/gi, '$1[redacted]');
}

function truncate(value: string): string {
  const redacted = redactSensitiveValues(value).replace(/\s+/g, ' ').trim();
  return redacted.length > MAX_ERROR_LENGTH ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…` : redacted;
}

function getSafeResponseBody(error: Record<string, unknown>): string | undefined {
  const responseBody = error.responseBody;

  if (typeof responseBody !== 'string' || responseBody.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(responseBody) as unknown;
    const parsedRecord = asRecord(parsed);
    const providerError = parsedRecord?.error;

    if (typeof providerError === 'string') {
      return truncate(providerError);
    }

    if (parsedRecord && providerError && typeof providerError === 'object') {
      const providerErrorRecord = providerError as Record<string, unknown>;
      const summary = {
        message: providerErrorRecord.message,
        code: providerErrorRecord.code,
        type: providerErrorRecord.type,
      };
      const fields = Object.entries(summary).filter(([, value]) => value !== undefined);

      if (fields.length > 0) {
        return truncate(JSON.stringify(Object.fromEntries(fields)));
      }
    }

    if (parsedRecord) {
      const summary = Object.fromEntries(
        ['message', 'code', 'type', 'success', 'errors'].flatMap((key) =>
          parsedRecord[key] === undefined ? [] : [[key, parsedRecord[key]]],
        ),
      );

      if (Object.keys(summary).length > 0) {
        return truncate(JSON.stringify(summary));
      }
    }
  } catch {
    // Non-JSON provider bodies are intentionally omitted so a provider cannot echo user content.
  }

  return undefined;
}

function unwrapRetryError(error: unknown): Record<string, unknown> | undefined {
  let current = error;

  for (let depth = 0; depth < MAX_RETRY_DEPTH; depth += 1) {
    const record = asRecord(current);

    if (!record) {
      return undefined;
    }

    if (record.lastError !== undefined) {
      current = record.lastError;
      continue;
    }

    return record;
  }

  return undefined;
}

/**
 * Converts provider/AI SDK errors to a bounded message safe to send to the browser.
 * Request bodies, URLs, headers, API keys, and user content are never included.
 */
export function getErrorMessage(error: unknown): string {
  const record = unwrapRetryError(error);
  const statusCode = typeof record?.statusCode === 'number' ? ` (HTTP ${record.statusCode})` : '';
  const message =
    typeof record?.message === 'string'
      ? record.message
      : error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown provider error';
  const responseBody = record ? getSafeResponseBody(record) : undefined;
  const safeMessage = truncate(message || 'Unknown provider error');
  const result = `${safeMessage}${statusCode}${responseBody ? `: ${responseBody}` : ''}`;

  console.error('[llm] streaming error:', result);

  return result;
}
