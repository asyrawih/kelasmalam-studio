export { TimelinePanel } from './TimelinePanel';
export { ClipDetailPanel } from './ClipDetailPanel';
export { OverviewStrip, type OverviewStripProps } from './OverviewStrip';
export { LaneHeaders } from './LaneHeaders';
export { TimelineRuler, markStepFor, type TimelineRulerProps } from './TimelineRuler';
export { ClipArea, type ClipAreaProps } from './ClipArea';
export { importFileToLane, assetFromBuffer, type DropResult } from './audio-import';
export {
  drawAssetWave,
  drawClipWave,
  drawPlaceholderWave,
  clipDetailGradient,
  type WaveStyle,
} from './waveform';
export {
  fadeInGain,
  fadeOutGain,
  fadeCurveArray,
  fadeSamples,
  samplesToFadeMs,
  clampFadeMs,
  normalizeClipFade,
  fadeOverlayGradient,
  msToSec,
  secToMs,
  FADE_PRESET_SEC,
  type FadeSide,
} from './fade';
export {
  BUCKET_SIZES,
  allocColumns,
  buildEnvelope,
  envelopeBytes,
  levelFor,
  envelopePeak,
  readEnvelope,
  type Envelope,
  type EnvelopeColumns,
  type EnvelopeLevel,
  type PcmSource,
} from './envelope';
