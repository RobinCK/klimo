// Charts, plant diagram and meters (bespoke SVG, no chart library).
export { Sparkline, type SparklineProps } from './charts/Sparkline';
export { DayChart, HOUR_AXIS_3H, type DayChartProps, type DayChartSpan, type DayChartTarget } from './charts/DayChart';
export {
  RuntimeBar24h,
  Timeline24h,
  type RuntimeBar24hProps,
  type Timeline24hProps,
  type TimelineSpan,
  type TimelineTrack,
} from './charts/Timeline24h';
export { HOUR_AXIS_6H, ProfileStrip, type ProfileStripProps, type ProfileStripSegment } from './charts/ProfileStrip';
export {
  DayTimelineVertical,
  WeekTimeline,
  type DayTimelineBlock,
  type DayTimelineVerticalProps,
  type ScheduleBlock,
  type WeekTimelineDay,
  type WeekTimelineProps,
} from './charts/WeekTimeline';
export { BivalenceChart, type BivalenceChartProps, type BivalenceTrack } from './charts/BivalenceChart';
export { WeatherCurveChart, type CurvePoint, type WeatherCurveChartProps } from './charts/WeatherCurveChart';
export {
  BatteryBar,
  ComfortBar,
  SignalBars,
  ToleranceBar,
  type BatteryBarProps,
  type ComfortBarProps,
  type SignalBarsProps,
  type ToleranceBarProps,
} from './meters/meters';
export { PlantDiagram, type PlantDiagramProps } from './plant/PlantDiagram';
export {
  EnergyStrip,
  LoopTile,
  PlantNodeCard,
  RowList,
  SourceRow,
  type EnergyStripProps,
  type LoopTileProps,
  type NodeTone,
  type PlantNodeCardProps,
  type SourceRowProps,
} from './plant/parts';
export type { VizColor } from './internal/util';
export { VizGallerySection } from './gallery/VizGallerySection';
