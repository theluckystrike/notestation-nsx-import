import { Notice, Plugin } from 'obsidian';
import { LABELS } from './labels';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, ImportSettingTab, normalizeSettings, type ImportSettings } from './settings';
import { ImportModal } from './modal';
import type { Archive } from './model';
export default class NotestationNsxImportPlugin extends Plugin {
 settings: ImportSettings = { ...DEFAULT_SETTINGS, profiles:{} };
 pro: SponsorsManager | null = null;
 async onload(): Promise<void> {
  await this.loadSettings();
  const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this); pro.init(); this.pro = pro; bindPro(pro);
  const tab = new ImportSettingTab(this.app, this); this.addSettingTab(tab); this.register(pro.onChange(() => tab.update()));
  this.addCommand({ id:'import-nsx', name:`Import a local ${LABELS.archive} archive`, callback: () => { this.openImport(); } });
  this.app.workspace.onLayoutReady(() => { void pro.refresh(); this.registerInterval(window.setInterval(() => { void pro.refresh(); }, 6 * 60 * 60 * 1000)); });
 }
 openImport(bytes?: Uint8Array): ImportModal { const modal = new ImportModal(this, bytes); this.register(() => modal.close()); modal.open(); return modal; }
 async saveProfile(name: string, archive: Archive, mapping: Record<string,string>): Promise<void> {
  if(!isPro()) throw new Error('Notebook mapping profiles need Pro.');
  if(!name.trim()) throw new Error('Enter a profile name.');
  this.settings.profiles = { ...this.settings.profiles, [name.trim()]: Object.fromEntries(archive.notebooks.map(b => [b.id, Object.prototype.hasOwnProperty.call(mapping, b.id) ? (mapping[b.id] ?? b.title) : b.title])) }; await this.saveSettings();
 }
 onunload(): void { resetPro(); }
 async loadSettings(): Promise<void> { this.settings = normalizeSettings(await this.loadData() as unknown); }
 async saveSettings(): Promise<void> { await this.saveData(this.settings); }
 showImportError(message: string): void { new Notice(message); }
}
