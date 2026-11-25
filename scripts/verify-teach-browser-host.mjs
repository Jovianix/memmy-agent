import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Check the actual staged build, rather than relying on a Host version number.
export async function verifyTeachBrowserHost(root) {
  const capability = 'memmy.event-sessions/v1';
  const contracts = path.join(root, 'App/backend/local-api-contracts/dist/plugin.js');
  const native = path.join(root, 'App/memmy-agent/dist/tools/plugin-host/native-services.js');
  const sessions = path.join(root, 'App/memmy-agent/dist/tools/plugin-host/event-sessions.js');
  const extension = path.join(root, 'App/shell/desktop/extensions/memmy-browser');
  const manifestFile = path.join(extension, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const historySensor = path.join(extension, 'history-sensor.js');
  const advertised = fs.existsSync(contracts)
    ? (await import(pathToFileURL(contracts).href)).PLUGIN_HOST_CAPABILITIES : [];
  const checks = {
    sharedCapability: advertised.includes(capability) && !advertised.includes('memmy.browser-event-sessions/v1'),
    sharedCapture: fs.existsSync(sessions) && fs.readFileSync(sessions, 'utf8').includes('source.acquireEventCapture'),
    nativeService: fs.existsSync(native) && !fs.readFileSync(native, 'utf8').includes('createBrowserCaptureProvider'),
    historySensorPackaged: fs.existsSync(historySensor) && manifest?.content_scripts?.length === 1
      && manifest.content_scripts[0].js?.includes('history-sensor.js') === true,
  };
  const artifacts = [contracts, native, sessions, manifestFile, historySensor, path.join(extension, 'background.js')]
    .filter(file => fs.existsSync(file)).map(file => ({
      file: path.relative(root, file).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    }));
  return { root, capability, extensionVersion: manifest?.version ?? null, artifacts,
    checks, passed: Object.values(checks).every(Boolean) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, '..');
  const result = await verifyTeachBrowserHost(root);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
