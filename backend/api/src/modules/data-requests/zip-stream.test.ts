import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, dosDateTime, zipStream, type ZipEntry } from './zip-stream';

async function collect(entries: ZipEntry[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of zipStream(entries, new Date('2026-10-28T12:34:56Z'))) parts.push(part);
  return Buffer.concat(parts);
}

async function* lines(n: number): AsyncGenerator<string> {
  yield 'id,value\r\n';
  for (let i = 0; i < n; i++) yield `${i},"row ${i}"\r\n`;
}

describe('zipStream (QA-081 data export)', () => {
  it('computes the IEEE CRC-32 zip uses, incrementally', () => {
    const data = Buffer.from('The quick brown fox jumps over the lazy dog');
    expect(crc32(data)).toBe(0x414fa339);
    expect(crc32(data.subarray(10), crc32(data.subarray(0, 10)))).toBe(0x414fa339);
    if (typeof zlibCrc32 === 'function') expect(crc32(data)).toBe(zlibCrc32(data));
  });

  it('packs the DOS date and time in UTC', () => {
    const { time, date } = dosDateTime(new Date('2026-10-28T12:34:56Z'));
    expect(date >> 9).toBe(46);
    expect((date >> 5) & 0xf).toBe(10);
    expect(date & 0x1f).toBe(28);
    expect(time >> 11).toBe(12);
    expect((time >> 5) & 0x3f).toBe(34);
    expect((time & 0x1f) * 2).toBe(56);
  });

  it('writes an archive a zip reader opens, with every entry byte for byte and the CRCs checked', async () => {
    const { default: JSZip } = await import('jszip');
    const buffer = await collect([
      { name: 'workspace.json', content: ['{"name":"Café Ünïcode"}\n'] },
      { name: 'calls.csv', content: lines(5_000) },
      { name: 'empty.csv', content: [] },
      { name: 'bytes.bin', content: [new Uint8Array([0, 1, 2, 255])] },
    ]);
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual(['workspace.json', 'calls.csv', 'empty.csv', 'bytes.bin']);
    expect(await zip.file('workspace.json')!.async('string')).toBe('{"name":"Café Ünïcode"}\n');
    const csv = await zip.file('calls.csv')!.async('string');
    expect(csv.split('\r\n')).toHaveLength(5_002);
    expect(csv.startsWith('id,value\r\n0,"row 0"\r\n')).toBe(true);
    expect(await zip.file('empty.csv')!.async('string')).toBe('');
    expect([...(await zip.file('bytes.bin')!.async('uint8array'))]).toEqual([0, 1, 2, 255]);
    // Deflated: 5 000 near-identical lines shrink a long way.
    expect(buffer.length).toBeLessThan(csv.length / 3);
  });

  it('fails the archive when a section fails, instead of writing a truncated entry', async () => {
    async function* broken(): AsyncGenerator<string> {
      yield 'a\r\n';
      throw new Error('database went away');
    }
    await expect(collect([{ name: 'ok.csv', content: ['x'] }, { name: 'broken.csv', content: broken() }])).rejects.toThrow('database went away');
  });

  it('reads an entry only when the writer reaches it', async () => {
    const order: string[] = [];
    async function* tracked(name: string): AsyncGenerator<string> {
      order.push(`start ${name}`);
      yield name;
      order.push(`end ${name}`);
    }
    await collect([{ name: 'a', content: tracked('a') }, { name: 'b', content: tracked('b') }]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
});
