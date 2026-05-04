#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARBALLS = path.join(ROOT, '.tarballs');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PACKAGE_LOCK = path.join(ROOT, 'package-lock.json');
const BACKUP_PKG = path.join(ROOT, 'package.json.deploy-bak');
const BACKUP_LOCK = path.join(ROOT, 'package-lock.json.deploy-bak');

const PACKAGES = [
  { dir: '../packages/agora-contracts', name: '@agora/contracts', build: true },
  { dir: '../ST', name: '@stevenvo780/st-lang', build: false },
  { dir: '../Autologic', name: '@stevenvo780/autologic', build: false }
];

const restore = () => {
  if (existsSync(BACKUP_PKG)) {
    copyFileSync(BACKUP_PKG, PACKAGE_JSON);
    rmSync(BACKUP_PKG);
  }
  if (existsSync(BACKUP_LOCK)) {
    copyFileSync(BACKUP_LOCK, PACKAGE_LOCK);
    rmSync(BACKUP_LOCK);
  }
  if (existsSync(TARBALLS)) rmSync(TARBALLS, { recursive: true, force: true });
  console.log('[prepare-deploy] Restored package.json + lockfile and cleaned .tarballs/');
};

if (process.argv[2] === 'restore') {
  restore();
  process.exit(0);
}

if (existsSync(BACKUP_PKG)) {
  console.error('[prepare-deploy] package.json.deploy-bak ya existe — corre primero `node scripts/prepare-deploy.mjs restore`');
  process.exit(1);
}

mkdirSync(TARBALLS, { recursive: true });
copyFileSync(PACKAGE_JSON, BACKUP_PKG);
if (existsSync(PACKAGE_LOCK)) copyFileSync(PACKAGE_LOCK, BACKUP_LOCK);

const tgzMap = {};
for (const pkg of PACKAGES) {
  const absDir = path.resolve(ROOT, pkg.dir);
  if (pkg.build) {
    console.log(`[prepare-deploy] build ${pkg.name}`);
    execSync('npm run build', { cwd: absDir, stdio: 'inherit' });
  }
  console.log(`[prepare-deploy] npm pack ${pkg.name}`);
  execSync(`npm pack --pack-destination="${TARBALLS}" --silent`, { cwd: absDir, stdio: 'inherit' });
}

const tarballFiles = readdirSync(TARBALLS).filter(f => f.endsWith('.tgz'));
for (const pkg of PACKAGES) {
  const slug = pkg.name.replace('@', '').replace('/', '-');
  const match = tarballFiles.find(f => f.startsWith(slug));
  if (!match) {
    console.error(`[prepare-deploy] No tarball found for ${pkg.name} (slug=${slug})`);
    restore();
    process.exit(1);
  }
  tgzMap[pkg.name] = `file:./.tarballs/${match}`;
}

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
for (const section of ['dependencies', 'devDependencies']) {
  if (!pkg[section]) continue;
  for (const [key, val] of Object.entries(pkg[section])) {
    if (tgzMap[key]) {
      console.log(`  ${key}: ${val} → ${tgzMap[key]}`);
      pkg[section][key] = tgzMap[key];
    }
  }
}
writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + '\n');

if (existsSync(PACKAGE_LOCK)) rmSync(PACKAGE_LOCK);

console.log('[prepare-deploy] Listo. Ejecuta gcloud run deploy y luego `node scripts/prepare-deploy.mjs restore`.');
