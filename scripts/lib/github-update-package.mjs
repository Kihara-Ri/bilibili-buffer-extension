import { createHash, sign } from 'node:crypto';
import { validateUpdatePath, UPDATE_LIMITS } from '../../src/github-update-protocol.js';

/** @param {Map<string,Buffer>} files @param {import('node:crypto').KeyLike} privateKey @returns {{payload:string,signature:string}} */
export function createSignedUpdate(files, privateKey) {
  const manifest = JSON.parse(files.get('manifest.json')?.toString('utf8') || '{}');
  let total = 0;
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => {
    validateUpdatePath(path);
    total += data.length;
    if (data.length > UPDATE_LIMITS.file || total > UPDATE_LIMITS.total) throw new Error('Update package exceeds limits');
    return { path, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') };
  });
  if (!manifest.version || entries.length > UPDATE_LIMITS.count) throw new Error('Invalid update package');
  const payload = Buffer.from(JSON.stringify({ schema: 1, channel: 'github', version: manifest.version, dataCompatibility: 'backward-compatible', identityPolicy: 'preserve-install-identity-v1', files: entries }));
  return { payload: payload.toString('base64'), signature: sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') };
}
