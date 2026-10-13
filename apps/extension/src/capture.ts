/**
 * Captures the selected tab as a media stream.
 *
 * No width, height, or frame-rate constraints are applied. Constraint-driven fitting is the
 * one place Chrome may deliver a frame that does not correspond one-to-one with the tab
 * viewport, and any such frame either distorts the picture or shifts every click. Asking for
 * the tab's native surface keeps frame pixels mapped to viewport pixels.
 *
 * Bandwidth and resolution are bounded later, on the sender: `maxBitrate` limits the rate and
 * `scaleResolutionDownBy` is an integer divisor, so it is always aspect-preserving.
 */
export async function captureTabStream(streamId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    } as MediaTrackConstraints
  });
}
