import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { zipStream } from '../../src/ui/zip';

describe('zipStream', () => {
  it('builds one ZIP from files handed over one at a time', async () => {
    const z = zipStream();
    z.add('a-page-1.jpg', new Uint8Array([0xff, 0xd8, 1, 2, 3]));
    z.add('a-page-2.jpg', new Uint8Array([0xff, 0xd8, 4, 5]));
    const blob = await z.finish();
    expect(blob.type).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['a-page-1.jpg', 'a-page-2.jpg']);
    expect([...files['a-page-2.jpg']!]).toEqual([0xff, 0xd8, 4, 5]);
  });
});
