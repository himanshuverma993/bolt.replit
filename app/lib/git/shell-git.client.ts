/**
 * Runtime probe for a `git` binary inside the WebContainer shell.
 *
 * Bolt's GitHub features (push) use the GitHub REST API from the Worker, so they
 * keep working when the WebContainer has no shell git. The UI must show the two
 * capabilities separately instead of reporting "git is not available" for
 * everything, which is what this probe exists for.
 */

export type ShellGitStatus = 'available' | 'unavailable' | 'unknown';

export type ShellGitProbe = {
  status: ShellGitStatus;
  detail: string;
};

const PROBE_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readVersion(
  process: Awaited<ReturnType<Awaited<ReturnType<typeof getWebContainer>>['spawn']>>,
): Promise<string> {
  let version = '';

  await process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        version += chunk;
      },
    }),
  );

  return version.trim().split('\n')[0] ?? '';
}

async function getWebContainer() {
  const { webcontainer } = await import('~/lib/webcontainer');

  return webcontainer;
}

/** Probes `git --version` in the WebContainer. Never throws. */
export async function detectShellGit(): Promise<ShellGitProbe> {
  if (typeof window === 'undefined') {
    return { status: 'unknown', detail: 'Shell git can only be probed in the browser.' };
  }

  try {
    const container = await withTimeout(getWebContainer(), PROBE_TIMEOUT_MS, 'WebContainer boot');

    let process: Awaited<ReturnType<typeof container.spawn>>;

    try {
      process = await withTimeout(container.spawn('git', ['--version']), PROBE_TIMEOUT_MS, 'git spawn');
    } catch (error) {
      return {
        status: 'unavailable',
        detail: error instanceof Error ? error.message : 'git could not be started in the WebContainer shell.',
      };
    }

    const version = await withTimeout(readVersion(process), PROBE_TIMEOUT_MS, 'git --version');
    const exitCode = await withTimeout(process.exit, PROBE_TIMEOUT_MS, 'git exit');

    if (exitCode === 0 && version) {
      return { status: 'available', detail: version };
    }

    return {
      status: 'unavailable',
      detail: version || `git exited with code ${exitCode}`,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : 'git is not available in the WebContainer shell.',
    };
  }
}
