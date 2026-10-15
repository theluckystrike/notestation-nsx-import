import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { MAX_ZIP, members, readZip } from '../src/archive';

function archive() {
	const bytes = zipSync({ 'config.json': strToU8('{}') });
	const view = new DataView(bytes.buffer);
	const end = bytes.length - 22;
	return { bytes, view, end, directory: view.getUint32(end + 16, true) };
}

/** ZIP64 directory with compressed_size=0xffffffff and no extra field 0x0001.
 * This reaches the unbounded z64e loop in fflate 0.8.2 (CVE-2026-45820).
 */
function missingZip64ExtraField(): Uint8Array {
	const { bytes, end, directory } = archive();
	const result = new Uint8Array(bytes.length + 76);
	result.set(bytes.subarray(0, end));
	result.set(bytes.subarray(end), end + 76);
	const view = new DataView(result.buffer);
	view.setUint32(directory + 20, 0xffffffff, true);
	// ZIP64 end record, followed by its locator and the original end record.
	view.setUint32(end, 0x06064b50, true);
	view.setUint32(end + 4, 44, true);
	view.setUint32(end + 24, 1, true);
	view.setUint32(end + 32, 1, true);
	view.setUint32(end + 40, end - directory, true);
	view.setUint32(end + 48, directory, true);
	view.setUint32(end + 56, 0x07064b50, true);
	view.setUint32(end + 64, end, true);
	view.setUint32(end + 72, 1, true);
	view.setUint32(end + 76 + 16, 0xffffffff, true);
	return result;
}

describe('untrusted archive regressions', () => {
	it('fflate rejects the exact CVE-2026-45820 archive without hanging', () => {
		// A subprocess timeout also bounds this test if a vulnerable pin returns.
		// Exercise the browser implementation that is bundled into the plugin.
		const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
			const { unzipSync } = require('fflate/browser');
			try { unzipSync(Buffer.from(process.argv[1], 'base64')); process.exit(2); }
			catch (error) { if (error.code !== 13) throw error; }
		`, Buffer.from(missingZip64ExtraField()).toString('base64')], { timeout: 3000, encoding: 'utf8' });
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status, result.stderr).toBe(0);
	});

	it.each([20, 24, 42])('rejects ZIP64 marker at central-directory offset %i before expansion', offset => {
		const { bytes, view, directory } = archive();
		view.setUint32(directory + offset, 0xffffffff, true);
		expect(() => members(bytes)).toThrow('ZIP64 archives are not supported');
		expect(() => readZip(bytes)).toThrow('ZIP64 archives are not supported');
	});

	it('rejects the advisory ZIP64 end record before expansion', () => {
		expect(() => readZip(missingZip64ExtraField())).toThrow('Invalid or oversized ZIP directory');
	});

	it('rejects truncated archives and malformed member lengths', () => {
		const { bytes, view, directory } = archive();
		expect(() => readZip(bytes.subarray(0, bytes.length - 1))).toThrow('central directory not found');
		view.setUint16(directory + 30, 0xffff, true);
		expect(() => readZip(bytes)).toThrow('Invalid ZIP member length');
	});

	it('rejects encrypted and split archives', () => {
		const { bytes, view, directory, end } = archive();
		view.setUint16(directory + 8, 1, true);
		expect(() => readZip(bytes)).toThrow('Encrypted ZIP');
		view.setUint16(end + 4, 1, true);
		expect(() => readZip(bytes)).toThrow('Split ZIP');
	});

	it('rejects case-insensitive duplicate paths', () => {
		const bytes = zipSync({ 'config.json': strToU8('{}'), 'CONFIG.JSON': strToU8('{}') });
		expect(() => readZip(bytes)).toThrow('duplicate member names');
	});

	it('keeps compressed size and member count limits', () => {
		expect(() => readZip(new Uint8Array(MAX_ZIP + 1))).toThrow('exceeds 20 MiB');
		const { bytes, view, end } = archive();
		view.setUint16(end + 8, 5001, true);
		view.setUint16(end + 10, 5001, true);
		expect(() => readZip(bytes)).toThrow('Invalid or oversized ZIP directory');
	});
});
