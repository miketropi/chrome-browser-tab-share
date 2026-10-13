import { describe, expect, it } from 'vitest';
import { containRect, denormalizePoint, normalizePoint } from './geometry';

describe('stage geometry', () => {
  it('pillarboxes a tall host viewport inside a wide stage', () => {
    const rect = containRect({ left: 0, top: 0, width: 1000, height: 500 }, 1440 / 900);
    expect(rect).not.toBeNull();
    expect(rect).toMatchObject({ left: 100, top: 0, width: 800, height: 500 });
  });

  it('letterboxes a wide host viewport inside a tall stage', () => {
    const rect = containRect({ left: 0, top: 0, width: 600, height: 900 }, 16 / 9);
    expect(rect).toMatchObject({ left: 0, top: 281.25, width: 600, height: 337.5 });
  });

  it('matches the stage exactly when aspects agree', () => {
    expect(containRect({ left: 10, top: 20, width: 800, height: 450 }, 16 / 9)).toEqual({ left: 10, top: 20, width: 800, height: 450 });
  });

  it('rejects unusable boxes and aspects', () => {
    expect(containRect({ left: 0, top: 0, width: 0, height: 100 }, 1)).toBeNull();
    expect(containRect({ left: 0, top: 0, width: 100, height: 100 }, 0)).toBeNull();
    expect(containRect({ left: 0, top: 0, width: 100, height: 100 }, Number.NaN)).toBeNull();
    expect(containRect({ left: Number.NaN, top: 0, width: 100, height: 100 }, 1)).toBeNull();
  });

  it('rejects letterbox clicks and accepts interior edges', () => {
    const rect = containRect({ left: 0, top: 0, width: 1000, height: 500 }, 1.6)!;
    expect(normalizePoint(rect, 50, 250)).toBeNull();
    expect(normalizePoint(rect, 950, 250)).toBeNull();
    expect(normalizePoint(rect, 100, 250)).toEqual({ u: 0, v: 0.5 });
    expect(normalizePoint(rect, 900, 250)).toEqual({ u: 1, v: 0.5 });
    expect(normalizePoint(rect, Number.NaN, 250)).toBeNull();
  });

  it('follows the video aspect, not the host viewport aspect, when they disagree', () => {
    // A captured frame of 960x540 (16:9) inside a stage shaped for a 1280x800 host viewport.
    // Sizing the picture to the host ratio is what stretched the image; the rectangle must
    // instead match the frame, which is also what `object-fit: contain` draws.
    const stage = { left: 0, top: 0, width: 412, height: 915 };
    const fromVideo = containRect(stage, 960 / 540)!;
    const fromHost = containRect(stage, 1280 / 800)!;
    expect(fromVideo).not.toEqual(fromHost);
    expect(fromVideo.width / fromVideo.height).toBeCloseTo(960 / 540, 9);
    expect(fromHost.width / fromHost.height).toBeCloseTo(1280 / 800, 9);
    expect(fromVideo).toMatchObject({ left: 0, width: 412, height: 231.75 });
  });

  it('keeps normalized coordinates aligned with pixels when aspects disagree', () => {
    // Mapping is normalized over the drawn frame, so the host converts with its own extents
    // and a click still lands on the pixel it was aimed at.
    const stage = { left: 0, top: 0, width: 412, height: 915 };
    const rect = containRect(stage, 960 / 540)!;
    const host = { width: 1295, height: 800 };
    for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const rectCentreY = rect.top + rect.height / 2;
      const point = normalizePoint(rect, rect.left + rect.width * fraction, rectCentreY)!;
      expect(point.u).toBeCloseTo(fraction, 9);
      expect(point.v).toBeCloseTo(0.5, 9);
      expect(point.u * host.width).toBeCloseTo(fraction * host.width, 9);
      expect(point.v * host.height).toBeCloseTo(400, 9);
    }
  });

  it('rejects clicks in the letterbox created by a mismatched frame', () => {
    const stage = { left: 0, top: 0, width: 412, height: 915 };
    const rect = containRect(stage, 960 / 540)!;
    expect(normalizePoint(rect, 206, 10)).toBeNull();
    expect(normalizePoint(rect, 206, rect.top + rect.height / 2)).not.toBeNull();
  });

  it('round-trips a stage point through the host viewport without drift', () => {
    const rect = containRect({ left: 0, top: 0, width: 1000, height: 500 }, 1.6)!;
    const host = { width: 1440, height: 900 };
    for (const point of [
      { x: 100, y: 0 },
      { x: 500, y: 250 },
      { x: 900, y: 500 },
      { x: 123.456, y: 78.9 }
    ]) {
      const normalized = normalizePoint(rect, point.x, point.y)!;
      const back = denormalizePoint(rect, normalized.u, normalized.v);
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
      expect(normalized.u * host.width).toBeGreaterThanOrEqual(0);
      expect(normalized.u * host.width).toBeLessThanOrEqual(host.width);
      expect(normalized.v * host.height).toBeLessThanOrEqual(host.height);
    }
  });

  it('maps a stage point to the same normalized position the host would report', () => {
    const rect = containRect({ left: 0, top: 0, width: 1000, height: 500 }, 1.6)!;
    const normalized = normalizePoint(rect, 500, 250)!;
    expect(normalized.u * 1440).toBeCloseTo(720, 9);
    expect(normalized.v * 900).toBeCloseTo(450, 9);
  });
});
