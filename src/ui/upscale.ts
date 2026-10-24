import type { Caps } from '../ai/capability';
import { upscaleEngine, type UpscaleResult } from '../ai/upscale/engine';
import type { Scale } from '../ai/upscale/tiles';
import { checkImageInput, IMAGE_ELSEWHERE, IMAGE_INPUT_NAME } from './image-input';
import type { AiToolDef } from './ai';
import { createCompare } from './compare';

// Upscale image: the tool definition the shared AI island (ai.ts) runs. The scale (2×, or 4× where offered) is
// chosen beside the drop zone before the image; the result is compared with the image by a before/after slider.

interface UpscaleOut extends UpscaleResult {
  /** The image's file name without its extension: the PNG takes it. */
  base: string;
  scale: Scale;
}

/** Shown while working when only 2× is offered (a phone, or little memory) and the image is over 1 MP. */
const SLOW = 'This can take a few minutes on this device.';
const SLOW_PIXELS = 1_000_000;

/** §4 Too large, by the scale that was asked for. */
const TOO_LARGE: Record<Scale, string> = {
  4: 'Upscaled image would be too large. Try 2×.',
  2: 'This image is too large to upscale.',
};

const baseName = (name: string): string => name.replace(/\.[^./\\]*$/, '').trim() || 'image';

/**
 * Is 4× offered? Its image has four times the pixels of 2× (the model's work is the same), so it needs much more
 * memory: not on phones, and not where the browser reports less than 8 GB. Browsers that don't report memory
 * (Firefox, Safari) count as enough on a computer.
 */
export const offers4x = (caps: Pick<Caps, 'mobile' | 'deviceMemoryGB'>): boolean =>
  !caps.mobile && (caps.deviceMemoryGB === undefined || caps.deviceMemoryGB >= 8);

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

/** `el`: the tool's root, which holds the scale choice (AiTool.astro). */
export function upscaleDef(el: HTMLElement): AiToolDef<UpscaleOut> {
  const four = el.querySelector<HTMLElement>('[data-scale-4]')!;
  const chosen = (): Scale => (el.querySelector<HTMLInputElement>('input[name=scale]:checked')?.value === '4' && !four.hidden ? 4 : 2);
  /** The scale of the run in progress, which decides the too-large copy. */
  let asked: Scale = 2;
  /** The run in progress will be slow on this device. */
  let slow = false;

  return {
    verb: 'Upscaling',
    modelKey: 'upscale',
    // The runtime's 14 MB .wasm downloads with the model on first use; it counts towards the size shown.
    withModel: ['ortWasm'],
    cancelWork: true, // a big image can take minutes
    inputName: IMAGE_INPUT_NAME,
    elsewhere: IMAGE_ELSEWHERE,
    messages: { 'too-large': () => TOO_LARGE[asked] },
    workNote: () => (slow ? SLOW : undefined),

    ready(caps) {
      four.hidden = !offers4x(caps);
      if (four.hidden) el.querySelector<HTMLInputElement>('input[name=scale][value="2"]')!.checked = true;
      four.closest('[data-scale]')!.setAttribute('data-scales', four.hidden ? '2' : '2 4'); // decided
    },

    async check(file, caps) {
      const { width = 0, height = 0 } = await checkImageInput(file);
      slow = !offers4x(caps) && width * height > SLOW_PIXELS;
    },

    async run(file, _caps, onProgress, { signal }) {
      const scale = (asked = chosen());
      const image = await file.arrayBuffer();
      const res = await upscaleEngine.run({ image, scale }, [image], onProgress, signal);
      return { ...res, base: baseName(file.name), scale };
    },

    renderResult(res, root) {
      // Take what's needed out of `res` and hold nothing else: its bytes live on only in the Blobs below.
      const { base, scale, width, height, hasAlpha } = res;
      const after = URL.createObjectURL(new Blob([res.png], { type: 'image/png' }));
      const before = URL.createObjectURL(new Blob([res.preview], { type: 'image/jpeg' }));
      const compare = createCompare(
        { src: before, alt: 'Your image' },
        { src: after, alt: `Your image, upscaled ${scale}×` },
        width,
        height,
      );
      compare.stage.toggleAttribute('data-checkerboard', hasAlpha);
      const download = h('button', { type: 'button', class: 'btn' }, 'Download PNG');
      download.addEventListener('click', () => {
        const a = h('a', { href: after, download: `${base}-${scale}x.png` });
        document.body.append(a);
        a.click();
        a.remove();
      });
      root.append(compare.el, h('div', { class: 'actions' }, download));
      return () => {
        URL.revokeObjectURL(after);
        URL.revokeObjectURL(before);
      };
    },
  };
}
