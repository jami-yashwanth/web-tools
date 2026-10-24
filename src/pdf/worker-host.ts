import { PdfError } from './ops';
import type { PdfOut, PdfRequest, PdfResponse, RasterOut, RasterPage } from './types';

export type PdfResult = number | PdfOut | PdfOut[] | RasterOut;

// Minimal view of the worker global, so the DOM lib's `self` types stay untouched.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<PdfRequest>) => void) | null;
  postMessage(message: PdfResponse, transfer?: Transferable[]): void;
};

const buffersOf = (result: PdfResult): Transferable[] =>
  typeof result === 'number' || !('bytes' in result || Array.isArray(result))
    ? []
    : [result as PdfOut | PdfOut[]].flat().map((o) => o.bytes.buffer as ArrayBuffer);

/** Send one finished page to the page now (its bytes move, not copy), so the worker never holds them. */
export type EmitPage = (page: RasterPage) => void;

/** Answer every job posted to this worker with `run`'s result, or its failure reason. Always answers, so the queue never stalls. */
export function serve(run: (msg: PdfRequest, emit: EmitPage) => Promise<PdfResult>): void {
  scope.onmessage = async (e) => {
    const msg = e.data;
    const emit: EmitPage = (page) => scope.postMessage({ kind: 'page', id: msg.id, ...page }, [page.bytes.buffer as ArrayBuffer]);
    try {
      const result = await run(msg, emit);
      scope.postMessage({ kind: 'done', id: msg.id, result }, buffersOf(result));
    } catch (err) {
      if (!(err instanceof PdfError)) console.error('pdf worker: unexpected error', err);
      scope.postMessage({
        kind: 'failed',
        id: msg.id,
        reason: err instanceof PdfError ? err.reason : 'corrupt',
        ...(err instanceof PdfError && err.index !== undefined ? { index: err.index } : {}),
      });
    }
  };
}
