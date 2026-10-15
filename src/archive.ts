import { strFromU8, unzipSync } from 'fflate';


export const MAX_ZIP = 20 * 1024 * 1024;
export const MAX_EXPANDED = 100 * 1024 * 1024;
const MAX_MEMBERS = 5000;
/** The archive files that the import reads. Other members are checked for safe paths and size, but not expanded. */


interface Member { name: string; size: number; crc: number }

/** Check a relative archive path before the ZIP reader uses it. */
export function safeArchivePath(path: string): boolean {
	return path.length > 0 && path.length < 512 && !path.includes('\\') && !Array.from(path).some((c) => c.charCodeAt(0) < 32) && !path.startsWith('/') && !path.includes(':') && path.split('/').every((s) => s !== '..' && s !== '.');
}

/** Read the central directory before expansion. Reject encryption, unsafe names, duplicate names and too much expanded data. */
export function members(bytes: Uint8Array): Member[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
		if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
	}
	if (end < 0) throw new Error('ZIP central directory not found.');
	if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Split ZIP files are not supported.');
	const count = view.getUint16(end + 10, true);
	let cursor = view.getUint32(end + 16, true);
	const directoryEnd = cursor + view.getUint32(end + 12, true);
	if (count > MAX_MEMBERS || count !== view.getUint16(end + 8, true) || directoryEnd > end) throw new Error('Invalid or oversized ZIP directory.');
	const result: Member[] = [];
	const names = new Set<string>();
	let total = 0;
	for (let i = 0; i < count; i++) {
		if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Invalid ZIP member.');
		if (view.getUint16(cursor + 8, true) & 1) throw new Error('Encrypted ZIP files are not supported.');
		const length = view.getUint16(cursor + 28, true);
		const next = cursor + 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
		if (next > directoryEnd) throw new Error('Invalid ZIP member length.');
		const name = strFromU8(bytes.subarray(cursor + 46, cursor + 46 + length));
		if (!safeArchivePath(name)) throw new Error('The archive has an unsafe path.');
		if (names.has(name.toLowerCase())) throw new Error('The archive has duplicate member names.');
		names.add(name.toLowerCase());
		const size = view.getUint32(cursor + 24, true);
		// Reject ZIP64 size and offset sentinels before unzipSync reads extra fields.
		if (size === 0xffffffff || view.getUint32(cursor + 20, true) === 0xffffffff || view.getUint32(cursor + 42, true) === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
		total += size;
		if (total > MAX_EXPANDED) throw new Error('The expanded archive exceeds 100 MiB.');
		result.push({ name, size, crc: view.getUint32(cursor + 16, true) });
		cursor = next;
	}
	if (cursor !== directoryEnd) throw new Error('Invalid ZIP directory size.');
	return result;
}
const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
	let value = i;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
	return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 255] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}


export function readZip(bytes: Uint8Array, wanted?: Set<string>, includeAssets = false): Record<string, Uint8Array> {
 if (bytes.length > MAX_ZIP) throw new Error('The archive exceeds 20 MiB.');
 const index = members(bytes);
 const allowed = new Map(index.map(m => [m.name, m]));
 const files = unzipSync(bytes, { filter: file => {
  const entry = allowed.get(file.name);
  if (!entry || entry.size !== file.originalSize) throw new Error('ZIP member does not match its directory.');
  return (wanted ? wanted.has(file.name) : !file.name.includes('/') && !file.name.startsWith('file_thumb')) || includeAssets && /^file_[a-zA-Z0-9]+$/.test(file.name) && !file.name.startsWith('file_thumb');
 }});
 for (const entry of index) {
  const data = files[entry.name];
  if (data && (data.length !== entry.size || crc32(data) !== entry.crc)) throw new Error('ZIP checksum failed: ' + entry.name);
 }
 return files;
}
