import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
  PackageCheck,
  Printer,
  RotateCcw,
  Save,
  Truck
} from 'lucide-react';
import bolTemplateUrl from './assets/bol-template-figma.svg';

const BOL_STORAGE_KEY = 'cmhub-bol-records-v1';

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

function safeParseRecords(raw: string | null): BolRecord[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
  const normalizedBolNo = form.bolNo.trim().toLowerCase();

  if (!normalizedBolNo) {
    errors.bolNo = '请输入 BOL 单号';
  } else if (records.some(record => record.id !== editingId && record.bolNo.trim().toLowerCase() === normalizedBolNo)) {
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

function pt(value: number) {
  return `${value}pt`;
}

function figmaFont(size: number, lineHeight = 12.858, fontWeight: CSSProperties['fontWeight'] = 400): CSSProperties {
  return {
    fontFamily: '"IBM Plex Mono", "Courier New", monospace',
    fontSize: pt(size),
    fontStyle: 'normal',
    fontWeight,
    letterSpacing: 0,
    lineHeight: pt(lineHeight)
  };
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

const bolQuantityRows: Array<{ id: string; y: number }> = [
  { id: 'gofo', y: 374 },
  { id: 'ywe', y: 399 },
  { id: 'uniuni', y: 425 },
  { id: 'speedx', y: 446 },
  { id: 'swiftx', y: 473 },
  { id: 'usps', y: 498 },
  { id: 'ups', y: 523 },
  { id: 'fedex', y: 549 },
  { id: 'dhl', y: 574 }
];

const bolQuantityColumns: Record<QuantityField, number> = {
  packages: 190,
  boxes: 323,
  pallets: 456
};

const figmaTemplateSamplePatches = [
  { x: 57, y: 263, width: 196, height: 38 },
  { x: 321, y: 373, width: 18, height: 16 },
  { x: 188, y: 398, width: 18, height: 16 },
  { x: 321, y: 424, width: 18, height: 16 },
  { x: 321, y: 445, width: 18, height: 16 },
  { x: 321, y: 472, width: 18, height: 16 },
  { x: 321, y: 497, width: 18, height: 16 },
  { x: 321, y: 522, width: 18, height: 16 },
  { x: 188, y: 548, width: 18, height: 16 },
  { x: 448, y: 713, width: 128, height: 29 }
];

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
        className={`flex w-full items-center justify-between rounded-2xl border bg-[#07100b]/80 px-4 py-3 text-left outline-none transition-all ${
          hasError
            ? 'border-red-400/70 ring-4 ring-red-400/10'
            : 'border-brand-green/80 shadow-[0_0_0_1px_rgba(106,255,0,0.12)] hover:border-brand-green focus:border-brand-green focus:ring-4 focus:ring-brand-green/15'
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
        <div className="absolute left-0 top-full z-40 mt-3 w-[540px] max-w-[calc(100vw-2rem)] rounded-2xl border border-brand-green/60 bg-[#07100b]/95 p-4 shadow-[0_24px_70px_rgba(106,255,0,0.2)] backdrop-blur-xl">
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
                          ? 'bg-brand-green text-black shadow-[0_8px_20px_rgba(106,255,0,0.28)]'
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
  const selectedChannels = getSelectedChannels(form);
  const receipt = formatFigmaReceiptParts(form.pickupAt);

  return (
    <div className={printable ? 'bol-print-target' : ''}>
      <div className="bol-letter-page relative mx-auto h-[11in] min-h-[11in] w-[8.5in] overflow-hidden bg-white text-black shadow-2xl shadow-black/40">
        <img src={bolTemplateUrl} alt="" className="absolute inset-0 h-full w-full select-none object-fill" />

        {figmaTemplateSamplePatches.map(patch => (
          <div
            key={`${patch.x}-${patch.y}`}
            aria-hidden="true"
            className="absolute bg-white"
            style={{
              left: pt(patch.x),
              top: pt(patch.y),
              width: pt(patch.width),
              height: pt(patch.height)
            }}
          />
        ))}

        <div
          className="absolute whitespace-pre-wrap text-black"
          style={{
            ...figmaFont(8),
            left: pt(57),
            top: pt(263),
            width: pt(191),
            height: pt(38)
          }}
        >
          {form.bolNo.trim() || '—'}
        </div>

        {selectedChannels.flatMap(channel => {
          const selectedRow = bolQuantityRows.find(row => row.id === channel.id);
          if (!selectedRow) return [];
          const channelQuantities = getQuantityValuesForChannel(form, channel.id);

          return quantityFields.map(field => {
            const value = formatInteger(channelQuantities[field.key]);
            if (!value) return null;

            return (
              <div
                key={`${channel.id}-${field.key}`}
                className="absolute text-black"
                style={{
                  ...figmaFont(8),
                  left: pt(bolQuantityColumns[field.key]),
                  top: pt(selectedRow.y),
                  width: pt(45),
                  height: pt(16)
                }}
              >
                {value}
              </div>
            );
          });
        })}

        <div
          className="absolute flex items-end gap-[2pt] text-[#bfbfbf]"
          style={{
            left: pt(452),
            top: pt(726),
            height: pt(14)
          }}
        >
          <span style={{ fontFamily: 'Inter, Arial, sans-serif', fontSize: pt(11.678), lineHeight: pt(14), fontWeight: 500 }}>
            {receipt.date}
          </span>
          <span style={{ fontFamily: 'Inter, Arial, sans-serif', fontSize: pt(8.5), lineHeight: pt(10.977) }}>
            {receipt.meridiem}
          </span>
          <span style={{ fontFamily: 'Inter, Arial, sans-serif', fontSize: pt(11.678), lineHeight: pt(14), fontWeight: 500, marginLeft: pt(3) }}>
            {receipt.time}
          </span>
        </div>
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
  const [isChannelDropdownOpen, setIsChannelDropdownOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const channelDropdownRef = useRef<HTMLDivElement>(null);

  const selectedChannels = useMemo(
    () => getSelectedChannels(form),
    [form.channelIds, form.channelId]
  );
  const selectedChannelIds = useMemo(() => selectedChannels.map(channel => channel.id), [selectedChannels]);
  const selectedChannelLabel = selectedChannels.length > 0
    ? selectedChannels.map(channel => channel.name).join('、')
    : '请选择渠道';
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

  useEffect(() => {
    const closeChannelDropdown = (event: MouseEvent) => {
      if (!channelDropdownRef.current?.contains(event.target as Node)) {
        setIsChannelDropdownOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsChannelDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', closeChannelDropdown);
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('mousedown', closeChannelDropdown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const startNewBol = () => {
    const nextForm = createEmptyForm();
    setForm(nextForm);
    setPreviewForm(nextForm);
    setErrors({});
    setNotice('');
    setActiveRecord(null);
    setIsChannelDropdownOpen(false);
    setStage('edit');
  };

  const updateFormField = (field: 'bolNo' | 'pickupAt', value: string) => {
    setForm(current => ({ ...current, [field]: value }));
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

    setPreviewForm(form);
    setNotice('');
    setStage('confirm');
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
      bolNo: form.bolNo.trim(),
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

    setRecords(current => [record, ...current.filter(item => item.id !== record.id)]);
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
      bolNo: record.bolNo,
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
    setIsChannelDropdownOpen(false);
    setStage('output');
  };

  const downloadPdf = async () => {
    if (!previewRef.current) return;

    setIsExporting(true);
    setNotice('');

    try {
      const printablePage = previewRef.current.querySelector('.bol-letter-page') as HTMLElement | null;
      if (!printablePage) {
        throw new Error('未找到可导出的 BOL 预览区域');
      }

      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf')
      ]);

      const canvas = await html2canvas(printablePage, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true
      });
      const imageData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
      pdf.addImage(imageData, 'PNG', 0, 0, 612, 792);
      pdf.save(`${(activeRecord?.bolNo || form.bolNo || 'BOL').replace(/[^\w-]+/g, '_')}_v${activeRecord?.version ?? 1}.pdf`);
      setNotice('PDF 已生成并开始下载。');
    } catch (error) {
      setNotice(`PDF 下载失败：${error instanceof Error ? error.message : '浏览器阻止了导出，请重试'}`);
    } finally {
      setIsExporting(false);
    }
  };

  const printBol = () => {
    if (activeRecord) {
      setRecords(current => current.map(record => (
        record.id === activeRecord.id
          ? { ...record, printCount: record.printCount + 1, updatedAt: new Date().toISOString() }
          : record
      )));
      setActiveRecord(current => current ? { ...current, printCount: current.printCount + 1 } : current);
    }
    window.print();
  };

  const resetForm = () => {
    const nextForm = createEmptyForm();
    setForm(nextForm);
    setPreviewForm(nextForm);
    setErrors({});
    setNotice('');
    setIsChannelDropdownOpen(false);
  };

  return (
    <section className="bg-white/[0.045] backdrop-blur-xl rounded-4xl border border-white/10 overflow-hidden">
      <div className="no-print flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 p-5 md:p-6 border-b border-white/10">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-2xl bg-brand-green/15 flex items-center justify-center border border-brand-green/25">
            <FileCheck2 className="w-6 h-6 text-brand-green" />
          </div>
          <div>
            <div className="text-xs font-black text-brand-green uppercase tracking-[0.18em]">Bill of Lading</div>
            <h2 className="mt-1 text-2xl font-bold text-text-primary">BOL 管理</h2>
            <p className="mt-1 text-sm text-text-secondary/70">录入单号、渠道、装货数量和提货时间，实时生成标准 Letter 提货单。</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          {stage !== 'list' && (
            <button
              type="button"
              onClick={() => setStage('list')}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-text-primary hover:bg-white/10 transition-all"
            >
              <ArrowLeft className="w-4 h-4" />
              返回列表
            </button>
          )}
          <button
            type="button"
            onClick={startNewBol}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-green px-4 py-3 text-sm font-black text-dark-bg shadow-lg shadow-brand-green/20 hover:bg-brand-green/85 transition-all active:scale-[0.98]"
          >
            <FileText className="w-4 h-4" />
            新建 BOL
          </button>
        </div>
      </div>

      {notice && (
        <div className="no-print mx-5 mt-5 rounded-2xl border border-brand-green/20 bg-brand-green/10 px-4 py-3 text-sm text-brand-green">
          {notice}
        </div>
      )}

      {stage === 'list' && (
        <div className="no-print p-5 md:p-6">
          {records.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/15 bg-dark-bg/40 px-6 py-12 text-center">
              <PackageCheck className="mx-auto h-10 w-10 text-brand-green" />
              <h3 className="mt-4 text-xl font-bold text-text-primary">还没有生成过 BOL</h3>
              <p className="mt-2 text-sm text-text-secondary/65">点击“新建 BOL”，扫码或输入 BOL 单号后即可生成预览。</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-3xl border border-white/10">
              <table className="w-full text-left text-sm">
                <thead className="bg-dark-bg/70 text-text-secondary">
                  <tr>
                    <th className="px-5 py-4">BOL 单号</th>
                    <th className="px-5 py-4">渠道</th>
                    <th className="px-5 py-4">数量</th>
                    <th className="px-5 py-4">提货时间</th>
                    <th className="px-5 py-4">版本/打印</th>
                    <th className="px-5 py-4 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {records.map(record => (
                    <tr key={record.id} className="hover:bg-white/[0.04] transition-colors">
                      <td className="px-5 py-4 font-mono font-bold text-text-primary">{record.bolNo}</td>
                      <td className="px-5 py-4 text-text-secondary">{formatChannelNames(record)}</td>
                      <td className="px-5 py-4 text-text-secondary">{formatQuantitySummary(record)}</td>
                      <td className="px-5 py-4 text-text-secondary">{formatPickupTime(record.pickupAt)}</td>
                      <td className="px-5 py-4 text-text-secondary">v{record.version} · 已打印 {record.printCount}</td>
                      <td className="px-5 py-4 text-right">
                        <button
                          type="button"
                          onClick={() => openRecord(record)}
                          className="rounded-lg bg-brand-green/15 px-3 py-2 text-xs font-bold text-brand-green hover:bg-brand-green/25 transition-colors"
                        >
                          预览/输出
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {stage === 'edit' && (
        <div className="grid xl:grid-cols-[390px_1fr] gap-6 p-5 md:p-6">
          <div className="no-print space-y-5">
            <div className="rounded-3xl border border-white/10 bg-dark-bg/45 p-5 space-y-5">
              <div>
                <label className="text-sm font-bold text-text-primary">BOL 单号 <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={form.bolNo}
                  onChange={event => updateFormField('bolNo', event.target.value)}
                  placeholder="扫码或手动输入 BOL Number"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 font-mono text-text-primary outline-none transition-all placeholder:text-text-secondary/40 focus:border-brand-green focus:ring-4 focus:ring-brand-green/15"
                  autoFocus
                />
                {errors.bolNo && <p className="mt-2 text-xs text-red-400">{errors.bolNo}</p>}
              </div>

              <div>
                <label className="text-sm font-bold text-text-primary">渠道 <span className="text-red-400">*</span></label>
                <div ref={channelDropdownRef} className="relative mt-2">
                  <button
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={isChannelDropdownOpen}
                    onClick={() => setIsChannelDropdownOpen(isOpen => !isOpen)}
                    className={`flex w-full items-center justify-between rounded-2xl border bg-[#07100b]/80 px-4 py-3 text-left outline-none transition-all ${
                      errors.channelId
                        ? 'border-red-400/70 ring-4 ring-red-400/10'
                        : 'border-brand-green/80 shadow-[0_0_0_1px_rgba(106,255,0,0.12)] hover:border-brand-green focus:border-brand-green focus:ring-4 focus:ring-brand-green/15'
                    }`}
                  >
                    <span>
                      <span className="block text-lg font-black leading-tight text-text-primary">{selectedChannelLabel}</span>
                      <span className="mt-1 block text-xs font-semibold text-text-secondary/60">
                        {selectedChannels.length > 0 ? `已选择 ${selectedChannels.length} 个渠道` : '点击选择一个或多个渠道'}
                      </span>
                    </span>
                    <ChevronDown className={`h-5 w-5 text-brand-green transition-transform ${isChannelDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {isChannelDropdownOpen && (
                    <div
                      role="listbox"
                      aria-multiselectable="true"
                      className="absolute left-0 right-0 top-full z-30 mt-3 max-h-96 overflow-y-auto rounded-2xl border border-brand-green/60 bg-[#07100b]/95 p-1 shadow-[0_24px_70px_rgba(106,255,0,0.18)] backdrop-blur-xl"
                    >
                      {BOL_CHANNELS.map(channel => {
                        const isSelected = selectedChannelIds.includes(channel.id);
                        const isActive = channel.id === activeChannelId;
                        const quantityParts = getQuantitySummaryParts(getQuantityValuesForChannel(form, channel.id));
                        return (
                          <div
                            key={channel.id}
                            role="option"
                            aria-selected={isSelected}
                            className={`flex items-center gap-2 rounded-xl transition-all ${
                              isActive
                                ? 'bg-brand-green text-black shadow-[0_10px_24px_rgba(106,255,0,0.28)]'
                                : isSelected
                                  ? 'bg-brand-green/15 text-text-primary ring-1 ring-brand-green/30'
                                  : 'text-text-primary hover:bg-brand-green/10 hover:text-brand-green'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => selectChannelForEditing(channel.id)}
                              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left"
                            >
                              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                                isActive
                                  ? 'border-black/30 bg-black/10'
                                  : isSelected
                                    ? 'border-brand-green/70 bg-brand-green/15 text-brand-green'
                                    : 'border-white/20 bg-white/[0.03]'
                              }`}
                              >
                                {isSelected && <Check className="h-4 w-4" />}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-base font-black">{channel.name}</span>
                                <span className={`mt-0.5 block truncate text-xs font-semibold ${
                                  isActive ? 'text-black/60' : 'text-text-secondary/60'
                                }`}
                                >
                                  {isActive
                                    ? '正在填写该渠道数量'
                                    : isSelected
                                      ? quantityParts.length > 0 ? quantityParts.join(' / ') : '已选择，数量为空'
                                      : '点击添加并填写数量'}
                                </span>
                              </span>
                            </button>
                            {isSelected && (
                              <button
                                type="button"
                                onClick={() => removeChannel(channel.id)}
                                className={`mr-2 rounded-lg px-2 py-1 text-xs font-black transition-colors ${
                                  isActive
                                    ? 'bg-black/10 text-black/70 hover:bg-black/20'
                                    : 'bg-white/5 text-text-secondary hover:bg-red-400/15 hover:text-red-300'
                                }`}
                              >
                                移除
                              </button>
                            )}
                          </div>
                        );
                      })}
                      <div className="mt-1 border-t border-white/10 p-3">
                        <p className="text-xs font-semibold text-text-secondary/60">
                          可多选；点击渠道切换当前填写对象，切换后会加载该渠道已填写数量，空白按 0 处理。
                        </p>
                        <button
                          type="button"
                          onClick={() => setIsChannelDropdownOpen(false)}
                          className="mt-3 w-full rounded-xl bg-brand-green px-4 py-3 text-sm font-black text-dark-bg shadow-lg shadow-brand-green/20 hover:bg-brand-green/85 transition-all"
                        >
                          完成选择
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {errors.channelId && <p className="mt-2 text-xs text-red-400">{errors.channelId}</p>}
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.16em] text-text-secondary/55">当前填写渠道</p>
                    <p className="mt-1 text-lg font-black text-text-primary">{activeChannel?.name ?? '请选择渠道'}</p>
                  </div>
                  <div className="rounded-full bg-brand-green/10 px-3 py-1 text-xs font-bold text-brand-green">
                    {getQuantitySummaryParts(activeChannelQuantities).length > 0
                      ? getQuantitySummaryParts(activeChannelQuantities).join(' / ')
                      : '数量为空'}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {quantityFields.map(field => (
                    <div key={field.key}>
                      <label className="text-xs font-bold text-text-secondary">{field.label}</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={activeChannelQuantities[field.key]}
                        onChange={event => updateQuantity(field.key, event.target.value)}
                        placeholder="0"
                        disabled={!activeChannel}
                        className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-center font-mono text-lg font-bold text-text-primary outline-none transition-all placeholder:text-text-secondary/35 focus:border-brand-green focus:ring-4 focus:ring-brand-green/15 disabled:cursor-not-allowed disabled:opacity-45"
                      />
                    </div>
                  ))}
                </div>
              </div>
              {errors.quantities && <p className="-mt-3 text-xs text-red-400">{errors.quantities}</p>}

              <div>
                <label className="text-sm font-bold text-text-primary">提货时间 <span className="text-red-400">*</span></label>
                <BolDateTimePicker
                  value={form.pickupAt}
                  onChange={nextValue => updateFormField('pickupAt', nextValue)}
                  hasError={Boolean(errors.pickupAt)}
                />
                {errors.pickupAt && <p className="mt-2 text-xs text-red-400">{errors.pickupAt}</p>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-text-primary hover:bg-white/10 transition-all"
              >
                <RotateCcw className="w-4 h-4" />
                重置
              </button>
              <button
                type="button"
                onClick={submitForPreview}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-green px-4 py-3 text-sm font-black text-dark-bg shadow-lg shadow-brand-green/20 hover:bg-brand-green/85 transition-all active:scale-[0.98]"
              >
                <Save className="w-4 h-4" />
                生成 BOL
              </button>
            </div>
          </div>

          <div className="overflow-auto rounded-3xl border border-white/10 bg-dark-bg/55 p-4">
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
              <button
                type="button"
                onClick={() => setStage('edit')}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-text-primary hover:bg-white/10 transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                返回修改
              </button>
              <button
                type="button"
                onClick={confirmBol}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-green px-4 py-3 text-sm font-black text-dark-bg shadow-lg shadow-brand-green/20 hover:bg-brand-green/85 transition-all active:scale-[0.98]"
              >
                <CheckCircle2 className="w-4 h-4" />
                确认生成
              </button>
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
              <button
                type="button"
                onClick={() => setStage('edit')}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-text-primary hover:bg-white/10 transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                返回修改
              </button>
              <button
                type="button"
                onClick={printBol}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-brand-green/30 bg-brand-green/15 px-4 py-3 text-sm font-black text-brand-green hover:bg-brand-green/25 transition-all"
              >
                <Printer className="w-4 h-4" />
                打印
              </button>
              <button
                type="button"
                onClick={() => void downloadPdf()}
                disabled={isExporting}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-green px-4 py-3 text-sm font-black text-dark-bg shadow-lg shadow-brand-green/20 hover:bg-brand-green/85 disabled:opacity-60 transition-all active:scale-[0.98]"
              >
                <Download className="w-4 h-4" />
                {isExporting ? '生成中...' : '下载 PDF'}
              </button>
            </div>
          </div>

          <div ref={previewRef} className="overflow-auto rounded-3xl border border-white/10 bg-dark-bg/55 p-4">
            <BolDocument form={form} printable={true} />
          </div>
        </div>
      )}
    </section>
  );
}
