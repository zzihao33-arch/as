import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert as ArcoAlert,
  Button as ArcoButton,
  Card as ArcoCard,
  DatePicker as ArcoDatePicker,
  Empty,
  Input as ArcoInput,
  Select as ArcoSelect,
  Table as ArcoTable,
  Typography
} from '@arco-design/web-react';
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileCheck2,
  FileText,
  Printer,
  RotateCcw,
  Save,
  Truck
} from 'lucide-react';
import bolTemplateUrl from './assets/bol-template-figma.svg';

const BOL_STORAGE_KEY = 'cmhub-bol-records-v1';
const MAX_BOL_RECORDS = 5;

type BolStage = 'list' | 'edit' | 'confirm' | 'output';
type QuantityField = 'packages' | 'boxes' | 'pallets';
type ChannelQuantityValues = Record<QuantityField, string>;

interface BolChannel {
  id: string;
  name: string;
  defaultLoadType: 'Packages' | 'Boxes' | 'Pallets';
}

interface BolForm {
  bolNo: string;
  channelIds: string[];
  activeChannelId?: string;
  channelQuantities?: Record<string, ChannelQuantityValues>;
  channelId?: string;
  packages: string;
  boxes: string;
  pallets: string;
  pickupAt: string;
}

interface BolRecord extends BolForm {
  id: string;
  status: 'generated';
  version: number;
  createdAt: string;
  updatedAt: string;
  printCount: number;
  renderedHtml: string;
}

interface BolErrors {
  bolNo?: string;
  channelId?: string;
  pickupAt?: string;
  quantities?: string;
}

const BOL_CHANNELS: BolChannel[] = [
  { id: 'gofo', name: 'GOFO', defaultLoadType: 'Boxes' },
  { id: 'ywe', name: 'YWE', defaultLoadType: 'Packages' },
  { id: 'uniuni', name: 'UniUni', defaultLoadType: 'Boxes' },
  { id: 'speedx', name: 'SpeedX', defaultLoadType: 'Boxes' },
  { id: 'swiftx', name: 'SwiftX', defaultLoadType: 'Boxes' },
  { id: 'usps', name: 'USPS', defaultLoadType: 'Boxes' },
  { id: 'ups', name: 'UPS', defaultLoadType: 'Boxes' },
  { id: 'fedex', name: 'Fedex', defaultLoadType: 'Packages' },
  { id: 'dhl', name: 'DHL', defaultLoadType: 'Boxes' }
];

const quantityFields: Array<{ key: QuantityField; label: string; shortLabel: string; placeholder: string }> = [
  { key: 'packages', label: '包裹数', shortLabel: '包裹', placeholder: 'Packages' },
  { key: 'boxes', label: '箱数', shortLabel: '箱', placeholder: 'Boxes' },
  { key: 'pallets', label: '板数', shortLabel: '板', placeholder: 'Pallets' }
];

const weekDayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const hourOptions = Array.from({ length: 12 }, (_, index) => index + 1);
const minuteOptions = Array.from({ length: 60 }, (_, index) => index);

function createEmptyQuantityValues(): ChannelQuantityValues {
  return {
    packages: '',
    boxes: '',
    pallets: ''
  };
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function getDefaultPickupAt() {
  const nextPickup = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return `${nextPickup.getFullYear()}-${pad(nextPickup.getMonth() + 1)}-${pad(nextPickup.getDate())}T${pad(nextPickup.getHours())}:${pad(nextPickup.getMinutes())}`;
}

function createEmptyForm(): BolForm {
  const defaultChannelId = BOL_CHANNELS[0].id;

  return {
    bolNo: '',
    channelIds: [defaultChannelId],
    channelId: defaultChannelId,
    activeChannelId: defaultChannelId,
    channelQuantities: {
      [defaultChannelId]: createEmptyQuantityValues()
    },
    packages: '',
    boxes: '',
    pallets: '',
    pickupAt: getDefaultPickupAt()
  };
}

function getRecordTimestamp(record: BolRecord) {
  const timestamp = Date.parse(record.updatedAt || record.createdAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function keepLatestBolRecords(records: BolRecord[]) {
  return [...records]
    .sort((left, right) => getRecordTimestamp(right) - getRecordTimestamp(left))
    .slice(0, MAX_BOL_RECORDS);
}

function safeParseRecords(raw: string | null): BolRecord[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Keep only the supported persisted schema when records are read. This
    // also clears any retired, unknown fields from older browser storage.
    const normalizedRecords = parsed.map(record => {
      const stored = record as BolRecord;
      return {
        id: stored.id,
        status: stored.status,
        version: stored.version,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        printCount: stored.printCount,
        renderedHtml: stored.renderedHtml,
        bolNo: stored.bolNo,
        channelIds: stored.channelIds,
        activeChannelId: stored.activeChannelId,
        channelQuantities: stored.channelQuantities,
        channelId: stored.channelId,
        packages: stored.packages,
        boxes: stored.boxes,
        pallets: stored.pallets,
        pickupAt: stored.pickupAt
      } satisfies BolRecord;
    });
    return keepLatestBolRecords(normalizedRecords);
  } catch {
    return [];
  }
}

function parseQuantity(value: string) {
  if (value.trim() === '') return 0;
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : Number.NaN;
}

function formatInteger(value: string) {
  const parsed = parseQuantity(value);
  if (!Number.isFinite(parsed) || parsed === 0) return '';
  return parsed.toLocaleString('en-US');
}

function formatPickupTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未填写';

  const month = date.toLocaleString('en-US', { month: 'short' });
  return `${month} ${pad(date.getDate())}, ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parsePickupDate(value: string) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

function toDateTimeInputValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getHour12(date: Date) {
  const hour = date.getHours() % 12;
  return hour === 0 ? 12 : hour;
}

function getMeridiem(date: Date) {
  return date.getHours() >= 12 ? 'PM' : 'AM';
}

function formatDateTimePickerLabel(value: string) {
  const date = parsePickupDate(value);
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(getHour12(date))}:${pad(date.getMinutes())} ${getMeridiem(date)}`;
}

function getMonthLabel(date: Date) {
  return `${date.toLocaleString('en-US', { month: 'long' })} ${date.getFullYear()}`;
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function isSameCalendarDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function getCalendarDays(displayMonth: Date) {
  const firstDayOfMonth = new Date(displayMonth.getFullYear(), displayMonth.getMonth(), 1);
  const firstGridDay = new Date(
    displayMonth.getFullYear(),
    displayMonth.getMonth(),
    1 - firstDayOfMonth.getDay()
  );

  return Array.from({ length: 42 }, (_, index) => (
    new Date(firstGridDay.getFullYear(), firstGridDay.getMonth(), firstGridDay.getDate() + index)
  ));
}

function getNormalizedChannelIds(form: Pick<BolForm, 'channelIds' | 'channelId'>) {
  const sourceIds = Array.isArray(form.channelIds) && form.channelIds.length > 0
    ? form.channelIds
    : form.channelId
      ? [form.channelId]
      : [];
  const validChannelIds = new Set(BOL_CHANNELS.map(channel => channel.id));

  return Array.from(new Set(sourceIds)).filter(channelId => validChannelIds.has(channelId));
}

function getSelectedChannels(form: Pick<BolForm, 'channelIds' | 'channelId'>) {
  const selectedIds = getNormalizedChannelIds(form);
  return selectedIds
    .map(channelId => BOL_CHANNELS.find(channel => channel.id === channelId))
    .filter((channel): channel is BolChannel => Boolean(channel));
}

function formatChannelNames(form: Pick<BolForm, 'channelIds' | 'channelId'>) {
  const channels = getSelectedChannels(form);
  return channels.length > 0 ? channels.map(channel => channel.name).join('、') : '未选择';
}

function normalizeQuantityValues(values?: Partial<ChannelQuantityValues>): ChannelQuantityValues {
  return {
    packages: values?.packages ?? '',
    boxes: values?.boxes ?? '',
    pallets: values?.pallets ?? ''
  };
}

function getLegacyQuantityValues(form: Pick<BolForm, QuantityField>): ChannelQuantityValues {
  return normalizeQuantityValues({
    packages: form.packages,
    boxes: form.boxes,
    pallets: form.pallets
  });
}

function hasSavedChannelQuantities(form: Pick<BolForm, 'channelQuantities'>) {
  return Boolean(
    form.channelQuantities
      && typeof form.channelQuantities === 'object'
      && Object.keys(form.channelQuantities).length > 0
  );
}

function getQuantityValuesForChannel(
  form: Pick<BolForm, 'channelQuantities' | 'packages' | 'boxes' | 'pallets'>,
  channelId: string
): ChannelQuantityValues {
  const savedValues = form.channelQuantities?.[channelId];
  if (savedValues) return normalizeQuantityValues(savedValues);

  if (!hasSavedChannelQuantities(form)) {
    return getLegacyQuantityValues(form);
  }

  return createEmptyQuantityValues();
}

function getNormalizedChannelQuantityMap(form: BolForm) {
  return getNormalizedChannelIds(form).reduce<Record<string, ChannelQuantityValues>>((quantityMap, channelId) => {
    quantityMap[channelId] = getQuantityValuesForChannel(form, channelId);
    return quantityMap;
  }, {});
}

function getActiveChannelId(form: BolForm) {
  const selectedIds = getNormalizedChannelIds(form);
  if (form.activeChannelId && selectedIds.includes(form.activeChannelId)) {
    return form.activeChannelId;
  }
  return selectedIds[0] ?? '';
}

function getQuantitySummaryParts(values: ChannelQuantityValues) {
  return quantityFields.flatMap(field => {
    const parsed = parseQuantity(values[field.key]);
    return Number.isFinite(parsed) && parsed > 0 ? [`${field.shortLabel} ${parsed.toLocaleString('en-US')}`] : [];
  });
}

function formatQuantitySummary(form: BolForm) {
  const selectedChannels = getSelectedChannels(form);
  if (selectedChannels.length === 0) return '全部为 0';

  return selectedChannels.map(channel => {
    const quantityParts = getQuantitySummaryParts(getQuantityValuesForChannel(form, channel.id));
    return `${channel.name}: ${quantityParts.length > 0 ? quantityParts.join(' / ') : '0'}`;
  }).join('；');
}

function validateBolForm(form: BolForm, records: BolRecord[], editingId?: string): BolErrors {
  const errors: BolErrors = {};
  const normalizedBolNo = normalizeBolNumber(form.bolNo).toLowerCase();

  if (!normalizedBolNo) {
    errors.bolNo = '请输入 BOL 单号';
  } else if (records.some(record => record.id !== editingId && normalizeBolNumber(record.bolNo).toLowerCase() === normalizedBolNo)) {
    errors.bolNo = '该 BOL 单号已生成，不能重复保存';
  }

  if (getNormalizedChannelIds(form).length === 0) {
    errors.channelId = '请至少选择一个渠道';
  }

  if (!form.pickupAt || Number.isNaN(new Date(form.pickupAt).getTime())) {
    errors.pickupAt = '请选择有效的提货时间';
  }

  const invalidQuantity = getNormalizedChannelIds(form).some(channelId => {
    const channelQuantities = getQuantityValuesForChannel(form, channelId);
    return quantityFields.some(field => {
      const value = channelQuantities[field.key];
      return value.trim() !== '' && (!Number.isInteger(Number(value)) || Number(value) < 0);
    });
  });
  if (invalidQuantity) {
    errors.quantities = '包裹数、箱数、板数可留空；如填写必须为 0 或正整数';
  }

  return errors;
}

function isBolValid(errors: BolErrors) {
  return Object.keys(errors).length === 0;
}

function formatFigmaReceiptParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { date: 'AUG 11’26', meridiem: 'AM', time: '19:24' };
  }

  return {
    date: `${date.toLocaleString('en-US', { month: 'short' }).toUpperCase()} ${pad(date.getDate())}’${String(date.getFullYear()).slice(-2)}`,
    meridiem: date.getHours() < 12 ? 'AM' : 'PM',
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`
  };
}

const bolQuantityCells: Record<QuantityField, { left: number; right: number; textX: number }> = {
  packages: { left: 171.974, right: 305.224, textX: 190.606 },
  boxes: { left: 305.224, right: 438.474, textX: 323.84 },
  pallets: { left: 438.474, right: 572, textX: 457.105 }
};

// The exported Figma SVG contains several baked-in sample quantities whose
// paths do not line up with the grid. Rebuild this small, fixed table on the
// canvas so the printable result has exactly one source of truth for every
// row and column.
const bolRoutingTable = {
  left: 39,
  right: 572,
  titleTop: 304.724,
  headerTop: 344.724,
  headerBottom: 369.724,
  bottom: 592.724,
  columns: [171.974, 305.224, 438.474]
} as const;

const bolRoutingRows: Array<{ id: string; label: string; top: number; bottom: number }> = [
  { id: 'gofo', label: 'GOFO', top: 369.724, bottom: 393.724 },
  { id: 'ywe', label: 'YWE', top: 393.724, bottom: 417.724 },
  { id: 'uniuni', label: 'UniUni', top: 417.724, bottom: 442.724 },
  { id: 'speedx', label: 'SpeedX', top: 442.724, bottom: 467.724 },
  { id: 'swiftx', label: 'SwiftX', top: 467.724, bottom: 491.724 },
  { id: 'usps', label: 'USPS', top: 491.724, bottom: 516.724 },
  { id: 'ups', label: 'UPS', top: 516.724, bottom: 543.724 },
  { id: 'fedex', label: 'Fedex', top: 543.724, bottom: 568.724 },
  { id: 'dhl', label: 'DHL', top: 568.724, bottom: 592.724 }
];

const BOL_NUMBER_LINE_LENGTH = 25;
const BOL_NUMBER_LINE_HEIGHT = 9;
const BOL_NUMBER_MAX_LINES = 4;

// The Figma source is a flattened SVG which still contains example values.
// These masks remove only those sample values before live BOL data is rendered.
const figmaTemplateStaticMasks = [
  // The flattened Figma SVG contains a sample BOL number. Reserve the entire
  // value region because live BOL numbers may wrap over multiple lines.
  { x: 57, y: 261, width: 238, height: 42 },
  // The Figma sample timestamp uses a fractal-noise filter. Cover the entire
  // sample filter bounds before drawing the selected pickup timestamp.
  { x: 448, y: 722, width: 118, height: 20 }
];

const BOL_TEMPLATE_WIDTH = 612;
const BOL_TEMPLATE_HEIGHT = 792;
const BOL_OUTPUT_SCALE = 300 / 72;

// These are the fixed ink colors from the approved BOL template. They are used
// only inside the isolated canvas used for PDF/browser-print output, so that
// application theme styles cannot leak into the document artifact.
const BOL_OUTPUT_COLORS = {
  paper: 'rgb(255, 255, 255)',
  ink: 'rgb(0, 0, 0)',
  timestamp: 'rgb(191, 191, 191)'
} as const;

function loadImageFromSource(source: string, errorMessage: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(errorMessage));
    image.src = source;
  });
}

function loadBolTemplateImage() {
  return loadImageFromSource(bolTemplateUrl, 'BOL 模板加载失败，请刷新后重试');
}

function drawCellCenteredText(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  top: number,
  bottom: number
) {
  // `actualBoundingBox*` differs between the bundled font and a browser
  // fallback while fonts are resolving. Canvas' middle baseline is stable in
  // both cases, so every fixed label and every number shares the same cell
  // centre instead of the first table row drifting toward its upper border.
  context.textBaseline = 'middle';
  context.fillText(value, x, (top + bottom) / 2);
}

function normalizeBolNumber(value: string) {
  const segments = value.trim().split(/\s+/).filter(Boolean);
  // Preserve separators for the standard BOL segments users paste from the
  // shipping system, while stripping display-only wraps from a continuous
  // scanner payload.
  if (segments.length > 1 && segments.every(isBolNumberSegment)) {
    return segments.join(' ');
  }

  return value.replace(/[\r\n]+/g, '').trim();
}

function isBolNumberSegment(value: string) {
  return /^\d{3}-\d{8}$/.test(value);
}

function formatBolNumberInput(value: string) {
  const segments = value.trim().split(/\s+/).filter(Boolean);
  // A four-line clipboard payload such as 994-30289630 / 936-02735880 is
  // displayed as two grouped lines, with one real space between each pair.
  if (segments.length > 1 && segments.every(isBolNumberSegment)) {
    return Array.from(
      { length: Math.ceil(segments.length / 2) },
      (_, lineIndex) => segments.slice(lineIndex * 2, (lineIndex + 1) * 2).join(' ')
    ).join('\n');
  }

  const characters = Array.from(value.replace(/[\r\n]+/g, ''));
  return Array.from(
    { length: Math.ceil(characters.length / BOL_NUMBER_LINE_LENGTH) },
    (_, lineIndex) => characters
      .slice(lineIndex * BOL_NUMBER_LINE_LENGTH, (lineIndex + 1) * BOL_NUMBER_LINE_LENGTH)
      .join('')
  ).join('\n');
}

function splitBolNumberForOutput(value: string) {
  const normalizedValue = normalizeBolNumber(value) || '—';
  const lines = formatBolNumberInput(normalizedValue).split('\n');

  if (lines.length <= BOL_NUMBER_MAX_LINES) {
    return lines;
  }

  return [
    ...lines.slice(0, BOL_NUMBER_MAX_LINES - 1),
    `${lines[BOL_NUMBER_MAX_LINES - 1].slice(0, BOL_NUMBER_LINE_LENGTH - 1)}…`
  ];
}

function drawBolRoutingTable(context: CanvasRenderingContext2D, form: BolForm) {
  context.save();
  context.fillStyle = BOL_OUTPUT_COLORS.paper;
  context.fillRect(
    bolRoutingTable.left,
    bolRoutingTable.titleTop,
    bolRoutingTable.right - bolRoutingTable.left,
    bolRoutingTable.bottom - bolRoutingTable.titleTop
  );

  context.strokeStyle = 'rgb(205, 205, 205)';
  context.lineWidth = 0.5;
  const horizontalLines = [
    bolRoutingTable.titleTop,
    bolRoutingTable.headerTop,
    bolRoutingTable.headerBottom,
    ...bolRoutingRows.map(row => row.bottom)
  ];
  horizontalLines.forEach(y => {
    context.beginPath();
    context.moveTo(bolRoutingTable.left, y);
    context.lineTo(bolRoutingTable.right, y);
    context.stroke();
  });

  bolRoutingTable.columns.forEach(x => {
    context.beginPath();
    context.moveTo(x, bolRoutingTable.headerTop);
    context.lineTo(x, bolRoutingTable.bottom);
    context.stroke();
  });

  context.fillStyle = BOL_OUTPUT_COLORS.ink;
  context.textBaseline = 'top';
  context.font = '400 11px "IBM Plex Mono"';
  context.fillText('ROUTING & TRANSPORT DETAILS', 57, 327);

  context.font = '400 8px "IBM Plex Mono"';
  context.fillText('Logistics Provider', 57, 353);
  context.fillText('Packages', bolQuantityCells.packages.textX, 353);
  context.fillText('Boxes', bolQuantityCells.boxes.textX, 353);
  context.fillText('Pallets', bolQuantityCells.pallets.textX, 353);

  context.font = '400 9px "IBM Plex Mono"';
  bolRoutingRows.forEach(row => {
    drawCellCenteredText(context, row.label, 57, row.top, row.bottom);
  });

  // Keep quantity values on the same geometric center as their row label.
  // The table is redrawn from coordinates above, so no SVG sample glyph can
  // remain in a header cell or bleed across the row boundary.
  context.font = '400 10px "IBM Plex Mono"';
  getSelectedChannels(form).forEach(channel => {
    const row = bolRoutingRows.find(tableRow => tableRow.id === channel.id);
    if (!row) return;

    const quantities = getQuantityValuesForChannel(form, channel.id);
    quantityFields.forEach(field => {
      const value = formatInteger(quantities[field.key]);
      if (value) {
        drawCellCenteredText(
          context,
          value,
          bolQuantityCells[field.key].textX,
          row.top,
          row.bottom
        );
      }
    });
  });
  context.restore();
}

/**
 * Produces a self-contained Letter canvas from the original Figma SVG.  This
 * deliberately avoids DOM screenshotting: html2canvas parses every stylesheet
 * in the host application and fails on newer CSS color() functions.
 */
async function renderBolOutputCanvas(form: BolForm, scale = BOL_OUTPUT_SCALE) {
  if ('fonts' in document) {
    // IBM Plex Mono is bundled as WOFF2 by @fontsource (see src/main.tsx).
    // Wait for the exact output roles before rasterizing so PDF/browser print
    // receives their glyph pixels and never depends on a printer PC font.
    await Promise.all([
      document.fonts.load('400 8px "IBM Plex Mono"'),
      document.fonts.load('400 10px "IBM Plex Mono"'),
      document.fonts.ready
    ]);
  }

  const templateImage = await loadBolTemplateImage();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(BOL_TEMPLATE_WIDTH * scale);
  canvas.height = Math.round(BOL_TEMPLATE_HEIGHT * scale);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('浏览器无法创建 BOL 导出画布');
  }

  context.save();
  context.scale(canvas.width / BOL_TEMPLATE_WIDTH, canvas.height / BOL_TEMPLATE_HEIGHT);
  context.fillStyle = BOL_OUTPUT_COLORS.paper;
  context.fillRect(0, 0, BOL_TEMPLATE_WIDTH, BOL_TEMPLATE_HEIGHT);
  context.drawImage(templateImage, 0, 0, BOL_TEMPLATE_WIDTH, BOL_TEMPLATE_HEIGHT);

  context.fillStyle = BOL_OUTPUT_COLORS.paper;
  figmaTemplateStaticMasks.forEach(mask => {
    context.fillRect(mask.x, mask.y, mask.width, mask.height);
  });

  context.textBaseline = 'top';
  context.fillStyle = BOL_OUTPUT_COLORS.ink;
  // Canvas logical units match the 612 × 792 Figma frame. Use px here (not
  // CSS pt), otherwise each dynamic value becomes 33% larger than the vector
  // template once the Letter page is scaled for screen or print.
  // BOL number: IBM Plex Mono Regular, 8px — matches the approved template.
  context.font = '400 8px "IBM Plex Mono"';
  splitBolNumberForOutput(form.bolNo).forEach((line, index) => {
    context.fillText(line, 57, 263 + index * BOL_NUMBER_LINE_HEIGHT);
  });

  drawBolRoutingTable(context, form);

  const receipt = formatFigmaReceiptParts(form.pickupAt);
  context.textBaseline = 'top';
  context.fillStyle = BOL_OUTPUT_COLORS.timestamp;
  context.filter = `blur(${0.15 * scale}px)`;
  context.font = '500 11.678px Inter, Arial, sans-serif';
  context.fillText(receipt.date, 452, 726);
  context.font = '400 8.5px Inter, Arial, sans-serif';
  context.fillText(receipt.meridiem, 511, 729.024);
  context.font = '500 11.678px Inter, Arial, sans-serif';
  context.fillText(receipt.time, 531, 726);
  context.filter = 'none';
  context.restore();

  return canvas;
}

function BolDateTimePicker({
  value,
  onChange,
  hasError = false
}: {
  value: string;
  onChange: (value: string) => void;
  hasError?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedDate = useMemo(() => parsePickupDate(value), [value]);
  const [isOpen, setIsOpen] = useState(false);
  const [displayMonth, setDisplayMonth] = useState(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1)
  );

  useEffect(() => {
    if (isOpen) {
      setDisplayMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
    }
  }, [isOpen, selectedDate]);

  useEffect(() => {
    const closePicker = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', closePicker);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('mousedown', closePicker);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const updateDateTime = (updater: (current: Date) => Date) => {
    const nextDate = updater(new Date(selectedDate));
    onChange(toDateTimeInputValue(nextDate));
  };

  const chooseDay = (day: Date) => {
    updateDateTime(current => {
      current.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
      return current;
    });
  };

  const chooseHour = (hour12: number) => {
    updateDateTime(current => {
      const isPm = current.getHours() >= 12;
      current.setHours((hour12 % 12) + (isPm ? 12 : 0));
      return current;
    });
  };

  const chooseMinute = (minute: number) => {
    updateDateTime(current => {
      current.setMinutes(minute);
      return current;
    });
  };

  const chooseMeridiem = (meridiem: 'AM' | 'PM') => {
    updateDateTime(current => {
      current.setHours((getHour12(current) % 12) + (meridiem === 'PM' ? 12 : 0));
      return current;
    });
  };

  const calendarDays = getCalendarDays(displayMonth);
  const currentHour12 = getHour12(selectedDate);
  const currentMinute = selectedDate.getMinutes();
  const currentMeridiem = getMeridiem(selectedDate);

  return (
    <div ref={rootRef} className="relative mt-2">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(open => !open)}
        className={`flex w-full items-center justify-between rounded-2xl border bg-dark-bg/80 px-4 py-3 text-left outline-none transition-all ${
          hasError
            ? 'border-red-400/70 ring-4 ring-red-400/10'
            : 'border-brand-green/80 shadow-sm shadow-brand-green/20 hover:border-brand-green focus:border-brand-green focus:ring-4 focus:ring-brand-green/15'
        }`}
      >
        <span className="flex items-center gap-3">
          <Clock className="h-5 w-5 text-brand-green" />
          <span>
            <span className="block text-lg font-black leading-tight text-text-primary">
              {formatDateTimePickerLabel(value)}
            </span>
            <span className="mt-1 block text-xs font-semibold text-text-secondary/60">提货时间</span>
          </span>
        </span>
        <CalendarDays className="h-5 w-5 text-text-secondary/80" />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-40 mt-3 w-[540px] max-w-[calc(100vw-2rem)] rounded-2xl border border-brand-green/60 bg-dark-bg/95 p-4 shadow-2xl shadow-brand-green/20 backdrop-blur-xl">
          <div className="grid gap-4 md:grid-cols-[1.08fr_0.92fr]">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-3 flex items-center justify-between">
                <button
                  type="button"
                  aria-label="上个月"
                  onClick={() => setDisplayMonth(current => addMonths(current, -1))}
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary hover:bg-brand-green/10 hover:text-brand-green transition-colors"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <div className="text-sm font-black text-text-primary">{getMonthLabel(displayMonth)}</div>
                <button
                  type="button"
                  aria-label="下个月"
                  onClick={() => setDisplayMonth(current => addMonths(current, 1))}
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary hover:bg-brand-green/10 hover:text-brand-green transition-colors"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1 text-center">
                {weekDayLabels.map(day => (
                  <div key={day} className="py-1 text-[11px] font-black text-text-secondary/70">{day}</div>
                ))}
                {calendarDays.map(day => {
                  const isSelected = isSameCalendarDay(day, selectedDate);
                  const isCurrentMonth = day.getMonth() === displayMonth.getMonth();
                  const isToday = isSameCalendarDay(day, new Date());

                  return (
                    <button
                      key={day.toISOString()}
                      type="button"
                      onClick={() => chooseDay(day)}
                      className={`flex h-9 items-center justify-center rounded-xl text-sm font-bold transition-all ${
                        isSelected
                          ? 'bg-brand-green text-black shadow-lg shadow-brand-green/30'
                          : isCurrentMonth
                            ? 'text-text-primary hover:bg-brand-green/10 hover:text-brand-green'
                            : 'text-text-secondary/35 hover:bg-white/5 hover:text-text-secondary'
                      } ${isToday && !isSelected ? 'ring-1 ring-brand-green/30' : ''}`}
                    >
                      {day.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-black text-text-primary">时间</span>
                <button
                  type="button"
                  onClick={() => {
                    updateDateTime(() => new Date(Date.now() + 2 * 60 * 60 * 1000));
                    setDisplayMonth(addMonths(new Date(), 0));
                  }}
                  className="rounded-full bg-brand-green/10 px-3 py-1 text-xs font-bold text-brand-green hover:bg-brand-green/20 transition-colors"
                >
                  默认 +2h
                </button>
              </div>

              <div className="grid grid-cols-[1fr_1fr_1.15fr] gap-2">
                <div>
                  <div className="mb-2 text-center text-[11px] font-black uppercase tracking-wide text-text-secondary/60">Hour</div>
                  <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                    {hourOptions.map(hour => (
                      <button
                        key={hour}
                        type="button"
                        onClick={() => chooseHour(hour)}
                        className={`w-full rounded-xl px-2 py-2 text-sm font-black transition-all ${
                          hour === currentHour12
                            ? 'bg-brand-green text-black'
                            : 'text-text-primary hover:bg-brand-green/10 hover:text-brand-green'
                        }`}
                      >
                        {pad(hour)}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-center text-[11px] font-black uppercase tracking-wide text-text-secondary/60">Min</div>
                  <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                    {minuteOptions.map(minute => (
                      <button
                        key={minute}
                        type="button"
                        onClick={() => chooseMinute(minute)}
                        className={`w-full rounded-xl px-2 py-2 text-sm font-black transition-all ${
                          minute === currentMinute
                            ? 'bg-brand-green text-black'
                            : 'text-text-primary hover:bg-brand-green/10 hover:text-brand-green'
                        }`}
                      >
                        {pad(minute)}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-center text-[11px] font-black uppercase tracking-wide text-text-secondary/60">Mode</div>
                  <div className="space-y-2">
                    {(['AM', 'PM'] as const).map(meridiem => (
                      <button
                        key={meridiem}
                        type="button"
                        onClick={() => chooseMeridiem(meridiem)}
                        className={`w-full rounded-xl px-3 py-3 text-sm font-black transition-all ${
                          meridiem === currentMeridiem
                            ? 'bg-brand-green text-black'
                            : 'text-text-primary hover:bg-brand-green/10 hover:text-brand-green'
                        }`}
                      >
                        {meridiem}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="mt-4 w-full rounded-xl bg-brand-green px-4 py-3 text-sm font-black text-dark-bg shadow-lg shadow-brand-green/20 hover:bg-brand-green/85 transition-all"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BolDocument({
  form,
  printable
}: {
  form: BolForm;
  printable: boolean;
}) {
  const [documentImage, setDocumentImage] = useState('');

  useEffect(() => {
    let cancelled = false;

    void renderBolOutputCanvas(form, 2).then(canvas => {
      if (!cancelled) {
        setDocumentImage(canvas.toDataURL('image/png'));
      }
    }).catch(() => {
      if (!cancelled) {
        setDocumentImage('');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [form]);

  return (
    <div className={printable ? 'bol-print-target' : ''}>
      <div
        className="bol-letter-page relative isolate mx-auto h-[11in] min-h-[11in] w-[8.5in] overflow-hidden"
        style={{
          backgroundColor: 'var(--cmhub-document-paper)',
          color: 'var(--cmhub-document-ink)'
        }}
      >
        {documentImage && (
          <img
            src={documentImage}
            alt="BOL 预览"
            className="absolute inset-0 h-full w-full select-none object-fill"
          />
        )}
      </div>
    </div>
  );
}

export default function BolManager() {
  const [records, setRecords] = useState<BolRecord[]>(() => safeParseRecords(localStorage.getItem(BOL_STORAGE_KEY)));
  const [form, setForm] = useState<BolForm>(() => createEmptyForm());
  const [previewForm, setPreviewForm] = useState<BolForm>(form);
  const [stage, setStage] = useState<BolStage>('list');
  const [errors, setErrors] = useState<BolErrors>({});
  const [activeRecord, setActiveRecord] = useState<BolRecord | null>(null);
  const [notice, setNotice] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  const selectedChannels = useMemo(
    () => getSelectedChannels(form),
    [form.channelIds, form.channelId]
  );
  const selectedChannelIds = useMemo(() => selectedChannels.map(channel => channel.id), [selectedChannels]);
  const activeChannelId = useMemo(() => getActiveChannelId(form), [form]);
  const activeChannel = BOL_CHANNELS.find(channel => channel.id === activeChannelId);
  const activeChannelQuantities = useMemo(
    () => activeChannelId ? getQuantityValuesForChannel(form, activeChannelId) : createEmptyQuantityValues(),
    [form, activeChannelId]
  );
  useEffect(() => {
    localStorage.setItem(BOL_STORAGE_KEY, JSON.stringify(records));
  }, [records]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreviewForm(form);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [form]);

  const startNewBol = () => {
    const nextForm = createEmptyForm();
    setForm(nextForm);
    setPreviewForm(nextForm);
    setErrors({});
    setNotice('');
    setActiveRecord(null);
    setStage('edit');
  };

  const updateFormField = (field: 'bolNo' | 'pickupAt', value: string) => {
    const nextValue = field === 'bolNo' ? formatBolNumberInput(value) : value;
    setForm(current => ({ ...current, [field]: nextValue }));
    setErrors(current => ({ ...current, [field]: undefined }));
  };

  const selectChannelForEditing = (channelId: string) => {
    setForm(current => {
      const currentIds = getNormalizedChannelIds(current);
      const nextIds = currentIds.includes(channelId) ? currentIds : [...currentIds, channelId];

      return {
        ...current,
        channelIds: nextIds,
        channelId: nextIds[0],
        activeChannelId: channelId,
        channelQuantities: {
          ...current.channelQuantities,
          [channelId]: getQuantityValuesForChannel(current, channelId)
        }
      };
    });
    setErrors(current => ({ ...current, channelId: undefined }));
  };

  const updateSelectedChannels = (nextChannelIds: string[]) => {
    const validChannelIds = new Set(BOL_CHANNELS.map(channel => channel.id));
    const normalizedIds = Array.from(new Set(nextChannelIds)).filter(channelId => validChannelIds.has(channelId));

    setForm(current => {
      const currentIds = getNormalizedChannelIds(current);
      const newlySelectedId = normalizedIds.find(channelId => !currentIds.includes(channelId));
      const nextActiveChannelId = newlySelectedId
        ?? (current.activeChannelId && normalizedIds.includes(current.activeChannelId)
          ? current.activeChannelId
          : normalizedIds[0] ?? '');
      const nextChannelQuantities = { ...current.channelQuantities };

      normalizedIds.forEach(channelId => {
        nextChannelQuantities[channelId] = getQuantityValuesForChannel(current, channelId);
      });

      const nextActiveQuantities = nextActiveChannelId
        ? getQuantityValuesForChannel({ ...current, channelQuantities: nextChannelQuantities }, nextActiveChannelId)
        : createEmptyQuantityValues();

      return {
        ...current,
        channelIds: normalizedIds,
        channelId: normalizedIds[0],
        activeChannelId: nextActiveChannelId,
        channelQuantities: nextChannelQuantities,
        packages: nextActiveQuantities.packages,
        boxes: nextActiveQuantities.boxes,
        pallets: nextActiveQuantities.pallets
      };
    });
    setErrors(current => ({ ...current, channelId: undefined }));
  };

  const setActiveChannel = (channelId: string) => {
    setForm(current => {
      const selectedIds = getNormalizedChannelIds(current);
      if (!selectedIds.includes(channelId)) return current;
      const values = getQuantityValuesForChannel(current, channelId);

      return {
        ...current,
        activeChannelId: channelId,
        packages: values.packages,
        boxes: values.boxes,
        pallets: values.pallets
      };
    });
  };

  const removeChannel = (channelId: string) => {
    setForm(current => {
      const currentIds = getNormalizedChannelIds(current);
      const nextIds = currentIds.filter(id => id !== channelId);
      const nextActiveChannelId = current.activeChannelId === channelId
        ? nextIds[0] ?? ''
        : getActiveChannelId({ ...current, channelIds: nextIds });

      return {
        ...current,
        channelIds: nextIds,
        channelId: nextIds[0],
        activeChannelId: nextActiveChannelId
      };
    });
  };

  const updateQuantity = (field: QuantityField, value: string) => {
    if (value !== '' && !/^\d+$/.test(value)) return;
    setForm(current => {
      const currentActiveChannelId = getActiveChannelId(current);
      if (!currentActiveChannelId) return current;

      const currentChannelQuantities = getQuantityValuesForChannel(current, currentActiveChannelId);
      const nextChannelQuantities = {
        ...currentChannelQuantities,
        [field]: value
      };

      return {
        ...current,
        channelQuantities: {
          ...current.channelQuantities,
          [currentActiveChannelId]: nextChannelQuantities
        },
        [field]: value
      };
    });
    setErrors(current => ({ ...current, quantities: undefined }));
  };

  const submitForPreview = () => {
    const nextErrors = validateBolForm(form, records, activeRecord?.id);
    setErrors(nextErrors);

    if (!isBolValid(nextErrors)) {
      setNotice('请先修正红色提示项，再生成 BOL。');
      return;
    }

    const openPreview = () => {
      setPreviewForm(form);
      setNotice('');
      setStage('confirm');
    };

    openPreview();
  };

  const confirmBol = () => {
    const nextErrors = validateBolForm(form, records, activeRecord?.id);
    setErrors(nextErrors);

    if (!isBolValid(nextErrors)) {
      setStage('edit');
      setNotice('保存前检测到信息不完整，请重新核对。');
      return;
    }

    const now = new Date().toISOString();
    const previousRecord = activeRecord;
    const normalizedChannelIds = getNormalizedChannelIds(form);
    const normalizedChannelQuantities = getNormalizedChannelQuantityMap(form);
    const normalizedActiveChannelId = getActiveChannelId({ ...form, channelIds: normalizedChannelIds });
    const activeQuantityValues = normalizedActiveChannelId
      ? getQuantityValuesForChannel({ ...form, channelQuantities: normalizedChannelQuantities }, normalizedActiveChannelId)
      : createEmptyQuantityValues();
    const record: BolRecord = {
      ...form,
      bolNo: normalizeBolNumber(form.bolNo),
      channelIds: normalizedChannelIds,
      channelId: normalizedChannelIds[0],
      activeChannelId: normalizedActiveChannelId,
      channelQuantities: normalizedChannelQuantities,
      packages: activeQuantityValues.packages,
      boxes: activeQuantityValues.boxes,
      pallets: activeQuantityValues.pallets,
      id: previousRecord?.id ?? `bol-${Date.now()}`,
      status: 'generated',
      version: previousRecord ? previousRecord.version + 1 : 1,
      createdAt: previousRecord?.createdAt ?? now,
      updatedAt: now,
      printCount: previousRecord?.printCount ?? 0,
      renderedHtml: previewRef.current?.outerHTML ?? ''
    };

    setRecords(current => keepLatestBolRecords([record, ...current.filter(item => item.id !== record.id)]));
    setActiveRecord(record);
    setNotice('BOL 已保存，可打印或下载 PDF。');
    setStage('output');
  };

  const openRecord = (record: BolRecord) => {
    const normalizedChannelIds = getNormalizedChannelIds(record);
    const normalizedChannelQuantities = getNormalizedChannelQuantityMap(record);
    const normalizedActiveChannelId = record.activeChannelId && normalizedChannelIds.includes(record.activeChannelId)
      ? record.activeChannelId
      : normalizedChannelIds[0] ?? '';
    const activeQuantityValues = normalizedActiveChannelId
      ? getQuantityValuesForChannel({ ...record, channelQuantities: normalizedChannelQuantities }, normalizedActiveChannelId)
      : createEmptyQuantityValues();

    setActiveRecord(record);
    setForm({
      bolNo: formatBolNumberInput(record.bolNo),
      channelIds: normalizedChannelIds,
      channelId: normalizedChannelIds[0],
      activeChannelId: normalizedActiveChannelId,
      channelQuantities: normalizedChannelQuantities,
      packages: activeQuantityValues.packages,
      boxes: activeQuantityValues.boxes,
      pallets: activeQuantityValues.pallets,
      pickupAt: record.pickupAt
    });
    setPreviewForm(record);
    setErrors({});
    setNotice('');
    setStage('output');
  };

  const downloadPdf = async () => {
    setIsExporting(true);
    setNotice('');

    try {
      const [canvas, { default: jsPDF }] = await Promise.all([
        renderBolOutputCanvas(form),
        import('jspdf')
      ]);
      const imageData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
      pdf.addImage(imageData, 'PNG', 0, 0, BOL_TEMPLATE_WIDTH, BOL_TEMPLATE_HEIGHT);
      pdf.save(`${(activeRecord?.bolNo || form.bolNo || 'BOL').replace(/[^\w-]+/g, '_')}_v${activeRecord?.version ?? 1}.pdf`);
      setNotice('PDF 已生成并开始下载。');
    } catch (error) {
      setNotice(`PDF 下载失败：${error instanceof Error ? error.message : '浏览器阻止了导出，请重试'}`);
    } finally {
      setIsExporting(false);
    }
  };

  const printBol = async () => {
    // Open synchronously while handling the click, otherwise browser popup
    // policies can block the print document after the canvas has rendered.
    const printWindow = window.open('', '_blank', 'width=816,height=1056');
    if (!printWindow) {
      setNotice('浏览器阻止了打印窗口，请允许本网站弹窗后重试。');
      return;
    }

    setIsPrinting(true);
    setNotice('');

    try {
      const canvas = await renderBolOutputCanvas(form);
      const documentImage = canvas.toDataURL('image/png');

      printWindow.document.open();
      printWindow.document.write(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>BOL Print</title>
            <style>
              @page { size: Letter portrait; margin: 0; }
              html, body { width: 8.5in; height: 11in; margin: 0; padding: 0; background: rgb(255, 255, 255); }
              img { display: block; width: 8.5in; height: 11in; object-fit: fill; }
            </style>
          </head>
          <body><img src="${documentImage}" alt="BOL" /></body>
        </html>`);
      printWindow.document.close();

      const printImage = printWindow.document.querySelector('img');
      if (!printImage) {
        throw new Error('打印文件准备失败');
      }
      if (!printImage.complete) {
        await new Promise<void>((resolve, reject) => {
          printImage.addEventListener('load', () => resolve(), { once: true });
          printImage.addEventListener('error', () => reject(new Error('打印文件加载失败')), { once: true });
        });
      }

      printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
      printWindow.focus();
      printWindow.print();

      if (activeRecord) {
        setRecords(current => keepLatestBolRecords(current.map(record => (
          record.id === activeRecord.id
            ? { ...record, printCount: record.printCount + 1, updatedAt: new Date().toISOString() }
            : record
        ))));
        setActiveRecord(current => current ? { ...current, printCount: current.printCount + 1 } : current);
      }
      setNotice('完整 Letter 版 BOL 已送入浏览器打印队列。');
    } catch (error) {
      printWindow.close();
      setNotice(`打印准备失败：${error instanceof Error ? error.message : '请重试'}`);
    } finally {
      setIsPrinting(false);
    }
  };

  const resetForm = () => {
    const nextForm = createEmptyForm();
    setForm(nextForm);
    setPreviewForm(nextForm);
    setErrors({});
    setNotice('');
  };

  return (
    <ArcoCard className="cmhub-bol-card" bordered bodyStyle={{ padding: 0 }}>
      <div className="no-print cmhub-bol-toolbar">
        <div className="cmhub-bol-toolbar-heading">
          <div className="cmhub-bol-toolbar-icon">
            <FileCheck2 className="w-6 h-6 text-brand-green" />
          </div>
          <div>
            <Typography.Title heading={3} className="!mb-0">BOL管理</Typography.Title>
            <Typography.Paragraph type="secondary" className="!mb-0">录入单号、渠道、装货数量和提货时间，实时生成标准 BOL 提货单。</Typography.Paragraph>
          </div>
        </div>
        <div className="cmhub-bol-toolbar-actions">
          {stage !== 'list' && (
            <ArcoButton
              onClick={() => setStage('list')}
              icon={<ArrowLeft className="w-4 h-4" />}
            >
              返回列表
            </ArcoButton>
          )}
          {stage === 'list' && (
            <ArcoButton
              type="primary"
              onClick={startNewBol}
              icon={<FileText className="w-4 h-4" />}
            >
              新建 BOL
            </ArcoButton>
          )}
        </div>
      </div>

      {notice && (
        <div className="no-print mx-5 mt-5"><ArcoAlert type="success" showIcon content={notice} /></div>
      )}

      {stage === 'list' && (
        <div className="no-print cmhub-bol-list">
          {records.length === 0 ? (
            <Empty description="还没有生成过 BOL。点击“新建 BOL”，扫码或输入 BOL 单号后即可生成预览。" />
          ) : (
            <ArcoTable
              rowKey="id"
              data={records}
              border={false}
              pagination={false}
              columns={[
                { title: 'BOL 单号', dataIndex: 'bolNo' },
                { title: '渠道', render: (_: unknown, record: BolRecord) => formatChannelNames(record) },
                { title: '数量', render: (_: unknown, record: BolRecord) => formatQuantitySummary(record) },
                { title: '提货时间', dataIndex: 'pickupAt', render: (pickupAt: string) => formatPickupTime(pickupAt) },
                { title: '版本/打印', render: (_: unknown, record: BolRecord) => `v${record.version} · 已打印 ${record.printCount}` },
                {
                  title: '操作',
                  width: 118,
                  render: (_: unknown, record: BolRecord) => (
                    <ArcoButton type="text" size="mini" onClick={() => openRecord(record)}>预览/输出</ArcoButton>
                  )
                }
              ]}
            />
          )}
        </div>
      )}

      {stage === 'edit' && (
        <div className="cmhub-bol-editor">
          <div className="no-print cmhub-bol-form-column">
            <div className="cmhub-bol-form-panel">
              <div>
                <label className="text-sm font-bold text-text-primary">BOL 单号 <span className="text-red-400">*</span></label>
                <ArcoInput.TextArea
                  value={form.bolNo}
                  onChange={value => updateFormField('bolNo', value)}
                  placeholder="扫码或手动输入 BOL Number"
                  className="mt-2 cmhub-bol-number-input"
                  autoSize={{ minRows: 1, maxRows: BOL_NUMBER_MAX_LINES }}
                  autoFocus
                />
                {errors.bolNo && <p className="mt-2 text-xs text-red-400">{errors.bolNo}</p>}
              </div>

              <div className="cmhub-bol-field">
                <label className="text-sm font-bold text-text-primary">渠道 <span className="text-red-400">*</span></label>
                <ArcoSelect
                  mode="multiple"
                  value={selectedChannelIds}
                  options={BOL_CHANNELS.map(channel => ({ label: channel.name, value: channel.id }))}
                  placeholder="选择一个或多个渠道"
                  onChange={value => updateSelectedChannels(Array.isArray(value) ? value.map(String) : [])}
                  onSelect={value => setActiveChannel(String(value))}
                  status={errors.channelId ? 'error' : undefined}
                  className="cmhub-bol-channel-select"
                />
                <Typography.Text type="secondary" className="cmhub-bol-field-help">选择新渠道后会自动切换填写对象；每个渠道已填写的数量将被保留。</Typography.Text>
                {errors.channelId && <p className="mt-2 text-xs text-red-400">{errors.channelId}</p>}
              </div>

              <div className="cmhub-bol-quantity-panel">
                <div className="cmhub-bol-quantity-heading">
                  <div>
                    <Typography.Text type="secondary">当前填写渠道</Typography.Text>
                    <Typography.Title heading={5} className="!mb-0">{activeChannel?.name ?? '请选择渠道'}</Typography.Title>
                  </div>
                  <Typography.Text className="cmhub-bol-quantity-summary">
                    {getQuantitySummaryParts(activeChannelQuantities).length > 0
                      ? getQuantitySummaryParts(activeChannelQuantities).join(' / ')
                      : '数量为空'}
                  </Typography.Text>
                </div>

                {selectedChannels.length > 1 && (
                  <div className="cmhub-bol-channel-switcher" role="group" aria-label="切换当前填写渠道">
                    {selectedChannels.map(channel => (
                      <ArcoButton
                        key={channel.id}
                        size="small"
                        type={channel.id === activeChannelId ? 'primary' : 'secondary'}
                        onClick={() => setActiveChannel(channel.id)}
                      >
                        {channel.name}
                      </ArcoButton>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-3">
                  {quantityFields.map(field => (
                    <div key={field.key}>
                      <label className="text-xs font-bold text-text-secondary">{field.label}</label>
                      <ArcoInput
                        inputMode="numeric"
                        value={activeChannelQuantities[field.key]}
                        onChange={value => updateQuantity(field.key, value)}
                        placeholder="0"
                        disabled={!activeChannel}
                        className="mt-2"
                      />
                    </div>
                  ))}
                </div>
              </div>
              {errors.quantities && <p className="-mt-3 text-xs text-red-400">{errors.quantities}</p>}

              <div className="cmhub-bol-field">
                <label className="text-sm font-bold text-text-primary">提货时间 <span className="text-red-400">*</span></label>
                <ArcoDatePicker
                  value={parsePickupDate(form.pickupAt)}
                  onChange={(_value, date) => updateFormField('pickupAt', toDateTimeInputValue(date.toDate()))}
                  showTime={{ use12Hours: true }}
                  showNowBtn
                  allowClear={false}
                  format="MM/DD/YYYY hh:mm A"
                  status={errors.pickupAt ? 'error' : undefined}
                  className="cmhub-bol-date-picker"
                />
                {errors.pickupAt && <p className="mt-2 text-xs text-red-400">{errors.pickupAt}</p>}
              </div>

            </div>

            <div className="cmhub-bol-form-actions">
              <ArcoButton
                onClick={resetForm}
                icon={<RotateCcw className="w-4 h-4" />}
              >
                重置
              </ArcoButton>
              <ArcoButton
                type="primary"
                onClick={submitForPreview}
                icon={<Save className="w-4 h-4" />}
              >
                生成 BOL
              </ArcoButton>
            </div>
          </div>

          <div className="cmhub-bol-preview-surface">
            <BolDocument form={previewForm} printable={false} />
          </div>
        </div>
      )}

      {stage === 'confirm' && (
        <div className="p-5 md:p-6 space-y-5">
          <div className="no-print flex flex-col md:flex-row md:items-center md:justify-between gap-4 rounded-3xl border border-brand-green/20 bg-brand-green/10 p-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-brand-green" />
              <div>
                <h3 className="font-bold text-text-primary">请核对 BOL 模板字段</h3>
                <p className="text-sm text-text-secondary/70">确认无误后保存正式 BOL；返回修改会保留当前表单内容。</p>
              </div>
            </div>
            <div className="flex gap-3">
              <ArcoButton
                onClick={() => setStage('edit')}
                icon={<ArrowLeft className="w-4 h-4" />}
              >
                返回修改
              </ArcoButton>
              <ArcoButton
                type="primary"
                onClick={confirmBol}
                icon={<CheckCircle2 className="w-4 h-4" />}
              >
                确认生成
              </ArcoButton>
            </div>
          </div>

          <div ref={previewRef} className="overflow-auto rounded-3xl border border-white/10 bg-dark-bg/55 p-4">
            <BolDocument form={form} printable={false} />
          </div>
        </div>
      )}

      {stage === 'output' && (
        <div className="p-5 md:p-6 space-y-5">
          <div className="no-print flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 rounded-3xl border border-brand-green/20 bg-brand-green/10 p-4">
            <div className="flex items-center gap-3">
              <Truck className="w-5 h-5 text-brand-green" />
              <div>
                <h3 className="font-bold text-text-primary">BOL 已生成</h3>
                <p className="text-sm text-text-secondary/70">
                  {activeRecord ? `${activeRecord.bolNo} · v${activeRecord.version} · 已打印 ${activeRecord.printCount} 次` : '可打印或下载 PDF'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <ArcoButton
                onClick={() => setStage('edit')}
                icon={<ArrowLeft className="w-4 h-4" />}
              >
                返回修改
              </ArcoButton>
              <ArcoButton
                onClick={() => void printBol()}
                disabled={isPrinting}
                loading={isPrinting}
                icon={<Printer className="w-4 h-4" />}
              >
                {isPrinting ? '准备打印...' : '打印'}
              </ArcoButton>
              <ArcoButton
                type="primary"
                onClick={() => void downloadPdf()}
                disabled={isExporting}
                loading={isExporting}
                icon={<Download className="w-4 h-4" />}
              >
                {isExporting ? '生成中...' : '下载 PDF'}
              </ArcoButton>
            </div>
          </div>

          <div ref={previewRef} className="overflow-auto rounded-3xl border border-white/10 bg-dark-bg/55 p-4">
            <BolDocument form={form} printable={true} />
          </div>

        </div>
      )}
    </ArcoCard>
  );
}
