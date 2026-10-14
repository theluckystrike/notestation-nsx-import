import { htmlToMarkdown, normalizePath, stringifyYaml, type DataWriteOptions, type Vault } from 'obsidian';
import { compare, rootFolder, safeName, snapshot, type Archive, type Snapshot } from './model';

/** Encode a vault path for a Markdown link. Parentheses and # are encoded so that the link destination stays valid. */
function linkPath(path: string): string { return encodeURI(path).replace(/[#()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
function markdownText(value: string): string { return value.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()<>#+.!|~-]/g, '\\$&'); }

/** Disable resource attributes in tags before the detached HTML parser runs. Keep text and quoted attribute values intact. */
function inertMarkup(html: string): string {
 const resources = new Set(['src', 'srcset', 'srcdoc', 'href', 'xlink:href', 'poster', 'data', 'background']);
 return html.replace(/<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => tag.replace(/\s([^\s=/>]+)(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/g, (attribute: string, name: string) => resources.has(name.toLowerCase()) ? attribute.replace(name, `data-nsx-${name}`) : attribute));
}

export interface PlannedNote { path: string; text: string; times: DataWriteOptions }
export interface Plan { folder: string; folders: string[]; notes: PlannedNote[]; assets: { path: string; bytes: Uint8Array }[]; issues: string[]; snapshot: Snapshot; report: string }
export function buildPlan(archive: Archive, folder: string, mapping: Record<string, string> = {}, before?: Snapshot): Plan {
 rootFolder(folder);
 const issues: string[] = [];
 const used = new Set(['assets', 'import report.md', 'source snapshot.json']);
 const unique = (name: string) => {
  const clean = safeName(name); let candidate = clean; let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${clean} ${i++}`;
  used.add(candidate.toLowerCase()); return candidate;
 };
 const books = new Map(archive.notebooks.map(b => [b.id, unique(Object.prototype.hasOwnProperty.call(mapping, b.id) ? (mapping[b.id] ?? b.title) : b.title)]));
 const orphan = unique('Unfiled');
 const notePaths = new Map(archive.notes.map((n, i) => [n.id, normalizePath(`${folder}/${books.get(n.parent) ?? orphan}/${safeName(n.title)} ${i + 1}.md`)]));
 const assetPaths = new Map<string, string>();
 const assets: Plan['assets'] = [];
 for (const [member, bytes] of archive.assets) {
  const hash = member.slice(5);
  const attachment = archive.notes.flatMap(n => n.attachments).find(a => a.md5 === hash);
  const path = normalizePath(`${folder}/Assets/${safeName(member)}-${safeName(attachment?.name ?? 'attachment')}`);
  assetPaths.set(hash, path); assets.push({ path, bytes });
  if (!attachment) issues.push(`Unlisted asset kept: ${member}`);
 }
 const changes = before ? compare(before, archive) : undefined;
 const selected = changes ? new Set([...changes.added, ...changes.changed]) : null;
 const notes: PlannedNote[] = [];
 for (const n of archive.notes) {
  if (selected && !selected.has(n.id)) continue;
  if (!books.has(n.parent)) issues.push(`${n.id}: notebook not found; saved in ${orphan}.`);
  // Parse in a detached document. Source HTML is not inserted into the app.
  const inertHtml = inertMarkup(n.html);
  const doc = new DOMParser().parseFromString(inertHtml, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,audio,video,source').forEach(el => el.remove());
  const refs = new Map<string, string>();
  const extra: string[] = [];
  for (const a of n.attachments) {
   const path = assetPaths.get(a.md5);
   if (!path) { issues.push(`${n.id}: missing asset file_${a.md5} (${a.ref || a.name}).`); continue; }
   if (a.ref) {
    if (refs.has(a.ref) && refs.get(a.ref) !== path) { refs.delete(a.ref); issues.push(`${n.id}: ambiguous attachment reference ${a.ref}.`); }
    else refs.set(a.ref, path);
   } else extra.push(`- [[${path}|${a.name.replace(/[\r\n\]|]/g, ' ')}]]`);
  }
  for (const el of Array.from(doc.querySelectorAll('img,a'))) {
   const attr = el.tagName === 'IMG' ? 'src' : 'href';
   const ref = el.getAttribute('ref') || el.getAttribute(`data-nsx-${attr}`) || el.getAttribute(attr) || '';
   const local = refs.get(ref);
   if (/^\s*(?:javascript|data|vbscript):/i.test(ref)) { el.removeAttribute(attr); el.replaceWith(doc.createTextNode(el.textContent || 'Unsafe source link removed')); issues.push(`${n.id}: unsafe link removed.`); continue; }
   if (local) el.setAttribute(attr, linkPath(local));
   else if (ref.startsWith('notestation://')) {
    const id = ref.split('/').pop() ?? ''; const target = notePaths.get(id);
    if (target && (!selected || selected.has(id))) el.setAttribute(attr, linkPath(target));
    else { el.setAttribute(attr, ref); issues.push(`${n.id}: unresolved link ${ref}.`); }
   } else {
    el.setAttribute(attr, ref);
    if (ref && !/^(https?:|mailto:|#)/i.test(ref)) issues.push(`${n.id}: unresolved reference ${ref}.`);
   }
   // External and missing images remain links, so opening an imported note does not fetch them.
   if (el.tagName === 'IMG' && !local) {
    const a = doc.adoptNode(createEl('a')); a.setAttribute('href', ref); a.textContent = el.getAttribute('alt') || ref || 'Missing image'; el.replaceWith(a);
   }
  }
  const tasks: string[] = [];
  let taskPrefix = 'NSXTASKBOUNDARY'; while (n.html.includes(taskPrefix)) taskPrefix += 'X';
  const boxes = Array.from(doc.querySelectorAll('input.syno-notestation-editor-checkbox,input[type="checkbox"]'));
  const shared = new Map<Element, number>();
  for (const input of boxes) { const parent = input.closest('li,div'); if (parent) shared.set(parent, (shared.get(parent) ?? 0) + 1); }
  for (const input of boxes) {
   const parent = input.closest('li,div');
   const checked = input.classList.contains('syno-notestation-editor-checkbox-checked') || input.hasAttribute('checked');
   // A checkbox that shares its block with other inputs keeps its state as a text mark.
   if (!parent || shared.get(parent) !== 1 || parent.querySelectorAll('input').length !== 1) { input.replaceWith(doc.createTextNode(checked ? '☑ ' : '☐ ')); continue; }
   input.remove();
   const value = htmlToMarkdown(parent.innerHTML).trim();
   const pre = doc.adoptNode(createEl('p')); pre.textContent = `${taskPrefix}${tasks.length}END`; tasks.push(`- [${checked ? 'x' : ' '}] ${value}`); parent.replaceWith(pre);
  }
  if (n.encrypted) issues.push(`${n.id}: encrypted note. Decrypt it in Note Station and export again.`);
  if (doc.querySelector('table') || /syno-notestation.*chart/.test(n.html)) issues.push(`${n.id}: table or chart needs manual review.`);
  let fence = '```'; while (n.html.includes(fence)) fence += '`';
  let body = n.encrypted ? `${fence}\n${n.html}\n${fence}` : htmlToMarkdown(doc.body.innerHTML);
  tasks.forEach((task, i) => { body = body.replace(`${taskPrefix}${i}END`, () => task); });
  const properties: Record<string, unknown> = { notestation_id: n.id, notestation_notebook: n.parent, title: n.title, notestation_tags: n.tags, tags: n.tags.map(t => t.replace(/[^\p{L}\p{N}_/-]/gu, '-')).filter(t => t && !/^\d+$/.test(t)) };
  if (n.ctime !== undefined) properties.notestation_ctime = n.ctime;
  if (n.mtime !== undefined) properties.notestation_mtime = n.mtime;
  if (n.url) properties.source_url = n.url;
  notes.push({ path: notePaths.get(n.id)!, text: `---\n${stringifyYaml(properties)}---\n\n# ${markdownText(n.title)}\n\n${body}\n${extra.length ? '\n## Attachments\n\n' + extra.join('\n') + '\n' : ''}`, times: { ...(n.ctime !== undefined ? { ctime: n.ctime * 1000 } : {}), ...(n.mtime !== undefined ? { mtime: n.mtime * 1000 } : {}) } });
 }
 const report = `# Import report\n\n${notes.length} notes. ${archive.notebooks.length} notebooks. ${assets.length} assets.\n\n${changes ? '## Source ID comparison\n\n' + Object.entries(changes).map(([k,v]) => `- ${k}: ${v.length}${v.length ? ' (' + v.join(', ') + ')' : ''}`).join('\n') + '\n\n' : ''}## Items for review\n\n${issues.length ? issues.map(i => '- ' + markdownText(i)).join('\n') : 'No missing assets or unresolved links found.'}\n`;
 return { folder, folders: [...books.values()].map(b => `${folder}/${b}`), notes, assets, issues, snapshot: snapshot(archive), report };
}
export type ImportVault = Pick<Vault, 'create' | 'createFolder' | 'createBinary' | 'getAbstractFileByPath' | 'getRoot'>;
export async function writePlan(vault: ImportVault, plan: Plan): Promise<void> {
 rootFolder(plan.folder);
 if (vault.getRoot().children.some(f => f.name.toLowerCase() === plan.folder.toLowerCase()) || vault.getAbstractFileByPath(plan.folder)) throw new Error('The output folder exists. Select a new folder.');
 await vault.createFolder(plan.folder);
 try {
  const folders = new Set<string>();
  for (const path of plan.folders) { await vault.createFolder(path); folders.add(path); }
  const make = async (path: string) => { const parent = path.slice(0, path.lastIndexOf('/')); if (parent !== plan.folder && !folders.has(parent)) { await vault.createFolder(parent); folders.add(parent); } };
  for (const a of plan.assets) { await make(a.path); await vault.createBinary(a.path, Uint8Array.from(a.bytes).buffer); }
  for (const n of plan.notes) { await make(n.path); await vault.create(n.path, n.text, n.times); }
  await vault.create(`${plan.folder}/Import report.md`, plan.report);
  await vault.create(`${plan.folder}/Source snapshot.json`, JSON.stringify(plan.snapshot, null, 2));
 } catch(e) { throw new Error(`Import stopped in ${plan.folder}. Partial files remain. ${e instanceof Error ? e.message : String(e)}`); }
}
