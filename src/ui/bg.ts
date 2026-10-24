import { bgEngine, type BgResult } from '../ai/bg/engine';
import type { Background } from '../ai/bg/compose';
import { checkImageInput, IMAGE_ELSEWHERE, IMAGE_INPUT_NAME } from './image-input';
import type { AiToolDef } from './ai';
import { createCompare } from './compare';

// Remove background: the tool definition the shared AI island (ai.ts) runs. The result is the cut-out over a
// checkerboard, compared with the photo by a before/after slider. Changing the background shows at once (the
// transparent PNG over that colour looks exactly like the blend) while the worker blends the PNG to download from
// the mask it kept, without running the model again.

interface BgOut extends BgResult {
  /** The photo's file name without its extension: the PNG takes it. */
  base: string;
}

/** While a colour is being picked, wait this long after the last change before blending a PNG. */
const COLOUR_SETTLE_MS = 250;
/** §4 Low memory: a PNG for another background that can't be built is the device running out of memory. */
const LOW_MEMORY = 'This tool needs more memory than this device has.';

const baseName = (name: string): string => name.replace(/\.[^./\\]*$/, '').trim() || 'photo';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

const hexToRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

/** Which PNG a background choice downloads: 'transparent', 'white', or a colour as '#rrggbb'. */
export type BgChoice = string;

/**
 * The object URLs of the PNGs made so far, at most three: transparent, white and the latest colour. A new colour
 * replaces (and revokes) the previous one; a colour that is no longer the latest when its PNG arrives is revoked.
 */
export class BackgroundPngs {
  private readonly fixed = new Map<'transparent' | 'white', string>();
  private colour: { hex: string; url: string } | null = null;
  /** The colour most recently chosen: only its PNG is kept. */
  private latestColour: string | null = null;

  constructor(private readonly revoke: (url: string) => void) {}

  get(choice: BgChoice): string | undefined {
    if (choice === 'transparent' || choice === 'white') return this.fixed.get(choice);
    return this.colour?.hex === choice ? this.colour.url : undefined;
  }

  /** A colour was chosen (before its PNG exists): later colours' PNGs take its place. */
  choose(choice: BgChoice): void {
    if (choice !== 'transparent' && choice !== 'white') this.latestColour = choice;
  }

  /** Keep a PNG's URL. Returns false (and revokes it) when it is for a colour no longer wanted. */
  set(choice: BgChoice, url: string): boolean {
    if (choice === 'transparent' || choice === 'white') {
      const old = this.fixed.get(choice);
      if (old && old !== url) this.revoke(old);
      this.fixed.set(choice, url);
      return true;
    }
    if (choice !== this.latestColour) {
      this.revoke(url);
      return false;
    }
    if (this.colour && this.colour.url !== url) this.revoke(this.colour.url);
    this.colour = { hex: choice, url };
    return true;
  }

  /** Revoke everything (Start over, a new photo). */
  clear(): void {
    for (const url of this.fixed.values()) this.revoke(url);
    if (this.colour) this.revoke(this.colour.url);
    this.fixed.clear();
    this.colour = null;
    this.latestColour = null;
  }
}

export function bgDef(): AiToolDef<BgOut> {
  return {
    verb: 'Removing background',
    modelKey: 'bg',
    // The runtime's 14 MB .wasm downloads with the model on first use; it counts towards the size shown.
    withModel: ['ortWasm'],
    inputName: IMAGE_INPUT_NAME,
    elsewhere: IMAGE_ELSEWHERE,

    async check(file) {
      await checkImageInput(file);
    },

    async run(file, _caps, onProgress, { signal }) {
      const image = await file.arrayBuffer();
      const res = await bgEngine.run({ op: 'remove', image }, [image], onProgress, signal);
      return { ...res, base: baseName(file.name) };
    },

    renderResult(res, root) {
      // Take what's needed out of `res` and hold nothing else: its bytes live on only in the Blobs below.
      const { base, width, height, downscaled } = res;
      const pngs = new BackgroundPngs((url) => URL.revokeObjectURL(url));
      const pngUrl = (bytes: ArrayBuffer) => URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      const transparent = pngUrl(res.png);
      pngs.set('transparent', transparent);
      const before = URL.createObjectURL(new Blob([res.preview!], { type: 'image/jpeg' }));
      const compare = createCompare(
        { src: before, alt: 'Your photo' },
        { src: transparent, alt: 'Your photo with the background removed' },
        width,
        height,
      );

      // --- background: Transparent (default) / White / Colour ---
      const radio = (value: string, label: string, checked = false) =>
        h('label', {}, h('input', { type: 'radio', name: 'bg', value, ...(checked ? { checked: '' } : {}) }), label);
      const colour = h('input', { type: 'color', value: '#000000', 'aria-label': 'Background colour', class: 'bg-colour' });
      colour.hidden = true;
      const options = h(
        'fieldset',
        { class: 'settings pdf-mode pdf-inline bg-options' },
        h('legend', {}, 'Background'),
        radio('transparent', 'Transparent', true),
        radio('white', 'White'),
        radio('colour', 'Colour'),
        colour,
      );

      // --- download: the PNG for the chosen background, blended by the worker when first chosen ---
      const download = h('button', { type: 'button', class: 'btn' }, 'Download PNG');
      const failed = h('p', { class: 'error', role: 'alert' }, LOW_MEMORY);
      failed.hidden = true;
      let chosen: BgChoice = 'transparent';
      let timer: number | undefined;
      let alive = true;

      const current = (): { choice: BgChoice; bg: Background } => {
        const value = options.querySelector<HTMLInputElement>('input[name=bg]:checked')!.value;
        if (value === 'white') return { choice: 'white', bg: { r: 255, g: 255, b: 255 } };
        if (value === 'colour') return { choice: colour.value, bg: hexToRgb(colour.value) };
        return { choice: 'transparent', bg: 'transparent' };
      };
      const showPreview = (choice: BgChoice) => {
        const solid = choice === 'transparent' ? '' : choice === 'white' ? '#ffffff' : choice;
        compare.stage.style.background = solid;
        compare.stage.toggleAttribute('data-checkerboard', !solid);
      };
      const blend = async (choice: BgChoice, bg: Background) => {
        if (pngs.get(choice)) return;
        try {
          const out = await bgEngine.run({ op: 'compose', bg });
          if (!alive) return;
          pngs.set(choice, pngUrl(out.png));
        } catch (err) {
          if (!alive) return;
          console.error('bg: could not blend the background', err);
          if (choice === chosen) failed.hidden = false;
        }
        if (choice === chosen) download.disabled = !pngs.get(choice);
      };
      const choose = (settle: number) => {
        const { choice, bg } = current();
        chosen = choice;
        pngs.choose(choice);
        colour.hidden = !options.querySelector<HTMLInputElement>('input[value=colour]')!.checked;
        showPreview(choice);
        const ready = !!pngs.get(choice);
        download.disabled = !ready;
        failed.hidden = true;
        clearTimeout(timer);
        if (!ready) timer = window.setTimeout(() => void blend(choice, bg), settle);
      };
      options.addEventListener('change', (e) => choose((e.target as HTMLElement) === colour ? COLOUR_SETTLE_MS : 0));
      colour.addEventListener('input', () => choose(COLOUR_SETTLE_MS));

      download.addEventListener('click', () => {
        const url = pngs.get(chosen);
        if (!url) return;
        const a = h('a', { href: url, download: `${base}-no-bg.png` });
        document.body.append(a);
        a.click();
        a.remove();
      });

      const note = h('p', { class: 'note' }, 'Large photo: processed at 25 MP.');
      note.hidden = !downscaled;
      showPreview('transparent');
      root.append(compare.el, options, note, failed, h('div', { class: 'actions' }, download));

      return () => {
        alive = false;
        clearTimeout(timer);
        pngs.clear();
        URL.revokeObjectURL(before);
      };
    },
  };
}
