import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from '~/utils/path';
import { unreachable } from '~/utils/unreachable';

interface LoggerLike {
  debug: (...messages: any[]) => void;
}

interface DeployAlertLike {
  (alert: {
    type: 'info' | 'error' | 'success';
    title: string;
    description: string;
    content?: string;
    stage: 'building' | 'deploying';
    buildStatus: 'running' | 'failed' | 'complete';
    deployStatus: 'pending' | 'running';
    source: 'netlify' | 'vercel' | 'github';
  }): void;
}

interface ActionCommandErrorLike {
  new (message: string, output: string): Error;
}

interface BuildActionLike {
  type: 'build';
}

export async function runBuildActionHandler(params: {
  action: BuildActionLike;
  webcontainer: Promise<WebContainer>;
  logger: LoggerLike;
  onDeployAlert?: DeployAlertLike;
  actionCommandError: ActionCommandErrorLike;
}) {
  const { action, webcontainer, logger, onDeployAlert, actionCommandError } = params;

  if (action.type !== 'build') {
    unreachable('Expected build action');
  }

  onDeployAlert?.({
    type: 'info',
    title: 'Building Application',
    description: 'Building your application...',
    stage: 'building',
    buildStatus: 'running',
    deployStatus: 'pending',
    source: 'netlify',
  });

  const wc = await webcontainer;
  const buildProcess = await wc.spawn('npm', ['run', 'build']);

  let output = '';
  buildProcess.output.pipeTo(
    new WritableStream({
      write(data) {
        output += data;
      },
    }),
  );

  const exitCode = await buildProcess.exit;

  if (exitCode !== 0) {
    onDeployAlert?.({
      type: 'error',
      title: 'Build Failed',
      description: 'Your application build failed',
      content: output || 'No build output available',
      stage: 'building',
      buildStatus: 'failed',
      deployStatus: 'pending',
      source: 'netlify',
    });

    throw new actionCommandError('Build Failed', output || 'No Output Available');
  }

  onDeployAlert?.({
    type: 'success',
    title: 'Build Completed',
    description: 'Your application was built successfully',
    stage: 'deploying',
    buildStatus: 'complete',
    deployStatus: 'running',
    source: 'netlify',
  });

  const commonBuildDirs = ['dist', 'build', 'out', 'output', '.next', 'public'];
  let buildDir = '';

  for (const dir of commonBuildDirs) {
    const dirPath = nodePath.join(wc.workdir, dir);

    try {
      await wc.fs.readdir(dirPath);
      buildDir = dirPath;
      logger.debug(`Found build directory: ${buildDir}`);
      break;
    } catch (error) {
      logger.debug(`Build directory ${dir} not found, trying next option. ${error}`);
    }
  }

  if (!buildDir) {
    buildDir = nodePath.join(wc.workdir, 'dist');
    logger.debug(`No build directory found, defaulting to: ${buildDir}`);
  }

  return {
    path: buildDir,
    exitCode,
    output,
  };
}
