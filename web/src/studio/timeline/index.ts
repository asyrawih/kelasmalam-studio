export { TimelinePanel } from './TimelinePanel';
export { ClipDetailPanel } from './ClipDetailPanel';
export { DetailSection } from './DetailSection';
export { BeatBar } from './BeatBar';
export { BeatProvider, useBeatShared, fallbackClip, type BeatShared, type ShownClip } from './beat-context';
export {
  BeatControls,
  BeatOverlay,
  LoopRegionPicker,
  useBeatState,
  LOOP_BAR_PRESETS,
  MIN_LOOP_BARS,
  MAX_LOOP_BARS,
  ZOOM_BAR_PRESETS,
  formatBars,
  type BeatState,
  type BeatZoom,
} from './BeatSection';
export { ScrollingWave, type ScrollingWaveProps } from './ScrollingWave';
export { drawBeatGrid, drawPlayhead } from './beat-draw';
export { StemSection } from './StemSection';
export { bakeClipStem, type BakeResult } from './stem-bake';
export { normalizeClipStem, stemOf, stemSummary, STEM_LABELS } from './stem';
export {
  applyLoopCut,
  clampLoopSpec,
  MAX_LOOP_REPEAT,
  type ClampedRegion,
  type LoopCutSpec,
} from './beat-cut';
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
