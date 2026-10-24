import { AiError } from '../ai/errors';
import { sniff, type Sniffed } from '../engine/sniff';

// What the AI image tools (Remove background, Image to text, Upscale image) take: a JPG, PNG or WebP image. Anything
// else is a wrong type, named where we can, with a way to the tool that takes it.

export const IMAGE_INPUT_NAME = 'JPG, PNG or WebP image';
export const IMAGE_ELSEWHERE: Record<string, { href: string; h1: string }> = {
  heic: { href: '/heic-to-jpg/', h1: 'HEIC to JPG' },
  pdf: { href: '/pdf-to-jpg/', h1: 'PDF to JPG' },
};

/** A PDF is the one wrong type worth recognising by name: sniff() only knows images. */
export async function isPdf(file: Blob): Promise<boolean> {
  return new TextDecoder().decode(await file.slice(0, 5).arrayBuffer()) === '%PDF-';
}

/** The image's type and size, read from its header. Throws AiError wrong-type (with what it is, if known). */
export async function checkImageInput(file: Blob): Promise<Sniffed> {
  if (await isPdf(file)) throw new AiError('wrong-type', { detectedType: 'pdf' });
  const sniffed = await sniff(file);
  const { type } = sniffed;
  if (type !== 'jpg' && type !== 'png' && type !== 'webp') throw new AiError('wrong-type', type === 'unknown' ? {} : { detectedType: type });
  return sniffed;
}
