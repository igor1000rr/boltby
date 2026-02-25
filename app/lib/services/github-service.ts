import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';
import Cookies from 'js-cookie';
import type { FileMap } from '~/lib/stores/files';
import { extractRelativePath } from '~/utils/diff';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('GitHubService');

export async function pushProjectToGitHub(
  files: FileMap,
  repoName: string,
  commitMessage?: string,
  githubUsername?: string,
  ghToken?: string,
  isPrivate: boolean = false,
) {
  const githubToken = ghToken || Cookies.get('githubToken');
  const owner = githubUsername || Cookies.get('githubUsername');

  if (!githubToken || !owner) {
    throw new Error('GitHub token or username is not set in cookies or provided.');
  }

  const octokit = new Octokit({ auth: githubToken });
  let repo: RestEndpointMethodTypes['repos']['get']['response']['data'];
  let visibilityJustChanged = false;

  try {
    const resp = await octokit.repos.get({ owner, repo: repoName });
    repo = resp.data;

    if (repo.private !== isPrivate) {
      try {
        const { data: updatedRepo } = await octokit.repos.update({
          owner,
          repo: repoName,
          private: isPrivate,
        });
        repo = updatedRepo;
        visibilityJustChanged = true;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (visibilityError) {
        logger.error('Failed to update repository visibility:', visibilityError);
      }
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) {
      const { data: newRepo } = await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        private: isPrivate,
        auto_init: true,
      });
      repo = newRepo;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } else {
      throw error;
    }
  }

  if (!files || Object.keys(files).length === 0) {
    throw new Error('No files found to push');
  }

  const pushFilesToRepo = async (attempt = 1): Promise<string> => {
    const maxAttempts = 3;

    try {
      const blobs = await Promise.all(
        Object.entries(files).map(async ([filePath, dirent]) => {
          if (dirent?.type === 'file' && dirent.content) {
            const { data: blob } = await octokit.git.createBlob({
              owner: repo.owner.login,
              repo: repo.name,
              content: Buffer.from(dirent.content).toString('base64'),
              encoding: 'base64',
            });
            return { path: extractRelativePath(filePath), sha: blob.sha };
          }

          return null;
        }),
      );

      const validBlobs = blobs.filter(Boolean);

      if (validBlobs.length === 0) {
        throw new Error('No valid files to push');
      }

      const repoRefresh = await octokit.repos.get({ owner, repo: repoName });
      repo = repoRefresh.data;

      const { data: ref } = await octokit.git.getRef({
        owner: repo.owner.login,
        repo: repo.name,
        ref: `heads/${repo.default_branch || 'main'}`,
      });
      const latestCommitSha = ref.object.sha;

      const { data: newTree } = await octokit.git.createTree({
        owner: repo.owner.login,
        repo: repo.name,
        base_tree: latestCommitSha,
        tree: validBlobs.map((blob) => ({
          path: blob!.path,
          mode: '100644',
          type: 'blob',
          sha: blob!.sha,
        })),
      });

      const { data: newCommit } = await octokit.git.createCommit({
        owner: repo.owner.login,
        repo: repo.name,
        message: commitMessage || 'Initial commit from your app',
        tree: newTree.sha,
        parents: [latestCommitSha],
      });

      await octokit.git.updateRef({
        owner: repo.owner.login,
        repo: repo.name,
        ref: `heads/${repo.default_branch || 'main'}`,
        sha: newCommit.sha,
      });

      return repo.html_url;
    } catch (error) {
      if ((visibilityJustChanged || attempt === 1) && attempt < maxAttempts) {
        const delayMs = attempt * 2000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        return pushFilesToRepo(attempt + 1);
      }

      throw error;
    }
  };

  return pushFilesToRepo();
}
