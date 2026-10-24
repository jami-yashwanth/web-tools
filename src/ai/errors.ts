/** Why an on-device AI job failed. These are also the analytics reasons (`convert_error {tool, reason}`). */
export type AiFail = 'network' | 'cancelled' | 'unsupported' | 'too-large' | 'too-long' | 'corrupt' | 'wrong-type' | 'device' | 'encrypted';

export interface AiErrorDetail {
  /** For wrong-type: the type the file really is, when known (a short code such as "heic"). */
  detectedType?: string;
  /**
   * The model's bytes could not be parsed (a damaged download or cache entry). The island drops the cached model
   * and shows the download-failed copy, so Try again downloads it afresh. Use with reason 'network'.
   */
  badModel?: boolean;
  /** The failure this one stands for (kept so it can be asked about, e.g. whether memory ran out). */
  cause?: unknown;
}

export class AiError extends Error {
  readonly detectedType?: string;
  readonly badModel: boolean;
  constructor(
    readonly reason: AiFail,
    detail: AiErrorDetail = {},
  ) {
    super(reason, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = 'AiError';
    if (detail.detectedType) this.detectedType = detail.detectedType;
    this.badModel = detail.badModel === true;
  }
}

/** The reason carried by any thrown value: an AiError's own, or `fallback` for anything else. */
export const reasonOf = (err: unknown, fallback: AiFail = 'corrupt'): AiFail => (err instanceof AiError ? err.reason : fallback);
