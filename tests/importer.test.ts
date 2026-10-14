import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readArchive, parseRecords, compare, snapshot, rootFolder } from '../src/model';
import { MAX_EXPANDED, readZip } from '../src/archive';
import { buildPlan, writePlan, type ImportVault } from '../src/importer';
import { bindPro, resetPro, isPro, SPONSORS, PRO_UI } from '../src/pro';
import Plugin from '../src/main';
import { App } from 'obsidian-test-mocks/obsidian';
import manifest from '../manifest.json';

const source = (overrides: Record<string, unknown> = {}) => parseRecords({ note:['n1'], notebook:['b1'] }, { b1:{title:'Research'}, n1:{ title:'Plan', parent_id:'b1', ctime:1700000000, mtime:1700000060, content:'<p>Hello</p>', ...overrides } });
function fakeVault(exists = false) {
 const paths = new Set<string>();
 return { getRoot: () => ({ children: exists ? [{ name:'Import' }] : [] }), getAbstractFileByPath: (p: string) => paths.has(p) ? {} : null,
  createFolder: vi.fn(async (p: string) => { if(paths.has(p)) throw Error('Conflict'); paths.add(p); }),
  create: vi.fn(async (p: string) => { if(paths.has(p)) throw Error('Conflict'); paths.add(p); }),
  createBinary: vi.fn(async (p: string) => { if(paths.has(p)) throw Error('Conflict'); paths.add(p); }), paths,
 };
}
afterEach(() => { resetPro(); vi.unstubAllGlobals(); });
describe('real exported fixtures', () => {
 it.each([['notestation-test-books.nsx',4,2,3],['20251026_153652_10216_abalakov.nsx',1,1,1]] as const)('%s', (file, notes, books, assets) => {
  const a = readArchive(readFileSync(`tests/fixtures/${file}`));
  expect(a.notes).toHaveLength(notes); expect(a.notebooks).toHaveLength(books); expect(a.assets.size).toBe(assets);
  const p = buildPlan(a,'Import'); expect(p.notes).toHaveLength(notes); expect(p.assets).toHaveLength(assets);
  expect(p.issues.filter(i => i.includes('missing asset'))).toEqual([]);
  for(const n of p.notes) {
   const doc = new DOMParser().parseFromString(n.text,'text/html');
   for(const img of doc.querySelectorAll('img')) expect(p.assets.map(a => a.path)).toContain(decodeURI(img.getAttribute('src')!));
  }
 });
});
describe('archive limits before expansion', () => {
 it.each(['../outside.txt','/outside.txt','a\\b','C:outside','a/../b'])('rejects %s', path => { expect(() => readZip(zipSync({ [path]:strToU8('x'), 'config.json':strToU8('{}') }))).toThrow('unsafe path'); });
 it('rejects an oversized declared member before expansion', () => {
  const bytes = zipSync({ 'config.json':strToU8('{}') }); const view = new DataView(bytes.buffer);
  for(let i=0;i<bytes.length-46;i++) if(view.getUint32(i,true)===0x02014b50) { view.setUint32(i+24,MAX_EXPANDED+1,true); break; }
  expect(() => readZip(bytes)).toThrow('exceeds 100 MiB');
 });
 it('rejects broken CRC data', () => {
  const bytes = zipSync({ 'config.json':strToU8('{}') }); const view = new DataView(bytes.buffer);
  for(let i=0;i<bytes.length-46;i++) if(view.getUint32(i,true)===0x02014b50) { view.setUint32(i+16,42,true); break; }
  expect(() => readZip(bytes)).toThrow('checksum');
 });
 it('requires config.json and its records', () => {
  expect(() => readArchive(zipSync({ other:strToU8('x') }))).toThrow('no config.json');
  expect(() => readArchive(zipSync({ 'config.json':strToU8('{"note":["n"],"notebook":[]}') }))).toThrow('Missing record');
 });
});
describe('new file writes', () => {
 it('uses source IDs that match object member names',()=>{const a=source({parent_id:'constructor'});a.notebooks[0]!.id='constructor';expect(buildPlan(a,'Import').notes[0]!.path).toBe('Import/Research/Plan 1.md');});
 it('supplies milliseconds and keeps original seconds in properties', async () => {
  const p = buildPlan(source(),'Import'); const v=fakeVault(); await writePlan(v as unknown as ImportVault,p);
  expect(v.create).toHaveBeenCalledWith('Import/Research/Plan 1.md',expect.stringContaining('notestation_ctime: 1700000000'),{ctime:1700000000000,mtime:1700000060000});
 });
 it('stops before writes when a root folder exists with a different case', async () => {
  const v=fakeVault(true); await expect(writePlan(v as unknown as ImportVault,buildPlan(source(),'import'))).rejects.toThrow('folder exists');
  expect(v.createFolder).not.toHaveBeenCalled(); expect(v.create).not.toHaveBeenCalled(); expect(v.createBinary).not.toHaveBeenCalled();
 });
 it('imports through Vault with network methods disabled', async () => {
  vi.stubGlobal('fetch',vi.fn(() => { throw Error('Network disabled'); }));
  const v=fakeVault(); await writePlan(v as unknown as ImportVault,buildPlan(source(),'Import')); expect(v.create).toHaveBeenCalledTimes(3); expect(fetch).not.toHaveBeenCalled();
 });
 it('does not create an empty file for a missing asset', async () => {
  const a=source({attachment:{x:{md5:'abc',ref:'image1',name:'chart.png'}},content:'<img ref="image1" src="placeholder">'});
  const p=buildPlan(a,'Import'); const v=fakeVault(); await writePlan(v as unknown as ImportVault,p);
  expect(v.createBinary).not.toHaveBeenCalled(); expect(p.notes[0]!.text).toContain('image1'); expect(p.issues).toContain('n1: missing asset file_abc (image1).');
 });
 it('maps the exported md5 and creates real binary data', async () => {
  const a=source({attachment:{x:{md5:'abc',ref:'image1',name:'chart.png'}},content:'<img ref="image1" src="placeholder">'}); a.assets.set('file_abc',new Uint8Array([1,2,3]));
  const p=buildPlan(a,'Import'); const v=fakeVault(); await writePlan(v as unknown as ImportVault,p);
  expect(p.notes[0]!.text).toContain('Import/Assets/file_abc-chart.png'); expect(v.createBinary).toHaveBeenCalledWith('Import/Assets/file_abc-chart.png',new Uint8Array([1,2,3]).buffer);
 });
 it('creates an empty notebook folder',async()=>{ const a=source();a.notebooks.push({id:'empty',title:'Empty'}); const v=fakeVault();await writePlan(v as unknown as ImportVault,buildPlan(a,'Import'));expect(v.createFolder).toHaveBeenCalledWith('Import/Empty'); });
 it('reports partial files after a write failure',async()=>{ const v=fakeVault();v.create.mockRejectedValueOnce(Error('Disk full'));await expect(writePlan(v as unknown as ImportVault,buildPlan(source(),'Import'))).rejects.toThrow('Partial files remain'); });
 it.each(['../Outside','a/b','a\\b','.','..',''])('rejects output %s',name=>expect(()=>rootFolder(name)).toThrow());
});
describe('HTML conversion', () => {
 it('keeps resource-like words in note text and image labels',()=>{const p=buildPlan(source({content:'<p>src=sample and data=1</p><img src="https://example.com/image.png" alt="Use src=sample">'}),'Import');expect(p.notes[0]!.text).toContain('src=sample and data=1');expect(p.notes[0]!.text).toContain('[Use src=sample](https://example.com/image.png)');});
 it('converts simple checked and unchecked items',()=>{const p=buildPlan(source({content:'<div><input class="syno-notestation-editor-checkbox syno-notestation-editor-checkbox-checked" type="image">Pack notebook</div><div><input class="syno-notestation-editor-checkbox" type="image">Check maps</div>'}),'Import');expect(p.notes[0]!.text).toContain('- [x] Pack notebook');expect(p.notes[0]!.text).toContain('- [ ] Check maps');});
 it('keeps remote images as links and removes script content',()=>{const p=buildPlan(source({content:'<img src="https://example.com/image.png" alt="Source image"><script>bad()</script>'}),'Import');expect(p.notes[0]!.text).toContain('[Source image](https://example.com/image.png)');expect(p.notes[0]!.text).not.toContain('![Source image]');expect(p.notes[0]!.text).not.toContain('bad()');});
 it('removes unsafe source links and reports them',()=>{const p=buildPlan(source({content:'<a href="javascript:bad()">Unsafe</a>'}),'Import');expect(p.notes[0]!.text).not.toContain('javascript:');expect(p.issues).toContain('n1: unsafe link removed.');});
});
describe('source ID and Pro', () => {
 it('keeps an unresolved link even when its title matches',()=>{const a=source({content:'<a href="notestation://remote/self/other">Plan</a>'});const p=buildPlan(a,'Import');expect(p.notes[0]!.text).toContain('notestation://remote/self/other');expect(p.issues).toContain('n1: unresolved link notestation://remote/self/other.');});
 it('uses an exact source ID',()=>{const a=source({content:'<a href="notestation://remote/self/n1">Plan</a>'});expect(buildPlan(a,'Import').notes[0]!.text).toContain('Import/Research/Plan%201.md');});
 it('checks differences by ID and sends changed notes to a new plan',()=>{const a=source();const before=snapshot(a);a.notes[0]!.title='Changed';a.notes.push({...a.notes[0]!,id:'n2'});before.removed='x';expect(compare(before,a)).toEqual({added:['n2'],changed:['n1'],removed:['removed'],unchanged:[]});expect(buildPlan(a,'Review',{},before).notes).toHaveLength(2);});
 it('Pro is off without a manager',()=>expect(isPro()).toBe(false));
 it('uses reference Sponsor terms',()=>{expect(SPONSORS).toMatchObject({clientId:'Ov23lic5UPGPZqhBlBGg',sponsorLogin:'theluckystrike',minMonthlyUsd:5,oneTimeUsd:15,oneTimeMonths:0,scope:'read:user'});expect(PRO_UI.priceText).toContain('$15 once');});
 it('blocks profile storage without Pro and saves with Pro',async()=>{
  const app=App.createConfigured__({files:{}});const p=new Plugin(app as never,manifest as never);
  await expect(p.saveProfile('Work',source(),{})).rejects.toThrow('need Pro');expect(p.settings.profiles).toEqual({});
  bindPro({isPro:()=>true,onChange:()=>()=>{}} as never);await p.saveProfile('Work',source(),{});expect(p.settings.profiles.Work).toEqual({b1:'Research'});
 });
});
