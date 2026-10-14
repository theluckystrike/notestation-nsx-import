import { Modal, Notice, Setting } from 'obsidian';
import { LABELS } from './labels';
import { MAX_ZIP } from './archive';
import { readArchive, type Archive, type Snapshot } from './model';
import { buildPlan, writePlan } from './importer';
import { readSnapshot } from './settings';
import { isPro } from './pro';
import type NotestationNsxImportPlugin from './main';

export class ImportModal extends Modal {
 archive: Archive | null = null;
 mapping: Record<string, string> = Object.create(null) as Record<string,string>;
 before?: Snapshot;
 folder: string;
 busy = false;
 private summary?: HTMLElement;
 constructor(readonly owner: NotestationNsxImportPlugin, bytes?: Uint8Array) {
  super(owner.app); this.folder = owner.settings.folder;
  if (bytes) this.archive = readArchive(bytes);
 }
 onOpen(): void { this.draw(); }
 draw(): void {
  const el = this.contentEl; el.empty(); el.addClass('nsx-import'); this.setTitle(`Import ${LABELS.source} backup`);
  el.createEl('p', { text: `Select one local ${LABELS.archive} archive. Preview the records, then write to a new folder.` });
  const input = el.createEl('input', { type: 'file', cls: 'nsx-file' }); input.accept = '.nsx'; input.setAttribute('aria-label', `${LABELS.archive} archive`);
  input.addEventListener('change', () => { void this.select(input.files?.[0]); });
  new Setting(el).setName('Output folder').setDesc('Use a new folder name. Existing files stay unchanged.').addText(t => t.setValue(this.folder).onChange(v => { this.folder = v; }));
  this.summary = el.createDiv({ cls: 'nsx-summary' });
  if (this.archive) {
   const a = this.archive;
   this.summary.createEl('p', { text: `${a.notes.length} notes · ${a.notebooks.length} notebooks · ${a.assets.size} asset members`, cls: 'nsx-counts' });
   const preview = this.summary.createEl('ul'); for (const n of a.notes.slice(0, 6)) preview.createEl('li', { text: `${n.title} — ${a.notebooks.find(b => b.id === n.parent)?.title ?? 'Unfiled'}` });
   for (const b of a.notebooks) new Setting(el).setName(b.title).setDesc('Notebook folder').addText(t => t.setValue(this.mapping[b.id] ?? b.title).onChange(v => { this.mapping[b.id] = v; }));
   const profiles = Object.keys(this.owner.settings.profiles);
   new Setting(el).setName(`Notebook mapping profiles (${LABELS.pro})`).setDesc('Save or load notebook folders by source notebook ID.').addDropdown(d => { d.addOption('', 'Select a profile'); profiles.forEach(p => { d.addOption(p,p); }); d.onChange(p => { if (!isPro()) { new Notice(`Notebook mapping profiles need ${LABELS.pro}.`); return; } if(p) { this.mapping = { ...this.owner.settings.profiles[p] }; this.draw(); } }); });
   let profile = '';
   new Setting(el).setName(`Save mapping profile (${LABELS.pro})`).addText(t => t.setPlaceholder('Profile name').onChange(v => { profile = v; })).addButton(b => b.setButtonText('Save profile').onClick(() => { void this.saveProfile(profile); }));
   new Setting(el).setName(`Compare later backup (${LABELS.pro})`).setDesc('Select Source snapshot.json from an earlier import. Use a new review folder.');
   const prior = el.createEl('input', { type:'file', cls:'nsx-snapshot' }); prior.accept = '.json'; prior.setAttribute('aria-label','Earlier source snapshot');
   prior.addEventListener('change', () => { void this.selectSnapshot(prior.files?.[0]); });
   if (this.before) el.createEl('p', { text:'Source ID comparison is ready. Only added or changed notes go to the review folder.' });
   new Setting(el).addButton(b => b.setButtonText('Create new files').setCta().setDisabled(this.busy).onClick(() => { void this.run(); }));
  } else this.summary.createEl('p', { text:'No archive selected.' });
  el.createEl('p', { text:`Limits: 20 ${LABELS.unit} archive, 100 ${LABELS.unit} expanded data, 5,000 members. Charts and complex tables need manual review.`, cls:'nsx-limits' });
 }
 async select(file?: File): Promise<void> {
  if (!file || this.busy) return;
  try { if(file.size > MAX_ZIP) throw new Error('The archive exceeds 20 MiB.'); this.archive = readArchive(new Uint8Array(await file.arrayBuffer())); this.mapping = {}; this.before = undefined; this.draw(); }
  catch(e) { this.archive = null; this.draw(); this.error(e); }
 }
 async saveProfile(name: string): Promise<void> {
  try { await this.owner.saveProfile(name, this.archive!, this.mapping); this.draw(); new Notice('Notebook mapping profile saved.'); }
  catch(e) { this.error(e); }
 }
 async selectSnapshot(file?: File): Promise<void> {
  if (!file || this.busy) return;
  try { if (!isPro()) throw new Error('Backup comparison needs Pro.'); if(file.size > MAX_ZIP) throw new Error('Snapshot exceeds 20 MiB.'); this.before = readSnapshot(JSON.parse(await file.text()) as unknown); this.folder = 'Note Station review'; this.draw(); }
  catch(e) { this.error(e); }
 }
 async run(): Promise<void> {
  if (!this.archive || this.busy) return;
  this.busy = true; this.draw();
  try {
   if(this.before && !isPro()) throw new Error('Backup comparison needs Pro.');
   const plan = buildPlan(this.archive, this.folder, this.mapping, this.before);
   await writePlan(this.app.vault, plan);
   this.contentEl.empty(); this.contentEl.createEl('h2', { text:'Import complete' });
   this.contentEl.createEl('p', { text:`${plan.notes.length} notes and ${plan.assets.length} assets created in ${plan.folder}.` });
   this.contentEl.createEl('pre', { text: plan.report, cls:'nsx-report' });
   new Notice(`${LABELS.source} import complete. Open the import report for review.`);
  } catch(e) { this.busy = false; this.draw(); this.error(e); } finally { this.busy = false; }
 }
 private error(e: unknown): void { const message = e instanceof Error ? e.message : String(e); this.contentEl.createEl('p', { text:message, cls:'nsx-error' }); new Notice(message); }
 onClose(): void { this.contentEl.empty(); }
}
