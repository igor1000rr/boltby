import type { GitHubUserResponse } from './GitHub';

export interface GitHubConnectionStorage {
  user?: GitHubUserResponse;
  token?: string;
}
