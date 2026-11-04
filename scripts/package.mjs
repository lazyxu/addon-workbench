import { readdir, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const extensionsDir = join(root, 'extensions');
const distDir = join(root, 'dist');

function safePath(value) {
  return typeof value === 'string' && value.length > 0 &&
    !value.startsWith('/') && !value.includes('\\') &&
    value.split('/').every(segment => segment !== '..' && segment !== '.' && segment.length > 0);
}

async function collectFiles(folder, current = folder) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Refusing symlink in extension: ' + entry.name);
    if (entry.name.startsWith('.')) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(folder, path));
    else if (entry.isFile()) files.push(relative(folder, path).split(sep).join('/'));
  }
  return files;
}

function referencedPaths(manifest) {
  return [
    manifest.action?.default_popup,
    ...(typeof manifest.action?.default_icon === 'string' ? [manifest.action.default_icon] : Object.values(manifest.action?.default_icon || {})),
    ...Object.values(manifest.icons || {}),
    manifest.background?.service_worker,
    ...(manifest.content_scripts || []).flatMap(entry => [...(entry.js || []), ...(entry.css || [])])
  ].filter(Boolean);
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  const dirs = (await readdir(extensionsDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  if (!dirs.length) throw new Error('No extensions to package');
  const sha = (process.env.GITHUB_SHA || 'local').slice(0, 12);
  if (!/^(?:[a-f0-9]{12}|local)$/.test(sha)) throw new Error('Invalid commit SHA');
  for (const dir of dirs) {
    const extensionDir = join(extensionsDir, dir.name);
    const manifestPath = join(extensionDir, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error('Missing manifest.json: ' + dir.name);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.manifest_version !== 3) throw new Error(dir.name + ': expected Manifest V3');
    if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) throw new Error(dir.name + ': invalid version');
    const files = await collectFiles(extensionDir);
    for (const file of referencedPaths(manifest)) {
      if (!safePath(file) || !files.includes(file)) throw new Error(dir.name + ': missing or unsafe referenced file: ' + file);
    }
    const popup = manifest.action?.default_popup;
    if (popup) {
      const html = await readFile(join(extensionDir, popup), 'utf8');
      for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const target = match[1];
        if (target.startsWith('http') || target.startsWith('#')) continue;
        if (!safePath(target) || !files.includes(target)) throw new Error(dir.name + ': missing popup asset: ' + target);
      }
    }
    for (const filename of files.filter(x => x.endsWith('.js'))) {
      const js = await readFile(join(extensionDir, filename), 'utf8');
      for (const match of js.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
        const pathname = join(extensionDir, filename, '..', match[1]);
        const localPath = relative(extensionDir, pathname).split(sep).join('/');
        if (!safePath(localPath) || !files.includes(localPath)) throw new Error(dir.name + ': missing JS import: ' + localPath);
      }
    }
    const archive = dir.name + '-chrome-v' + manifest.version + '-' + sha + '.zip';
    const output = join(distDir, archive);
    execFileSync('zip', ['-q', '-X', output, ...files], { cwd: extensionDir });
    if (!(await stat(output)).size) throw new Error('Empty archive: ' + archive);
    console.log(archive + ': ' + files.length + ' files');
  }
}

await main();
