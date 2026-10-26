import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, createHash} from 'node:crypto';
import {compareVersions, verifyUpdateEnvelope, prepareUpdateFiles} from '../src/github-update-protocol.js';
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}), jwk=pair.publicKey.export({format:'jwk'});
const manifest={manifest_version:3,name:'test',version:'2.15.0',key:'new-key',permissions:['storage'],host_permissions:[],background:{service_worker:'src/background.js',type:'module'}};
function pack(change=()=>{}) {
 const files={'manifest.json':JSON.stringify(manifest),'src/background.js':'export const ready=true;','rules/cdn-headers.json':JSON.stringify([{id:1,condition:{initiatorDomains:['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']},action:{type:'modifyHeaders'}}])};
 const payload={schema:1,channel:'github',version:'2.15.0',dataCompatibility:'backward-compatible',identityPolicy:'preserve-install-identity-v1',files:Object.entries(files).map(([path,text])=>{const b=Buffer.from(text);return {path,size:b.length,sha256:createHash('sha256').update(b).digest('hex'),data:b.toString('base64')};})};change(payload);
 const bytes=Buffer.from(JSON.stringify(payload));return {payload:bytes.toString('base64'),signature:sign('sha256',bytes,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};
}
const current={...manifest,version:'2.14.5',key:'existing-key'}, id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
test('Chrome 版本按数字比较并拒绝越界',()=>{assert.equal(compareVersions('2.15.0','2.9.9'),1);assert.equal(compareVersions('2.15','2.15.0'),0);for(const bad of ['2.x','2.65536','-1.0','1.2.3.4.5'])assert.throws(()=>compareVersions(bad,'1'));});
test('签名校验后仅转换安装身份并读回可预期文件',async()=>{
 const verified=await verifyUpdateEnvelope(pack(),jwk,{currentVersion:'2.14.5'});
 const files=prepareUpdateFiles(verified,current,id);
 assert.equal(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))).key,'existing-key');
 assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('rules/cdn-headers.json')))[0].condition.initiatorDomains,['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',id]);
 const noKey={...current};delete noKey.key;assert.equal(Object.hasOwn(JSON.parse(new TextDecoder().decode(prepareUpdateFiles(verified,noKey,id).get('manifest.json'))),'key'),false);
});
test('拒绝签名篡改、错误公钥、损坏哈希和同版降级',async()=>{
 const bad=pack();bad.signature=Buffer.alloc(64).toString('base64');await assert.rejects(verifyUpdateEnvelope(bad,jwk,{currentVersion:'2.14.5'}));
 const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});await assert.rejects(verifyUpdateEnvelope(pack(),other,{currentVersion:'2.14.5'}));
 await assert.rejects(verifyUpdateEnvelope(pack(p=>p.files[0].sha256='0'.repeat(64)),jwk,{currentVersion:'2.14.5'}));
 await assert.rejects(verifyUpdateEnvelope(pack(),jwk,{currentVersion:'2.15.0'}));
});
test('拒绝路径穿越、重复文件、数据不兼容和清单版本错配',async()=>{
 for(const path of ['../manifest.json','/manifest.json','src\\evil.js','.git/config','src/a:bad.js','src/%2e%2e/x.js'])await assert.rejects(verifyUpdateEnvelope(pack(p=>p.files[1].path=path),jwk,{currentVersion:'2.14.5'}));
 for(const change of [p=>p.files.push(p.files[0]),p=>p.dataCompatibility='breaking',p=>p.version='2.16.0'])await assert.rejects(verifyUpdateEnvelope(pack(change),jwk,{currentVersion:'2.14.5'}));
});
test('拒绝静默增加权限和不匹配的后台入口',async()=>{
 const verified=await verifyUpdateEnvelope(pack(),jwk,{currentVersion:'2.14.5'});
 assert.throws(()=>prepareUpdateFiles(verified,{...current,permissions:[]},id));
 assert.throws(()=>prepareUpdateFiles(verified,current,'bad-id'));
 assert.throws(()=>prepareUpdateFiles(verified,{...current,background:{service_worker:'other.js'}},id));
});
test('允许范围内的大段 base64 不因正则回溯栈溢出而拒绝合法包',async()=>{
 const {decodeBase64}=await import('../src/github-update-protocol.js');
 const decoded=decodeBase64('A'.repeat(8*1024*1024));
 assert.equal(decoded.byteLength,6*1024*1024);assert.equal(decoded.at(-1),0);
 for(const invalid of ['A===','A=AA','AAA','====','AA=A'])assert.throws(()=>decodeBase64(invalid));
});
