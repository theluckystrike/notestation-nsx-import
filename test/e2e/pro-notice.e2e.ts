import { browser, expect } from '@wdio/globals';
import { zipSync, strToU8 } from 'fflate';
import { pluginId } from './load';

interface Pro { opts: { http: unknown }; refreshNow(): Promise<unknown>; signOut(): void }
interface Host { pro: Pro; settings: { profiles: Record<string, unknown> }; saveSettings(): Promise<void> }

function sample(): number[] {
	return Array.from(zipSync({
		'config.json': strToU8(JSON.stringify({ note: ['n1'], notebook: ['b1'] })),
		b1: strToU8(JSON.stringify({ title: 'Research' })),
		n1: strToU8(JSON.stringify({ title: 'Field notes', parent_id: 'b1', content: '<p>Pro notice check</p>', ctime: 1700000000, mtime: 1700000060 })),
	}));
}

async function closeModal(): Promise<void> {
	await browser.keys('Escape');
	await browser.$('.nsx-import').waitForExist({ reverse: true });
}

async function openWithArchive(): Promise<void> {
	await browser.executeObsidianCommand(`${pluginId}:import-nsx`);
	await browser.$('.nsx-file').waitForExist();
	await browser.execute((values: number[]) => {
		const input = document.querySelector<HTMLInputElement>('.nsx-file')!;
		const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(values)], 'backup.nsx'));
		input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
	}, sample());
	await browser.$('.nsx-counts').waitForExist();
	await browser.$('input[placeholder="Profile name"]').setValue('Field profile');
}

const clickSave = () => browser.execute(() => {
	const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.nsx-import button')).find((b) => b.textContent === 'Save profile');
	if (!button || button.disabled) throw Error('Save profile is not enabled');
	button.click();
});

const selectSnapshot = () => browser.execute(() => {
	const input = document.querySelector<HTMLInputElement>('.nsx-snapshot')!;
	if (input.disabled) throw Error('The snapshot input is not enabled');
	const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ n1: 'earlier' })], 'Source snapshot.json'));
	input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
});

const notices = () => browser.execute(() => [...document.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', buttons: n.querySelectorAll('.pf-pro-notice-sponsor').length })));
const clearNotices = () => browser.execute(() => { document.querySelectorAll('.notice').forEach((n) => n.remove()); });

describe('Pro notice for a free user', () => {
	it('a free user who selects Save profile or an earlier snapshot gets the Pro notice with a Sponsor button, and nothing is saved', async () => {
		await browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, Host> } }).plugins.plugins[id]!;
			p.pro.signOut();
		}, pluginId);
		await clearNotices();
		await openWithArchive();

		await clickSave();
		await browser.waitUntil(async () => (await notices()).some((n) => n.text.includes('Notebook mapping profiles need Pro.')), { timeout: 5000, timeoutMsg: 'No Pro notice after Save profile.' });
		const save = (await notices()).find((n) => n.text.includes('Notebook mapping profiles need Pro.'))!;
		expect(save.text).toContain('Notebook mapping profiles need Pro. Sponsor on GitHub, then sign in from the plugin settings.');
		expect(save.buttons).toBe(1);

		await selectSnapshot();
		await browser.waitUntil(async () => (await notices()).some((n) => n.text.includes('Backup comparison needs Pro.')), { timeout: 5000, timeoutMsg: 'No Pro notice after the snapshot select.' });
		const compare = (await notices()).find((n) => n.text.includes('Backup comparison needs Pro.'))!;
		expect(compare.text).toContain('Backup comparison needs Pro. Sponsor on GitHub, then sign in from the plugin settings.');
		expect(compare.buttons).toBe(1);

		const state = await browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, Host> } }).plugins.plugins[id]!;
			const modal = document.querySelector('.nsx-import');
			return {
				profiles: Object.keys(p.settings.profiles),
				ready: modal?.textContent?.includes('comparison is ready') ?? false,
				errors: document.querySelectorAll('.nsx-import .nsx-error').length,
				snapshotFiles: document.querySelector<HTMLInputElement>('.nsx-snapshot')?.files?.length ?? 0,
			};
		}, pluginId);
		expect(state).toEqual({ profiles: [], ready: false, errors: 0, snapshotFiles: 0 });
		await closeModal();
		await clearNotices();
	});

	it('a Pro user who selects Save profile and an earlier snapshot saves the profile and gets the comparison', async () => {
		await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, Host> } }).plugins.plugins[id]!;
			p.pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
			app.secretStorage.setSecret(id + '-github-token', 'gho_' + '0'.repeat(36));
			await p.pro.refreshNow();
		}, pluginId);
		try {
			await openWithArchive();
			await clickSave();
			await browser.waitUntil(async () => await browser.execute(() => Boolean(document.querySelector('.nsx-import select option[value="Field profile"]'))), { timeout: 5000, timeoutMsg: 'The Pro user could not save the profile.' });
			await selectSnapshot();
			await browser.waitUntil(async () => await browser.execute(() => document.querySelector('.nsx-import')?.textContent?.includes('comparison is ready') ?? false), { timeout: 5000, timeoutMsg: 'The Pro user did not get the comparison.' });
			const state = await browser.executeObsidian(({ app }, id) => {
				const p = (app as unknown as { plugins: { plugins: Record<string, Host> } }).plugins.plugins[id]!;
				return { profiles: Object.keys(p.settings.profiles), sponsorButtons: document.querySelectorAll('.notice .pf-pro-notice-sponsor').length };
			}, pluginId);
			expect(state).toEqual({ profiles: ['Field profile'], sponsorButtons: 0 });
			await closeModal();
		} finally {
			await browser.executeObsidian(async ({ app }, id) => {
				const p = (app as unknown as { plugins: { plugins: Record<string, Host> } }).plugins.plugins[id]!;
				p.pro.signOut();
				p.settings.profiles = {};
				await p.saveSettings();
			}, pluginId);
		}
	});
});
