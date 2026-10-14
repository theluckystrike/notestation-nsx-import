import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseRecords, readArchive } from '../src/model';
import { MAX_ZIP, readZip } from '../src/archive';
import { buildPlan } from '../src/importer';

const source = (overrides: Record<string, unknown> = {}) => parseRecords({ note:['n1'], notebook:['b1'] }, { b1:{title:'Research'}, n1:{ title:'Plan', parent_id:'b1', content:'<p>Hello</p>', ...overrides } });
const box = (checked: boolean) => `<input class="syno-notestation-editor-checkbox${checked ? ' syno-notestation-editor-checkbox-checked' : ''}" type="image">`;

describe('review defects', () => {
 it('keeps dollar signs in task text', () => {
  const p = buildPlan(source({ content:`<div>${box(false)}Pay $$5 and $' fee</div>` }), 'Import');
  expect(p.notes[0]!.text).toContain("Pay $$5 and $' fee");
 });
 it('keeps the state of checkboxes that share one line block', () => {
  const p = buildPlan(source({ content:`<div>${box(true)}Pack notebook<br>${box(false)}Check maps</div>` }), 'Import');
  const text = p.notes[0]!.text;
  expect(text).toContain('☑ Pack notebook');
  expect(text).toContain('☐ Check maps');
  expect(text).not.toContain('- [ ]');
 });
 it('reports an encrypted note and does not show its cipher text as note text', () => {
  const p = buildPlan(source({ encrypt:true, content:'U2FsdGVkX19hYmNkZWZnaGlqa2xtbm9w' }), 'Import');
  expect(p.issues).toContain('n1: encrypted note. Decrypt it in Note Station and export again.');
  expect(p.notes[0]!.text).toContain('```\nU2FsdGVkX19hYmNkZWZnaGlqa2xtbm9w\n```');
 });
 it('keeps a local image link valid when the name has one parenthesis', () => {
  const a = source({ attachment:{ x:{ md5:'abc', ref:'image1', name:'map).png' } }, content:'<img ref="image1" src="placeholder">' });
  a.assets.set('file_abc', new Uint8Array([1]));
  const text = buildPlan(a, 'Import').notes[0]!.text;
  const link = /!\[[^\]]*\]\(([^)\s]*)\)/.exec(text);
  expect(link && decodeURI(link[1]!.replace(/%28/g,'(').replace(/%29/g,')'))).toBe('Import/Assets/file_abc-map).png');
 });
});

const central = (bytes: Uint8Array) => { const v = new DataView(bytes.buffer); for (let i = 0; i < bytes.length - 46; i++) if (v.getUint32(i, true) === 0x02014b50) return { v, i }; throw Error('no directory'); };
const eocd = (bytes: Uint8Array) => { const v = new DataView(bytes.buffer); return { v, i: bytes.length - 22 }; };
describe('README limit claims', () => {
 it('rejects an archive over 20 MiB', () => { expect(() => readZip(new Uint8Array(MAX_ZIP + 1))).toThrow('exceeds 20 MiB'); });
 it('rejects more than 5,000 members', () => { const b = zipSync({ 'config.json':strToU8('{}') }); const { v, i } = eocd(b); v.setUint16(i + 8, 5001, true); v.setUint16(i + 10, 5001, true); expect(() => readZip(b)).toThrow('oversized'); });
 it('rejects duplicate member names in a different case', () => { expect(() => readZip(zipSync({ 'config.json':strToU8('{}'), 'Config.json':strToU8('{}') }))).toThrow('duplicate'); });
 it('rejects encrypted, split and ZIP64 archives', () => {
  let b = zipSync({ 'config.json':strToU8('{}') }); let c = central(b); c.v.setUint16(c.i + 8, 1, true); expect(() => readZip(b)).toThrow('Encrypted');
  b = zipSync({ 'config.json':strToU8('{}') }); const e = eocd(b); e.v.setUint16(e.i + 4, 1, true); expect(() => readZip(b)).toThrow('Split');
  b = zipSync({ 'config.json':strToU8('{}') }); c = central(b); c.v.setUint32(c.i + 24, 0xffffffff, true); expect(() => readZip(b)).toThrow('ZIP64');
 });
 it('puts a note with an unknown notebook in Unfiled and reports it', () => {
  const p = buildPlan(source({ parent_id:'gone' }), 'Import');
  expect(p.notes[0]!.path).toBe('Import/Unfiled/Plan 1.md'); expect(p.issues).toContain('n1: notebook not found; saved in Unfiled.');
 });
 it('omits thumbnail members and lists an attachment without a reference', () => {
  const a = readArchive(zipSync({ 'config.json':strToU8(JSON.stringify({ note:['n1'], notebook:[] })), n1:strToU8(JSON.stringify({ title:'Plan', content:'<p>x</p>', attachment:{ k:{ md5:'abc', name:'sample.pdf' } } })), file_abc:new Uint8Array([1]), file_thumb_abc:new Uint8Array([2]) }));
  expect([...a.assets.keys()]).toEqual(['file_abc']);
  expect(buildPlan(a, 'Import').notes[0]!.text).toContain('## Attachments\n\n- [[Import/Assets/file_abc-sample.pdf|sample.pdf]]');
 });
});
