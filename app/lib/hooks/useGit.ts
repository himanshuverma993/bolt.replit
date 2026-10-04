import type { WebContainer } from '@webcontainer/api';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { webcontainer as webcontainerPromise } from '~/lib/webcontainer';
import git, { type GitAuth, type PromiseFsClient } from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import Cookies from 'js-cookie';
import { toast } from 'react-toastify';

/**
 * Clone credentials are held in memory for this browser session only.
 *
 * The previous implementation persisted them in a JavaScript-readable
 * `git:<domain>` cookie, which is exactly how a PAT leaks into page scripts and
 * backups. Cookies of that shape are deleted when they are encountered.
 */
const gitAuthMemory = new Map<string, GitAuth>();

const gitDomain = (url: string) => url.split('/')[2] ?? url;

const lookupSavedPassword = (url: string) => {
  const domain = gitDomain(url);
  const legacyCookie = Cookies.get(`git:${domain}`);

  if (legacyCookie) {
    // Migration: remove the JavaScript-readable credential cookie.
    Cookies.remove(`git:${domain}`);
    console.warn('Removed a legacy git credential cookie; clone credentials are now kept in memory only.');
  }

  return gitAuthMemory.get(domain) ?? undefined;
};

const saveGitAuth = (url: string, auth: GitAuth) => {
  gitAuthMemory.set(gitDomain(url), auth);
};

/** Clears in-memory clone credentials (called by tests and on explicit sign-out). */
export const clearInMemoryGitAuth = () => {
  gitAuthMemory.clear();
};

export function useGit() {
  const [ready, setReady] = useState(false);
  const [webcontainer, setWebcontainer] = useState<WebContainer>();
  const [fs, setFs] = useState<PromiseFsClient>();
  const fileData = useRef<Record<string, { data: any; encoding?: string }>>({});
  useEffect(() => {
    webcontainerPromise.then((container) => {
      fileData.current = {};
      setWebcontainer(container);
      setFs(getFs(container, fileData));
      setReady(true);
    });
  }, []);

  const gitClone = useCallback(
    async (url: string) => {
      if (!webcontainer || !fs || !ready) {
        throw 'Webcontainer not initialized';
      }

      fileData.current = {};
      await git.clone({
        fs,
        http,
        dir: webcontainer.workdir,
        url,
        depth: 1,
        singleBranch: true,
        corsProxy: 'https://cors.isomorphic-git.org',
        onAuth: (url) => {
          // let domain=url.split("/")[2]

          const auth = lookupSavedPassword(url);

          if (auth) {
            return auth;
          }

          if (confirm('This repo is password protected. Ready to enter a username & password?')) {
            return {
              username: prompt('Enter username') ?? undefined,
              password: prompt('Enter password') ?? undefined,
            };
          }

          return { cancel: true };
        },
        onAuthFailure: (url, _auth) => {
          toast.error(`Error Authenticating with ${url.split('/')[2]}`);
        },
        onAuthSuccess: (url, auth) => {
          saveGitAuth(url, auth);
        },
      });

      const data: Record<string, { data: any; encoding?: string }> = {};

      for (const [key, value] of Object.entries(fileData.current)) {
        data[key] = value;
      }

      return { workdir: webcontainer.workdir, data };
    },
    [webcontainer],
  );

  return { ready, gitClone };
}

const getFs = (
  webcontainer: WebContainer,
  record: MutableRefObject<Record<string, { data: any; encoding?: string }>>,
) => ({
  promises: {
    readFile: async (path: string, options: any) => {
      const encoding = options.encoding;
      const relativePath = pathUtils.relative(webcontainer.workdir, path);
      console.log('readFile', relativePath, encoding);

      return await webcontainer.fs.readFile(relativePath, encoding);
    },
    writeFile: async (path: string, data: any, options: any) => {
      const encoding = options.encoding;
      const relativePath = pathUtils.relative(webcontainer.workdir, path);
      console.log('writeFile', { relativePath, data, encoding });

      if (record.current) {
        record.current[relativePath] = { data, encoding };
      }

      return await webcontainer.fs.writeFile(relativePath, data, { ...options, encoding });
    },
    mkdir: async (path: string, options: any) => {
      const relativePath = pathUtils.relative(webcontainer.workdir, path);
      console.log('mkdir', relativePath, options);

      return await webcontainer.fs.mkdir(relativePath, { ...options, recursive: true });
    },
    readdir: async (path: string, options: any) => {
      const relativePath = pathUtils.relative(webcontainer.workdir, path);
      console.log('readdir', relativePath, options);

      return await webcontainer.fs.readdir(relativePath, options);
    },
    rm: async (path: string, options: any) => {
      const relativePath = pathUtils.relative(webcontainer.workdir, path);
      console.log('rm', relativePath, options);

      return await webcontainer.fs.rm(relativePath, { ...(options || {}) });
    },
    rmdir: async (path: string, options: any) => {
      const relativePath = pathUtils.relative(webcontainer.workdir, path);
      console.log('rmdir', relativePath, options);

      return await webcontainer.fs.rm(relativePath, { recursive: true, ...options });
    },

    // Mock implementations for missing functions
    unlink: async (path: string) => {
      // unlink is just removing a single file
      const relativePath = pathUtils.relative(webcontainer.workdir, path);
      return await webcontainer.fs.rm(relativePath, { recursive: false });
    },

    stat: async (path: string) => {
      try {
        const relativePath = pathUtils.relative(webcontainer.workdir, path);
        const resp = await webcontainer.fs.readdir(pathUtils.dirname(relativePath), { withFileTypes: true });
        const name = pathUtils.basename(relativePath);
        const fileInfo = resp.find((x) => x.name == name);

        if (!fileInfo) {
          throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
        }

        return {
          isFile: () => fileInfo.isFile(),
          isDirectory: () => fileInfo.isDirectory(),
          isSymbolicLink: () => false,
          size: 1,
          mode: 0o666, // Default permissions
          mtimeMs: Date.now(),
          uid: 1000,
          gid: 1000,
        };
      } catch (error: any) {
        console.log(error?.message);

        const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        err.errno = -2;
        err.syscall = 'stat';
        err.path = path;
        throw err;
      }
    },

    lstat: async (path: string) => {
      /*
       * For basic usage, lstat can return the same as stat
       * since we're not handling symbolic links
       */
      return await getFs(webcontainer, record).promises.stat(path);
    },

    readlink: async (path: string) => {
      /*
       * Since WebContainer doesn't support symlinks,
       * we'll throw a "not a symbolic link" error
       */
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    },

    symlink: async (target: string, path: string) => {
      /*
       * Since WebContainer doesn't support symlinks,
       * we'll throw a "operation not supported" error
       */
      throw new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`);
    },

    chmod: async (_path: string, _mode: number) => {
      /*
       * WebContainer doesn't support changing permissions,
       * but we can pretend it succeeded for compatibility
       */
      return await Promise.resolve();
    },
  },
});

const pathUtils = {
  dirname: (path: string) => {
    // Handle empty or just filename cases
    if (!path || !path.includes('/')) {
      return '.';
    }

    // Remove trailing slashes
    path = path.replace(/\/+$/, '');

    // Get directory part
    return path.split('/').slice(0, -1).join('/') || '/';
  },

  basename: (path: string, ext?: string) => {
    // Remove trailing slashes
    path = path.replace(/\/+$/, '');

    // Get the last part of the path
    const base = path.split('/').pop() || '';

    // If extension is provided, remove it from the result
    if (ext && base.endsWith(ext)) {
      return base.slice(0, -ext.length);
    }

    return base;
  },
  relative: (from: string, to: string): string => {
    // Handle empty inputs
    if (!from || !to) {
      return '.';
    }

    // Normalize paths by removing trailing slashes and splitting
    const normalizePathParts = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean);

    const fromParts = normalizePathParts(from);
    const toParts = normalizePathParts(to);

    // Find common parts at the start of both paths
    let commonLength = 0;
    const minLength = Math.min(fromParts.length, toParts.length);

    for (let i = 0; i < minLength; i++) {
      if (fromParts[i] !== toParts[i]) {
        break;
      }

      commonLength++;
    }

    // Calculate the number of "../" needed
    const upCount = fromParts.length - commonLength;

    // Get the remaining path parts we need to append
    const remainingPath = toParts.slice(commonLength);

    // Construct the relative path
    const relativeParts = [...Array(upCount).fill('..'), ...remainingPath];

    // Handle empty result case
    return relativeParts.length === 0 ? '.' : relativeParts.join('/');
  },
};
