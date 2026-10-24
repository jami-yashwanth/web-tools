// A before/after comparison: two images of the same size stacked, the "before" one shown left of a divider the
// reader drags, or moves with the arrow keys (it is an ARIA slider). Used by Remove background and Upscale.

const STEP = 5;
const PAGE = 20;

/** Where a key moves the divider (0 to 100), or null for a key the slider doesn't handle. */
export function stepPosition(value: number, key: string): number | null {
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(value - STEP);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(value + STEP);
    case 'PageDown':
      return clamp(value - PAGE);
    case 'PageUp':
      return clamp(value + PAGE);
    case 'Home':
      return 0;
    case 'End':
      return 100;
    default:
      return null;
  }
}

/** The divider position (0 to 100, whole numbers) for a pointer at `clientX` over a box. */
export function positionFromPointer(clientX: number, box: { left: number; width: number }): number {
  if (!(box.width > 0)) return 50;
  return Math.round(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)));
}

export interface Compare {
  el: HTMLElement;
  /** The layer behind the "after" image: its background shows through transparent pixels. */
  stage: HTMLElement;
  after: HTMLImageElement;
}

/**
 * Build the comparison. `width` × `height` is the images' shape (both have it); the box keeps it, so the two
 * layers and the divider line up at any size.
 */
export function createCompare(
  before: { src: string; alt: string },
  after: { src: string; alt: string },
  width: number,
  height: number,
): Compare {
  const el = document.createElement('div');
  el.className = 'compare';
  el.style.setProperty('--ratio', `${width} / ${height}`);
  el.style.setProperty('--w', String(width));
  el.style.setProperty('--h', String(height));

  const stage = document.createElement('div');
  stage.className = 'compare-stage';
  const afterImg = Object.assign(document.createElement('img'), { src: after.src, alt: after.alt, draggable: false });
  stage.append(afterImg);
  const beforeImg = Object.assign(document.createElement('img'), { src: before.src, alt: before.alt, draggable: false });
  beforeImg.className = 'compare-before';

  const handle = document.createElement('div');
  handle.className = 'compare-handle';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'slider');
  handle.setAttribute('aria-label', 'Compare before and after');
  handle.setAttribute('aria-valuemin', '0');
  handle.setAttribute('aria-valuemax', '100');
  handle.setAttribute('aria-orientation', 'horizontal');

  let pos = 50;
  const set = (v: number) => {
    pos = v;
    el.style.setProperty('--pos', `${v}%`);
    handle.setAttribute('aria-valuenow', String(v));
    handle.setAttribute('aria-valuetext', `${v}% before`);
  };
  set(50);

  handle.addEventListener('keydown', (e) => {
    const next = stepPosition(pos, e.key);
    if (next === null) return;
    e.preventDefault();
    set(next);
  });

  // Drag anywhere on the image (the divider jumps to the pointer), or on the handle.
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    el.setPointerCapture(e.pointerId);
    set(positionFromPointer(e.clientX, el.getBoundingClientRect()));
    handle.focus({ preventScroll: true });
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging) set(positionFromPointer(e.clientX, el.getBoundingClientRect()));
  });
  const stop = () => (dragging = false);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);

  el.append(stage, beforeImg, handle);
  return { el, stage, after: afterImg };
}
