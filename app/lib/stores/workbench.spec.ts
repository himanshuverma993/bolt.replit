import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store method the "Push to GitHub" button calls.
 *
 * Only `fetch` is stubbed, so this covers the real client (`~/lib/github/client`)
 * and the real payload builder: which files are included (text only, work dir
 * stripped), what happens with an empty project, and how a server-classified
 * failure reaches the UI.
 */

vi.mock('~/lib/webcontainer', () => ({ webcontainer: new Promise(() => undefined) }));

const { WorkbenchStore: workbenchStoreClass } = await import('./workbench');

type Captured = { url: string; body: Record<string, unknown> };

const captured: Captured[] = [];

function stubFetch(response: Response | Error): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    captured.push({ url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });

    if (response instanceof Error) {
      throw response;
    }

    return response;
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function storeWith(files: Record<string, { type: string; content?: string; isBinary?: boolean }>) {
  const store = new workbenchStoreClass();

  store.files.set(files as never);

  return store;
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workbenchStore.pushToGitHub', () => {
  it('pushes only text files, with the work directory stripped from every path', async () => {
    stubFetch(
      jsonResponse({
        owner: 'octocat',
        repo: 'demo',
        htmlUrl: 'https://github.example.test/octocat/demo',
        branch: 'main',
        commitSha: 'commit-1',
        created: true,
        emptyRepository: true,
        filesWritten: 2,
        filesSkipped: 1,
        skippedPaths: ['assets/logo.png'],
        pushedBy: 'octocat',
        pushedAt: '2026-10-04T00:00:00.000Z',
      }),
    );

    const store = storeWith({
      '/home/project/src/index.js': { type: 'file', content: 'console.log(1);' },
      '/home/project/README.md': { type: 'file', content: '# demo' },
      '/home/project/assets/logo.png': { type: 'file', content: 'binary', isBinary: true },
      '/home/project/src': { type: 'folder' },
    });

    const result = await store.pushToGitHub('demo', { message: 'initial', branch: 'dev', isPrivate: true });

    expect(result.filesWritten).toBe(2);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('/api/github');
    expect(captured[0].body).toEqual({
      action: 'push',
      repoName: 'demo',
      files: [
        { path: 'src/index.js', content: 'console.log(1);' },
        { path: 'README.md', content: '# demo' },
      ],
      message: 'initial',
      branch: 'dev',
      isPrivate: true,
    });
  });

  it('omits optional options instead of sending them as undefined', async () => {
    stubFetch(jsonResponse({ filesWritten: 1, owner: 'octocat', repo: 'demo', branch: 'main' }));

    const store = storeWith({ '/home/project/index.js': { type: 'file', content: 'x' } });

    await store.pushToGitHub('demo');

    expect(captured[0].body).toEqual({
      action: 'push',
      repoName: 'demo',
      files: [{ path: 'index.js', content: 'x' }],
    });
  });

  it('refuses an empty project before contacting the server', async () => {
    stubFetch(jsonResponse({}));

    const store = storeWith({ '/home/project/src': { type: 'folder' } });

    await expect(store.pushToGitHub('demo')).rejects.toThrow(/no text files to push/i);
    expect(captured).toHaveLength(0);
  });

  it('surfaces the server classification and hint through the real client', async () => {
    stubFetch(
      jsonResponse(
        {
          error: 'GitHub refused the request (HTTP 403): Resource not accessible by integration',
          code: 'insufficient_permissions',
          hint: 'Create the repository on GitHub first.',
        },
        403,
      ),
    );

    const store = storeWith({ '/home/project/index.js': { type: 'file', content: 'x' } });

    await expect(store.pushToGitHub('demo')).rejects.toMatchObject({
      name: 'GitHubClientError',
      code: 'insufficient_permissions',
      hint: 'Create the repository on GitHub first.',
      status: 403,
    });
  });

  it('reports an unreachable server as a network failure rather than a GitHub refusal', async () => {
    stubFetch(new Error('socket hang up'));

    const store = storeWith({ '/home/project/index.js': { type: 'file', content: 'x' } });

    await expect(store.pushToGitHub('demo')).rejects.toMatchObject({
      name: 'GitHubClientError',
      code: 'network',
      status: 0,
    });
  });
});
