import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI } from './pro';
import { record, text, type Snapshot } from './model';
import type NotestationNsxImportPlugin from './main';
import { helloSettingItems } from './hello/settings';
export interface ImportSettings { folder: string; profiles: Record<string, Record<string, string>> }
export const DEFAULT_SETTINGS: ImportSettings = { folder: 'Note Station import', profiles: {} };
export function normalizeSettings(saved: unknown): ImportSettings {
 let s: Record<string, unknown>; try { s = record(saved); } catch { return { ...DEFAULT_SETTINGS, profiles: {} }; }
 const profiles: ImportSettings['profiles'] = Object.create(null) as ImportSettings['profiles'];
 if (s.profiles && typeof s.profiles === 'object' && !Array.isArray(s.profiles)) {
  for (const [name, mapping] of Object.entries(record(s.profiles))) {
   if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) continue;
   profiles[name] = Object.fromEntries(Object.entries(record(mapping)).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  }
 }
 return { folder: text(s.folder) || DEFAULT_SETTINGS.folder, profiles };
}
export function readSnapshot(value: unknown): Snapshot {
 const s = record(value);
 if (Object.values(s).some(v => typeof v !== 'string')) throw new Error('Select a Source snapshot.json file from an earlier import.');
 return s as Snapshot;
}
export class ImportSettingTab extends PluginSettingTab {
 constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], readonly owner: NotestationNsxImportPlugin) { super(app, owner); }
 getSettingDefinitions(): SettingDefinitionItem[] {
  // The product rows, then the "More from NoteMods" card (packages/hello).
  return [...this.productSettingDefinitions(), ...helloSettingItems()];
 }

 productSettingDefinitions(): SettingDefinitionItem[] {
  return [...(this.owner.pro ? sponsorsSettingItems(this.owner.pro, PRO_UI) : []), { name: 'Default output folder', desc: 'Use one new folder name. An existing folder stops the import.', control: { type: 'text', key: 'folder', defaultValue: DEFAULT_SETTINGS.folder } }];
 }
}
