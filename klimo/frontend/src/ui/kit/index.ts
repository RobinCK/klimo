// Kit components: containers, inputs, feedback, data display and domain rows with inputs.
import './internal/kit.css';

// containers
export { Section, type SectionProps } from './containers/Section';
export { Accordion, type AccordionProps } from './containers/Accordion';
export { InlinePanel, type InlinePanelProps } from './containers/InlinePanel';
export {
  BottomSheet,
  ConfirmDialog,
  Dialog,
  Drawer,
  type BottomSheetProps,
  type ConfirmDialogProps,
  type DialogProps,
  type DrawerProps,
} from './containers/overlays';
export { SegmentedProgress, WizardShell, type SegmentedProgressProps, type WizardShellProps } from './containers/WizardShell';
export type { KitAction } from './internal/ActionButton';

// inputs
export {
  DurationPills,
  FilterPills,
  SegmentedControl,
  type ChoiceValue,
  type DurationPillsProps,
  type FilterPillsProps,
  type SegmentOption,
  type SegmentedControlProps,
} from './inputs/choice';
export {
  RadioCardGrid,
  RadioCardList,
  RadioValueGrid,
  type RadioCardGridOption,
  type RadioCardGridProps,
  type RadioCardListProps,
  type RadioCardOption,
  type RadioValueGridProps,
} from './inputs/radios';
export { CheckboxRow, ToggleCard, ToggleChip, type CheckboxRowProps, type ToggleCardProps, type ToggleChipProps } from './inputs/toggles';
export {
  AreaSelect,
  DateField,
  NumberField,
  Select,
  TextField,
  TimeRangeInput,
  type AreaSelectProps,
  type DateFieldProps,
  type NumberFieldProps,
  type SelectOption,
  type SelectProps,
  type TextFieldProps,
  type TimeRangeInputProps,
} from './inputs/fields';
export { Stepper, TimeStepper, type StepperProps, type TimeStepperProps } from './inputs/steppers';
export { ValuePill, type ValuePillProps } from './inputs/ValuePill';
export { EntityMultiPicker, EntityPicker, type EntityMultiPickerProps, type EntityPickerProps } from './inputs/EntityPicker';
export {
  ColorSwatchPicker,
  DayOfWeekToggle,
  DayTabs,
  IconPicker,
  MonthToggleGrid,
  type ColorSwatchPickerProps,
  type DayOfWeekToggleProps,
  type DayTabsProps,
  type IconPickerProps,
  type MonthToggleGridProps,
} from './inputs/pickers';
export { SortableList, type SortableItem, type SortableListProps } from './inputs/SortableList';
export {
  DashedAddButton,
  FileButton,
  QuickActionPill,
  TestButton,
  type DashedAddButtonProps,
  type FileButtonProps,
  type QuickActionPillProps,
  type TestButtonProps,
} from './inputs/actions';

// feedback
export { toast, undoToast, type ToastOptions } from './feedback/toast';
export {
  CountdownBar,
  PendingChangePanel,
  SyncIndicator,
  UndoBar,
  type CountdownBarProps,
  type PendingChangePanelProps,
  type SyncIndicatorProps,
  type UndoBarProps,
} from './feedback/edit';
export {
  AutosaveStatus,
  EmptyState,
  InlineConfirm,
  Skeleton,
  StateBanner,
  StatusBanner,
  type AutosaveStatusProps,
  type EmptyStateProps,
  type InlineConfirmProps,
  type SkeletonProps,
  type StateBannerProps,
  type StatusBannerProps,
} from './feedback/status';
export { AlertCard, AttentionBanner, InboxCard, type AlertCardProps, type AttentionBannerProps, type InboxCardProps } from './feedback/alerts';

// data display
export {
  CapabilityChip,
  CodeBlock,
  EntityId,
  KeyValueList,
  LegendSwatch,
  NumberedList,
  RelativeTime,
  Text,
  type CapabilityChipProps,
  type CodeBlockProps,
  type EntityIdProps,
  type KeyValueListProps,
  type KeyValueRow,
  type LegendSwatchProps,
  type RelativeTimeProps,
  type TextProps,
} from './display/text';
export {
  BigReadout,
  ConsequencePreview,
  ExplainCallout,
  StatTile,
  type BigReadoutProps,
  type ConsequencePreviewProps,
  type ExplainCalloutProps,
  type StatTileProps,
} from './display/tiles';
export { NotificationBell, SeasonPill, type NotificationBellProps, type SeasonPillProps } from './display/chrome';
export { DataTable, type DataColumn, type DataRow, type DataTableProps } from './display/DataTable';
export { RoutingMatrix, type MatrixCell, type RoutingMatrixProps } from './display/RoutingMatrix';

// domain rows with inputs
export { SensorRow, type SensorRowProps } from './rows/SensorRow';
export {
  ActionRuleCard,
  ChannelCard,
  CircuitCard,
  RuleCard,
  TriggerCard,
  type ActionRuleCardProps,
  type ChannelCardProps,
  type CircuitCardProps,
  type RuleCardProps,
  type TriggerCardProps,
} from './rows/cards';
export {
  DeviceTable,
  EntityBindingTable,
  WatchTable,
  type BindingStatus,
  type DeviceTableProps,
  type DeviceTableRow,
  type EntityBindingRow,
  type WatchRow,
} from './rows/tables';
export { ConditionEditor, type ConditionEditorProps } from './condition/ConditionEditor';

/** Gallery section of the kit for the developer page (#/dev/ui). */
export { KitGallerySection } from './gallery/KitGallerySection';
