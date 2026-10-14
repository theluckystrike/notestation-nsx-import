import data from './vectors/notestation-nsx-import.json';
import { Platform } from 'obsidian';
import { readFileSync } from 'node:fs';
import { it, expect, describe, vi } from 'vitest';
import { readArchive, parseRecords, safeName, rootFolder, inspectRecords, compare, snapshot } from '../src/model';
import { readZip } from '../src/archive';
import { buildPlan, writePlan, type ImportVault } from '../src/importer';

const functions: Record<string, (...args: never[]) => unknown> = {
 inspectRecords,
 safeName,
 rootFolder: ((name: string) => { try { return rootFolder(name); } catch(e) { return { error: (e as Error).message }; } }) as never,
 fixture: ((name: string) => { const a=readArchive(readFileSync(`tests/fixtures/${name}`));const p=buildPlan(a,'Import');return {notes:a.notes.length,notebooks:a.notebooks.length,assets:p.assets.length,missing:p.issues.filter(i=>i.includes('missing asset')).length,linkedAssets:p.assets.filter(a=>p.notes.some(n=>n.text.includes(a.path)||n.text.includes(encodeURI(a.path)))).length}; }) as never,
 zipError: ((base64: string) => { try { readZip(Uint8Array.from(atob(base64),c=>c.charCodeAt(0)));return 'accepted'; } catch(e) { return {error:(e as Error).message}; } }) as never,
 importCase: (async (config: unknown, entries: Record<string,unknown>, assetNames: string[], folder: string, existing: boolean, offline: boolean) => {
  const a=parseRecords(config,entries,new Map(assetNames.map(n=>[n,new Uint8Array([1,2,3])])));const p=buildPlan(a,folder);
  const fetch=vi.fn(()=>{throw Error('Network disabled');});const wasMobile=Platform.isMobile;if(offline){vi.stubGlobal('fetch',fetch);Platform.isMobile=true;expect(Platform.isMobile).toBe(true);}
  let creates=0; const v={getRoot:()=>({children:existing?[{name:folder}]:[]}),getAbstractFileByPath:()=>null,createFolder:async()=>{},create:async()=>{creates++;},createBinary:async()=>{creates++;}};
  try { await writePlan(v as unknown as ImportVault,p); return {notes:p.notes.length,assets:p.assets.length,times:p.notes.map(n=>n.times),issues:p.issues,creates,networkCalls:fetch.mock.calls.length}; }
  catch(e) {return {error:(e as Error).message,creates};} finally {Platform.isMobile=wasMobile;vi.unstubAllGlobals();}
 }) as never,
 comparison: ((before:Record<string,unknown>,after:Record<string,unknown>)=>compare(snapshot(parseRecords({note:Object.keys(before),notebook:[]},before)),parseRecords({note:Object.keys(after),notebook:[]},after))) as never,
};
describe('golden vectors',()=>{
 it('has at least 20 cases',()=>expect(data.cases.length).toBeGreaterThanOrEqual(20));
 for(const c of data.cases as {name:string;function:string;args:unknown[];expected:unknown}[])it(c.name,async()=>{
  const value=await functions[c.function]!(...c.args as never[]); expect(JSON.parse(JSON.stringify(value))).toEqual(c.expected);
 });
});
