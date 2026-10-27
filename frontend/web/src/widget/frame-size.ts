/**
 * D17 §11.5: how big the embed frame asks `public/widget.js` to make it. The frame is as
 * big as what it shows, measured — a business name or a failure sentence is as long as
 * it is. A fixed 260 × 64 cut "Talk to act-checkout 84a…" and "Try again lat…".
 */
export interface FrameSize {
  width: number;
  height: number;
}

/** Room around the button or panel inside the frame, for its shadow. The frame's `p-3`. */
export const FRAME_PADDING_PX = 12;

/** The loader never makes the frame larger than this (`public/widget.js`). */
export const FRAME_MAX_PX = 400;

export const HIDDEN_FRAME: FrameSize = { width: 0, height: 0 };

/** The frame around a measured box: whole pixels, the padding on both sides, the loader's cap. */
export function frameSize(box: FrameSize): FrameSize {
  const fit = (value: number) => (value > 0 ? Math.min(FRAME_MAX_PX, Math.ceil(value) + 2 * FRAME_PADDING_PX) : 0);
  return { width: fit(box.width), height: fit(box.height) };
}
