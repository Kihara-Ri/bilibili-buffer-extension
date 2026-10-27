import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync} from 'node:crypto';
import {createSignedUpdate} from '../scripts/lib/github-update-package.mjs';
import {verifyUpdateEnvelope} from '../src/github-update-protocol.js';
import {readFile} from 'node:fs/promises';
import {GITHUB_ORIGINS} from '../src/github-update-network.js';
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
test('直接加载源码目录也能申请更新域名，商店构建仍剔除这些权限',async()=>{
 const source=await readFile(new URL('../manifest.json',import.meta.url));
 const manifest=JSON.parse(source);
 assert.deepEqual(manifest.optional_host_permissions,[...GITHUB_ORIGINS]);
 const {prepareDistribution}=await import('../scripts/lib/distribution-build.mjs');
 const files=()=>new Map([['manifest.json',source]]);
 assert.equal(JSON.parse(prepareDistribution(files(),'store').get('manifest.json')).optional_host_permissions,undefined);
 assert.deepEqual(JSON.parse(prepareDistribution(files(),'github').get('manifest.json')).optional_host_permissions,[...GITHUB_ORIGINS]);
});
test('构建签名更新集合，浏览器协议可验证相同原始文件',async()=>{const manifest={manifest_version:3,version:'2.15.0',background:{service_worker:'src/background.js'}};const files=new Map([['manifest.json',Buffer.from(JSON.stringify(manifest))],['src/background.js',Buffer.from('export const initialized=true;')]]);const envelope=createSignedUpdate(files,pair.privateKey);const result=await verifyUpdateEnvelope(envelope,pair.publicKey.export({format:'jwk'}),{currentVersion:'2.14.5'});assert.equal(result.version,'2.15.0');assert.equal(new TextDecoder().decode(result.files.get('src/background.js')),'export const initialized=true;');});
test('发布集合不得混入私钥、开发入口和非法文件路径',()=>{for(const path of ['.env','private.pem','src/dev-reload.js','../manifest.json']){const files=new Map([['manifest.json',Buffer.from('{"version":"2.15.0"}')],[path,Buffer.from('secret')]]);assert.throws(()=>createSignedUpdate(files,pair.privateKey));}});

test('两个渠道构建隔离：商店只含链接，GitHub 才含更新器与可选权限',async()=>{
 const {prepareDistribution}=await import('../scripts/lib/distribution-build.mjs');
 const fixture=()=>new Map([['manifest.json',Buffer.from(JSON.stringify({version:'2.15.0',key:'identity',host_permissions:['http://127.0.0.1/*']}))],['src/update-runtime.js',Buffer.from('real updater')],['src/github-update-files.js',Buffer.from('engine')],['src/github-updater-page.js',Buffer.from('page')],['update.html',Buffer.from('ui')]]);
 const store=prepareDistribution(fixture(),'store');const manifest=JSON.parse(store.get('manifest.json'));
 assert.equal(manifest.key,undefined);assert.equal(manifest.optional_host_permissions,undefined);
 assert(!store.has('src/github-update-files.js'));assert(!store.has('update.html'));assert(!store.has('src/github-updater-page.js'));
 assert(!store.get('src/update-runtime.js').toString().includes('import'));
 const github=prepareDistribution(fixture(),'github');const gh=JSON.parse(github.get('manifest.json'));
 assert.equal(gh.key,'identity');assert(gh.optional_host_permissions.includes('https://api.github.com/*'));assert(github.has('update.html'));
 assert(github.get('src/distribution.js').toString().includes("'github'"));
});
