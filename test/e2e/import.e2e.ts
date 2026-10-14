import { browser, expect } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { pluginId } from './load';

function sample(content = '<h2>Field plan</h2><div><input class="syno-notestation-editor-checkbox syno-notestation-editor-checkbox-checked" type="image"><span>Pack notebook</span></div><div><input class="syno-notestation-editor-checkbox" type="image"><span>Check weather</span></div><p><img ref="image1" src="placeholder"></p>') {
 return zipSync({ 'config.json':strToU8(JSON.stringify({note:['n1'],notebook:['b1']})), b1:strToU8(JSON.stringify({title:'Research'})), n1:strToU8(JSON.stringify({title:'Field notes',parent_id:'b1',content,ctime:1700000000,mtime:1700000060,tag:['field work'],source_url:'https://example.com/source',attachment:{image:{md5:'abc',ref:'image1',name:'chart.png'}}})),file_abc:new Uint8Array([1,2,3]) });
}
async function closeModal() { await browser.keys('Escape');await browser.$('.nsx-import').waitForExist({reverse:true}); }
async function select(bytes: Uint8Array, folder: string) {
 await closeModal(); await browser.executeObsidianCommand(`${pluginId}:import-nsx`);
 await browser.$('.nsx-file').waitForExist();
 await browser.execute((values: number[])=>{
  const input=document.querySelector<HTMLInputElement>('.nsx-file')!;
  const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(values)],'backup.nsx'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 },Array.from(bytes));
 await browser.$('.nsx-counts').waitForExist();
 await browser.$('.nsx-import .setting-item input[type="text"]').setValue(folder);
}
async function run() { await browser.execute(()=>{const button=Array.from(document.querySelectorAll<HTMLButtonElement>('.nsx-import button')).find(b=>b.textContent==='Create new files');if(!button||button.disabled)throw Error('Import button is not ready');button.click();}); await browser.$('.nsx-report').waitForExist({timeout:15000}); }
async function fileText(path: string) { return browser.executeObsidian(async({app},path)=>{const file=app.vault.getFileByPath(path);if(!file)throw Error('Missing '+path);return app.vault.read(file);},path); }
describe('local NSX import',()=>{
 it('shows counts and converts a checklist with source dates and a local asset',async()=>{
  await select(sample(),'E2E import');expect(await browser.$('.nsx-counts').getText()).toBe('1 notes · 1 notebooks · 1 asset members');await run();
  const value=await fileText('E2E import/Research/Field notes 1.md');
  expect(value).toMatch(/(?:## Field plan|Field plan\n-+)/);expect(value).toContain('- [x] Pack notebook');expect(value).toContain('- [ ] Check weather');expect(value).toContain('notestation_ctime: 1700000000');expect(value).toContain('source_url: https://example.com/source');expect(value).toContain('E2E%20import/Assets/file_abc-chart.png');
  const result=await browser.executeObsidian(async({app})=>{const n=app.vault.getFileByPath('E2E import/Research/Field notes 1.md')!;const a=app.vault.getFileByPath('E2E import/Assets/file_abc-chart.png')!;return{ctime:n.stat.ctime,mtime:n.stat.mtime,bytes:Array.from(new Uint8Array(await app.vault.readBinary(a)))};});
  expect(result.bytes).toEqual([1,2,3]);expect(result.mtime).toBe(1700000060000);expect(result.ctime).toBeGreaterThan(0);
 });
 it('stops for an existing folder and keeps the note unchanged',async()=>{
  const before=await fileText('E2E import/Research/Field notes 1.md');await select(sample('<p>Changed</p>'),'E2E import');await browser.execute(()=>{const button=Array.from(document.querySelectorAll<HTMLButtonElement>('.nsx-import button')).find(b=>b.textContent==='Create new files');if(!button||button.disabled)throw Error('Import button is not ready');button.click();});await browser.$('.nsx-error').waitForExist();expect(await browser.$('.nsx-error').getText()).toContain('folder exists');expect(await fileText('E2E import/Research/Field notes 1.md')).toBe(before);
 });
 for(const [name,notes,books,assets] of [['notestation-test-books.nsx',4,2,3],['20251026_153652_10216_abalakov.nsx',1,1,1]] as const) {
  it(`imports ${name}`,async()=>{
   await select(readFileSync(`tests/fixtures/${name}`),`Fixture ${notes}`);expect(await browser.$('.nsx-counts').getText()).toBe(`${notes} notes · ${books} notebooks · ${assets} asset members`);await run();
   const result=await browser.executeObsidian(async({app},folder)=>{
    const files=app.vault.getFiles().filter(f=>f.path.startsWith(folder+'/'));
    const noteFiles=files.filter(f=>f.extension==='md'&&f.name!=='Import report.md');const texts=await Promise.all(noteFiles.map(f=>app.vault.read(f)));
    let brokenAssets=0;
    texts.forEach((text,i)=>{const targets=[...Array.from(text.matchAll(/\]\(([^)]*\/Assets\/[^)]*)\)/g),m=>m[1]!),...Array.from(text.matchAll(/\[\[([^|\]]*\/Assets\/[^|\]]*)/g),m=>m[1]!)];for(const target of targets)if(!app.metadataCache.getFirstLinkpathDest(decodeURI(target),noteFiles[i]!.path))brokenAssets++;});
    return{brokenAssets,notes:noteFiles.length,assets:files.filter(f=>f.path.startsWith(folder+'/Assets/')).length,missing:(await app.vault.read(app.vault.getFileByPath(folder+'/Import report.md')!)).includes('missing asset'),tasks:texts.some(t=>t.includes('- [x] item 1')),references:texts.filter(t=>t.includes('/Assets/')).length};
   },`Fixture ${notes}`);
   expect(result.notes).toBe(notes);expect(result.assets).toBe(assets);expect(result.missing).toBe(false);expect(result.brokenAssets).toBe(0);if(notes===1)expect(result.tasks).toBe(true);else expect(result.references).toBe(2);
  });
 }
 it('keeps unresolved source links and reports them',async()=>{
  await select(sample('<p><a href="notestation://remote/self/missing">Field notes</a></p><img ref="missing-image" src="placeholder">'),'E2E unresolved');await run();
  expect(await fileText('E2E unresolved/Research/Field notes 1.md')).toContain('notestation://remote/self/missing');const report=await fileText('E2E unresolved/Import report.md');expect(report).toContain('unresolved link');expect(report).toContain('unresolved reference missing');expect(await fileText('E2E unresolved/Research/Field notes 1.md')).toContain('(missing-image)');
 });
 it('guards profile saving and backup comparison while Pro is off',async()=>{
  await select(sample(),'E2E locked');await browser.$('input[placeholder="Profile name"]').setValue('Field profile');await browser.execute(()=>{const button=Array.from(document.querySelectorAll<HTMLButtonElement>('.nsx-import button')).find(b=>b.textContent==='Save profile');if(!button||button.disabled)throw Error('Profile button is not ready');button.click();});await browser.$('.nsx-error').waitForExist();expect(await browser.$('.nsx-error').getText()).toContain('need Pro');
  await browser.execute(()=>{const input=document.querySelector<HTMLInputElement>('.nsx-snapshot')!;const dt=new DataTransfer();dt.items.add(new File(['{}'],'Source snapshot.json'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await browser.waitUntil(async()=>await browser.execute(()=>Array.from(document.querySelectorAll('.nsx-error')).some(e=>e.textContent?.includes('comparison needs Pro'))));
 });
 it('saves a mapping profile and compares a later backup with a local Sponsor response',async()=>{
  await closeModal();await browser.executeObsidian(async({app},id)=>{
   type Pro={opts:{http:()=>Promise<unknown>};refreshNow:()=>Promise<unknown>};
   const p=(app as unknown as {plugins:{plugins:Record<string,{pro:Pro}>}}).plugins.plugins[id]!;
   p.pro.opts.http=async()=>({status:200,json:{data:{viewer:{login:'demo-reader'},user:{sponsorshipForViewerAsSponsor:{isActive:true,isOneTimePayment:false,tier:{name:'$5 a month',monthlyPriceInCents:500}}}}}});
   app.secretStorage.setSecret(id+'-github-token','gho_'+'0'.repeat(36));await p.pro.refreshNow();
  },pluginId);
  await select(sample('<p>Later record</p>'),'E2E review');
  const fields=await browser.$$('.nsx-import .setting-item input[type="text"]');await fields[1]!.setValue('Field research');
  await browser.$('input[placeholder="Profile name"]').setValue('Field profile');await browser.execute(()=>{const button=Array.from(document.querySelectorAll<HTMLButtonElement>('.nsx-import button')).find(b=>b.textContent==='Save profile');if(!button||button.disabled)throw Error('Profile button is not ready');button.click();});
  await browser.waitUntil(async()=>await browser.execute(()=>Boolean(document.querySelector('.nsx-import select option[value="Field profile"]'))));
  const changed=await browser.$$('.nsx-import .setting-item input[type="text"]');await changed[1]!.setValue('Temporary');
  await browser.execute(()=>{const select=document.querySelector<HTMLSelectElement>('.nsx-import select')!;select.value='Field profile';select.dispatchEvent(new Event('change',{bubbles:true}));});
  const loaded=await browser.$$('.nsx-import .setting-item input[type="text"]');expect(await loaded[1]!.getValue()).toBe('Field research');
  const before=await fileText('E2E import/Source snapshot.json');await browser.execute((text:string)=>{const input=document.querySelector<HTMLInputElement>('.nsx-snapshot')!;const dt=new DataTransfer();dt.items.add(new File([text],'Source snapshot.json'));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));},before);
  await browser.waitUntil(async()=>await browser.execute(()=>document.querySelector('.nsx-import')?.textContent?.includes('comparison is ready')??false));
  await browser.$('.nsx-import .setting-item input[type="text"]').setValue('E2E review');await run();
  const report=await fileText('E2E review/Import report.md');expect(report).toContain('changed: 1 (n1)');expect(await fileText('E2E review/Field research/Field notes 1.md')).toContain('Later record');expect(await fileText('E2E import/Research/Field notes 1.md')).toContain('Pack notebook');
  await browser.executeObsidian(({app},id)=>{(app as unknown as {plugins:{plugins:Record<string,{pro:{signOut:()=>void}}>}}).plugins.plugins[id]!.pro.signOut();},pluginId);
 });
});
