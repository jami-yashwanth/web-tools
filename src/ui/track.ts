import type { AiFail } from '../ai/errors';

/**
 * Plausible events. Props are only ever {tool, count} or {tool, reason}, or {tool} for tool_used:
 * never a file name, size, type or any pasted/typed content.
 */
export function track(name: 'convert_success' | 'convert_error' | 'tool_used', props: Record<string, string | number>): void {
  (window as { plausible?: (n: string, o: { props: typeof props }) => void }).plausible?.(name, { props });
}

/**
 * Report an island's finished jobs and failures (Cancel included, as `cancelled`). Call it right after the island mounts,
 * before any interaction. The reasons are the AiFail union (src/ai/errors.ts): no island-specific reason gets through.
 */
export function trackHooks(
  tool: string,
  hooks: { onSuccess(cb: (count: number) => void): void; onError(cb: (reason: AiFail) => void): void },
): void {
  hooks.onSuccess((count) => track('convert_success', { tool, count }));
  hooks.onError((reason) => track('convert_error', { tool, reason }));
}
