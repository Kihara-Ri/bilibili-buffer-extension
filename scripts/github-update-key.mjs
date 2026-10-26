import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const privatePath = process.argv[2];
if (!privatePath) throw new Error('Usage: node scripts/github-update-key.mjs /private/path/update-signing-key.pem');
const root = fileURLToPath(new URL('../', import.meta.url));
const trustPath = path.join(root, 'update-public-key.json');
const existing = JSON.parse(await readFile(trustPath, 'utf8'));
if (existing.publicKey) throw new Error('A public key is already pinned. Key rotation requires a separate migration.');
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
await mkdir(path.dirname(path.resolve(privatePath)), { recursive: true, mode: 0o700 });
// wx 防止覆盖旧私钥；私钥不写进扩展、仓库或控制台。
await writeFile(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
await writeFile(trustPath, JSON.stringify({ schema: 1, publicKey: keys.publicKey.export({ format: 'jwk' }) }, null, 2) + '\n');
console.log('Public signing key pinned. Keep the private key outside the repository and back it up.');
