import { describe, expect, it } from 'vitest';
import { FRAME_MAX_PX, frameSize } from './frame-size';

describe('frameSize', () => {
  it('pads the measured box on both sides and rounds up to whole pixels', () => {
    expect(frameSize({ width: 211.4, height: 40 })).toEqual({ width: 236, height: 64 });
  });

  it('never asks for more than the loader allows', () => {
    expect(frameSize({ width: 390, height: 500 })).toEqual({ width: FRAME_MAX_PX, height: FRAME_MAX_PX });
  });

  it('keeps an empty box hidden instead of a padded empty square', () => {
    expect(frameSize({ width: 0, height: 0 })).toEqual({ width: 0, height: 0 });
  });
});
