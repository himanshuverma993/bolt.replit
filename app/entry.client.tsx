import { RemixBrowser } from '@remix-run/react';
import { startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { purgeLegacyGitHubCookies } from '~/lib/github/client';

/*
 * The previous GitHub integration stored the token in a JavaScript-readable
 * cookie. Remove it on every page load - not only when the settings tab opens -
 * so a stale credential does not survive in the browser.
 */
purgeLegacyGitHubCookies();

startTransition(() => {
  hydrateRoot(document.getElementById('root')!, <RemixBrowser />);
});
