import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { json } from '@remix-run/cloudflare';
import { getRequestOrigin, isSecureOrigin } from '~/lib/.server/secrets';

/**
 * OAuth client metadata document (SEP-991 / RFC 7591 `client_metadata`).
 *
 * Authorization servers that support URL-based client IDs fetch this document
 * instead of requiring dynamic client registration. It contains only public
 * information: no secret, no credential, nothing user-specific.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!isSecureOrigin(request)) {
    return json({ error: 'Client metadata is served over https only' }, { status: 400 });
  }

  const origin = getRequestOrigin(request);

  return json(
    {
      client_id: `${origin}/api/mcp/oauth/client-metadata`,
      client_name: 'Bolt (bolt-replit)',
      client_uri: origin,
      redirect_uris: [`${origin}/api/mcp/oauth/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    },
  );
}
