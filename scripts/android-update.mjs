import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node scripts/android-update.mjs <preview|production> "Update message"';

export function updateOptions(args) {
  if (args.length !== 2 || !['preview', 'production'].includes(args[0]) || !args[1].trim() || args[1].includes('\0')) {
    throw new Error(usage);
  }
  return { channel: args[0], message: args[1] };
}

export function updateEnvironment(privateEnv, inherited = process.env) {
  const token = privateEnv.EXPO_TOKEN || inherited.EXPO_TOKEN;
  if (!token) throw new Error('Add EXPO_TOKEN to the ignored root .env or your terminal environment.');
  const environment = { ...inherited };
  for (const name of Object.keys(privateEnv)) delete environment[name];
  // Expo must not load unrelated local .env files while exporting public app code.
  return { ...environment, EXPO_TOKEN: token, EXPO_NO_DOTENV: '1' };
}

export function npxScript(environment = process.env, nodeExecutable = process.execPath, exists = existsSync) {
  const nodeFolder = dirname(nodeExecutable);
  const npmExecutable = environment.npm_execpath;
  const path = environment.PATH || environment.Path || '';
  const candidates = [
    ...(npmExecutable ? [resolve(dirname(npmExecutable), 'npx-cli.js')] : []),
    resolve(nodeFolder, 'node_modules/npm/bin/npx-cli.js'),
    resolve(nodeFolder, '../lib/node_modules/npm/bin/npx-cli.js'),
    ...path.split(delimiter).filter(Boolean).map(folder => resolve(folder, 'node_modules/npm/bin/npx-cli.js')),
  ];
  const script = candidates.find(exists);
  if (!script) throw new Error('Could not find npm. Install Node.js with npm or open a terminal where npm is available.');
  return script;
}

function runCommand(command, args, options) {
  return new Promise((complete, fail) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: 'inherit', windowsHide: true });
    child.once('error', () => fail(new Error('The update command could not start. Check your Node.js and npm installation.')));
    child.once('exit', code => code === 0 ? complete() : fail(new Error(`The update command exited with code ${code ?? 'unknown'}.`)));
  });
}

async function checkFirebaseConfiguration(mobile, environment) {
  const file = resolve(mobile, environment.GOOGLE_SERVICES_JSON || '.credentials/google-services.json');
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    if (!config.client?.some(client => client.client_info?.android_client_info?.package_name === 'com.morsenepal')) {
      throw new Error('Wrong Android application.');
    }
  } catch {
    throw new Error('Restore the Firebase Android configuration for com.morsenepal at mobile/.credentials/google-services.json, or set GOOGLE_SERVICES_JSON in your terminal to its readable file path. Use the same configuration as the installed build so its OTA runtime matches.');
  }
}

export async function publishAndroidUpdate(args, {
  rootDirectory = root,
  inheritedEnvironment = process.env,
  run = runCommand,
  findNpx = npxScript,
} = {}) {
  const { channel, message } = updateOptions(args);
  let privateEnv = {};
  try { privateEnv = parseEnv(await readFile(resolve(rootDirectory, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const environment = updateEnvironment(privateEnv, inheritedEnvironment);
  const mobile = resolve(rootDirectory, 'mobile');
  await checkFirebaseConfiguration(mobile, environment);
  const runner = findNpx(environment);
  const preparationEnvironment = { ...environment };
  delete preparationEnvironment.EXPO_TOKEN;
  // Regenerate the offline WebView document before EAS exports its JS and assets.
  await run(process.execPath, [resolve(mobile, 'scripts/prepare-trainer.mjs')], {
    cwd: mobile, env: preparationEnvironment,
  });
  await run(process.execPath, [runner, '--yes', 'eas-cli@24.12.1', 'update',
    '--platform', 'android', '--channel', channel, '--environment', channel,
    '--message', message, '--non-interactive'], { cwd: mobile, env: environment });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) console.log(usage);
  else publishAndroidUpdate(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
