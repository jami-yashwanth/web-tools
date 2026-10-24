import { imagesToPdf } from './images-to-pdf';
import { loadLib, merge, pageCount, PdfError, split } from './ops';
import type { PdfOut, PdfRequest } from './types';
import { serve } from './worker-host';

async function run(msg: PdfRequest): Promise<number | PdfOut | PdfOut[]> {
  switch (msg.op) {
    case 'warm':
      await loadLib();
      return 0;
    case 'count':
      return pageCount(msg.bytes);
    case 'merge':
      return merge(msg.files);
    case 'split':
      return split(msg.bytes, msg.base, msg.mode);
    case 'images': {
      const { bytes, pages } = await imagesToPdf(
        msg.images.map((i) => ({ ...i, bytes: new Uint8Array(i.bytes) })),
        msg.size,
      );
      return { name: 'images.pdf', bytes, pages };
    }
    case 'rasterize':
      throw new PdfError('corrupt'); // served by raster-worker.ts
  }
}

serve(run);
