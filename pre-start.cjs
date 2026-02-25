const { execSync, spawnSync } = require('child_process');

// LM Studio auto-start disabled: it competes with Ollama for GPU VRAM.
// On 8GB GPUs, only ONE local LLM server should hold models in memory.
// To use LM Studio instead of Ollama, start it manually and stop Ollama.
//
// const startLMStudio = () => { ... };
// startLMStudio();
console.log('ℹ️  LM Studio auto-start disabled (GPU shared with Ollama)');

const POCKETBASE_VERSION = '0.36.5';

const downloadPocketBase = (destPath) => {
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  const os = require('os');

  const platform = os.platform();
  const arch = os.arch();

  let pbPlatform, pbArch;

  if (platform === 'linux') {
    pbPlatform = 'linux';
  } else if (platform === 'darwin') {
    pbPlatform = 'darwin';
  } else if (platform === 'win32') {
    pbPlatform = 'windows';
  } else {
    console.log('⚠️  Unsupported platform for PocketBase auto-download:', platform);
    return false;
  }

  if (arch === 'x64' || arch === 'amd64') {
    pbArch = 'amd64';
  } else if (arch === 'arm64' || arch === 'aarch64') {
    pbArch = 'arm64';
  } else {
    console.log('⚠️  Unsupported architecture for PocketBase auto-download:', arch);
    return false;
  }

  const url = `https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_${pbPlatform}_${pbArch}.zip`;
  const tmpZip = path.join(os.tmpdir(), 'pocketbase_download.zip');

  console.log(`📦 Downloading PocketBase v${POCKETBASE_VERSION} for ${pbPlatform}/${pbArch}...`);

  try {
    execSync(`curl -L -o "${tmpZip}" "${url}"`, { stdio: 'pipe', timeout: 120000 });

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    execSync(`unzip -o "${tmpZip}" pocketbase -d "${path.dirname(destPath)}"`, { stdio: 'pipe' });
    fs.chmodSync(destPath, 0o755);
    fs.unlinkSync(tmpZip);

    console.log('✅ PocketBase downloaded successfully to', destPath);
    return true;
  } catch (err) {
    console.log('⚠️  Failed to download PocketBase:', err.message);
    console.log('   Download manually from: https://pocketbase.io/docs/');
    console.log('   Place binary at:', destPath);
    return false;
  }
};

const startPocketBase = () => {
  const path = require('path');
  const fs = require('fs');
  const net = require('net');

  const pbBin = process.env.POCKETBASE_PATH || path.join(process.env.HOME, '.pocketbase', 'pocketbase');
  const pbDataDir = process.env.POCKETBASE_DATA || path.join(process.env.HOME, '.pocketbase', 'pb_data');

  if (!fs.existsSync(pbBin)) {
    if (!downloadPocketBase(pbBin)) {
      return;
    }
  }

  const checkPort = (port) => new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });

  const PB_SUPERUSER_EMAIL = 'admin@bolt.local';
  const PB_SUPERUSER_PASSWORD = 'boltadmin2024';
  const superuserMarker = path.join(path.dirname(pbDataDir), '.superuser_created');

  const ensureSuperuser = () => {
    if (fs.existsSync(superuserMarker)) {
      return;
    }

    try {
      const { spawnSync } = require('child_process');
      const result = spawnSync(
        pbBin,
        ['superuser', 'upsert', PB_SUPERUSER_EMAIL, PB_SUPERUSER_PASSWORD, `--dir=${pbDataDir}`],
        { encoding: 'utf8', timeout: 10000 },
      );

      if (result.status === 0) {
        fs.writeFileSync(superuserMarker, `${PB_SUPERUSER_EMAIL}\n`, 'utf8');
        console.log('✅ PocketBase superuser created:', PB_SUPERUSER_EMAIL);

        const envLocalPath = path.join(process.cwd(), '.env.local');
        let envContent = '';

        if (fs.existsSync(envLocalPath)) {
          envContent = fs.readFileSync(envLocalPath, 'utf8');
        }

        if (!envContent.includes('POCKETBASE_ADMIN_EMAIL')) {
          const pbEnvBlock = [
            '',
            '# === POCKETBASE (local backend) ===',
            `POCKETBASE_ADMIN_EMAIL=${PB_SUPERUSER_EMAIL}`,
            `POCKETBASE_ADMIN_PASSWORD=${PB_SUPERUSER_PASSWORD}`,
            'VITE_POCKETBASE_URL=http://localhost:8090',
            '',
          ].join('\n');
          fs.appendFileSync(envLocalPath, pbEnvBlock, 'utf8');
          console.log('✅ PocketBase credentials saved to .env.local');
        }
      } else {
        console.log('⚠️  Could not create PocketBase superuser:', result.stderr?.trim());
      }
    } catch (err) {
      console.log('⚠️  Superuser creation failed:', err.message);
    }
  };

  checkPort(8090).then((inUse) => {
    if (inUse) {
      console.log('✅ PocketBase already running on port 8090');
      return;
    }

    fs.mkdirSync(path.dirname(pbDataDir), { recursive: true });

    ensureSuperuser();

    const { spawn } = require('child_process');
    const pb = spawn(pbBin, ['serve', '--http=127.0.0.1:8090', `--dir=${pbDataDir}`], {
      detached: true,
      stdio: 'ignore',
    });
    pb.unref();
    console.log('✅ PocketBase started on http://127.0.0.1:8090');
    console.log('   Admin panel: http://127.0.0.1:8090/_/');
    console.log('   Superuser: admin@bolt.local / boltadmin2024');
  });
};

startPocketBase();

// Get git hash with fallback
const getGitHash = () => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'no-git-info';
  }
};

let commitJson = {
  hash: JSON.stringify(getGitHash()),
  version: JSON.stringify(process.env.npm_package_version),
};

console.log(`
★═══════════════════════════════════════★
          B O L T . D I Y
         ⚡️  Welcome  ⚡️
★═══════════════════════════════════════★
`);
console.log('📍 Current Version Tag:', `v${commitJson.version}`);
console.log('📍 Current Commit Version:', commitJson.hash);
console.log('  Please wait until the URL appears here');
console.log('★═══════════════════════════════════════★');
