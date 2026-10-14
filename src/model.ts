import { strFromU8 } from 'fflate';
import { readZip } from './archive';

export interface Attachment { md5: string; name: string; ref: string }
export interface Note { id: string; title: string; parent: string; html: string; ctime?: number; mtime?: number; tags: string[]; url: string; attachments: Attachment[]; encrypted?: true }
export interface Notebook { id: string; title: string }
export interface Archive { notes: Note[]; notebooks: Notebook[]; assets: Map<string, Uint8Array> }
export function record(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
 return value as Record<string, unknown>;
}
export function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function ids(value: unknown): string[] {
 if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v || v.includes('/') || v.includes('\\') || v === '..')) throw new Error('Invalid record IDs in config.json.');
 const list = value as string[];
 if (new Set(list).size !== list.length) throw new Error('Duplicate source ID in config.json.');
 return list;
}
export function seconds(value: unknown): number | undefined {
 return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 8640000000000 ? value : undefined;
}
export function parseRecords(config: unknown, entries: Record<string, unknown>, assets = new Map<string, Uint8Array>()): Archive {
 const c = record(config);
 const notebooks = ids(c.notebook ?? []).map(id => ({ id, title: text(record(entries[id]).title) || 'Untitled notebook' }));
 const notes = ids(c.note).map(id => {
  const n = record(entries[id]);
  return { id, title: text(n.title) || 'Untitled note', parent: text(n.parent_id), html: text(n.content), ctime: seconds(n.ctime), mtime: seconds(n.mtime), tags: Array.isArray(n.tag) ? n.tag.filter((t): t is string => typeof t === 'string') : [], url: text(n.source_url), ...(n.encrypt === true ? { encrypted: true as const } : {}), attachments: Object.values(n.attachment ? record(n.attachment) : {}).map(a => {
   const r = record(a); const md5 = text(r.md5);
   if (!/^[a-zA-Z0-9]+$/.test(md5)) throw new Error('Invalid attachment hash.');
   return { md5, ref: text(r.ref), name: text(r.name) || `file_${md5}` };
  }) };
 });
 return { notes, notebooks, assets };
}
export function readArchive(bytes: Uint8Array): Archive {
 const meta = readZip(bytes, new Set(['config.json']));
 if (!meta['config.json']) throw new Error('The archive has no config.json.');
 const config: unknown = JSON.parse(strFromU8(meta['config.json']));
 const c = record(config);
 const files = readZip(bytes, new Set([...ids(c.note), ...ids(c.notebook ?? [])]), true);
 const entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
 for (const id of [...ids(c.note), ...ids(c.notebook ?? [])]) {
  if (!files[id]) throw new Error(`Missing record: ${id}`);
  entries[id] = JSON.parse(strFromU8(files[id])) as unknown;
 }
 const assets = new Map(Object.entries(files).filter(([name]) => /^file_[a-zA-Z0-9]+$/.test(name)));
 return parseRecords(config, entries, assets);
}
export function safeName(name: string): string {
 return Array.from(name.normalize('NFC')).map(c => c.charCodeAt(0) < 32 ? '-' : c).join('').replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 100) || 'Untitled';
}
export function rootFolder(name: string): string {
 if (!name.trim() || name !== name.trim() || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || safeName(name) !== name) throw new Error('Use one safe folder name without a path.');
 return name;
}
export interface Snapshot { [id: string]: string }
export function snapshot(archive: Archive): Snapshot {
 return Object.fromEntries(archive.notes.map(n => [n.id, JSON.stringify(n)]));
}
export function compare(before: Snapshot, archive: Archive): { added: string[]; changed: string[]; removed: string[]; unchanged: string[] } {
 const current = snapshot(archive); const out = { added: [] as string[], changed: [] as string[], removed: [] as string[], unchanged: [] as string[] };
 for (const id of Object.keys(current)) {
  if (!Object.prototype.hasOwnProperty.call(before, id)) out.added.push(id);
  else if (before[id] !== current[id]) out.changed.push(id);
  else out.unchanged.push(id);
 }
 out.removed = Object.keys(before).filter(id => !Object.prototype.hasOwnProperty.call(current, id));
 return out;
}
export function inspectRecords(config: unknown, entries: Record<string, unknown>): unknown {
 try { const a = parseRecords(config, entries); return { notes: a.notes.length, notebooks: a.notebooks.length, ids: a.notes.map(n => n.id), times: a.notes.map(n => ({ ctime: n.ctime, mtime: n.mtime })), tags: a.notes.map(n => n.tags) }; }
 catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
