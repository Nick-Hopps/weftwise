'use client';

/**
 * 设置弹窗行级原语 —— 行自持 px-4 py-3，由外层卡片容器以 divide-y 分隔成组。
 * 布局默认「标签+描述在左、控件在右」，layout="stack" 时控件全宽置于下方
 * （长文本输入用）。全部即时自动保存。
 * 行级保存状态：panel 级 mutation 的 pending/error 经 RowSaveState 传入；
 * 每行本地记录「本行是否发起了最近一次保存」（touched），只有发起行显示
 * spinner/成功/错误，避免共享 pending 让全 panel 一起转圈。保存指示随行
 * 标签内联显示，不在控件侧占位。
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, Minus } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Input, Textarea } from '@/components/ui/input';
import { validateIntInRange } from '@/lib/settings-validation';
import { cn } from '@/lib/cn';
import { isImeComposing } from '@/lib/keyboard';
import { useI18n } from '@/components/i18n-provider';

export interface RowSaveState {
  pending: boolean;
  error: unknown;
}

interface SettingRowProps {
  label: string;
  description?: string;
  /** 行标签右侧的内联状态（保存 spinner / ✓）。*/
  indicator?: React.ReactNode;
  /** 控件下方的行内附注（错误、校验提示、弹出列表）。*/
  footer?: React.ReactNode;
  /** row：控件右对齐；stack：控件全宽置于标签下方。*/
  layout?: 'row' | 'stack';
  children: React.ReactNode;
  className?: string;
}

export function SettingRow({
  label,
  description,
  indicator,
  footer,
  layout = 'row',
  children,
  className,
}: SettingRowProps) {
  return (
    <div className={cn('px-4 py-3', className)}>
      <div
        className={cn(
          'flex flex-col items-stretch gap-2',
          layout === 'row' && 'justify-between sm:flex-row sm:items-center sm:gap-5',
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{label}</span>
            {indicator}
          </div>
          {description && (
            <div className="mt-0.5 text-xs text-foreground-tertiary">{description}</div>
          )}
        </div>
        <div
          className={
            layout === 'row' ? 'max-w-full shrink-0 self-start sm:self-auto' : 'w-full'
          }
        >
          {children}
        </div>
      </div>
      {footer}
    </div>
  );
}

/**
 * 行级保存状态 hook：调用方在发起保存时 markSaving()，
 * 据共享 pending 的下降沿派生 'saving' → 'saved'(1.5s) / 'error'。
 */
function useRowSaveStatus(save: RowSaveState | undefined) {
  // touched：本行发起了保存且尚未收到结果；settled：结果已回（成功标记 1.5s，失败则常驻错误直到下次发起）。
  const [touched, setTouched] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [rowError, setRowError] = useState<unknown>(undefined);
  const wasPending = useRef(false);

  const pending = save?.pending ?? false;
  const error = save?.error;

  useEffect(() => {
    const fell = wasPending.current && !pending; // pending 下降沿 = 本次保存已结束
    wasPending.current = pending;
    if (!fell || !touched) return;
    setTouched(false);
    if (error) {
      setRowError(error);
      return;
    }
    setRowError(undefined);
    setShowSaved(true);
    const t = setTimeout(() => setShowSaved(false), 1500);
    return () => clearTimeout(t);
  }, [pending, error, touched]);

  return {
    markSaving: () => {
      setTouched(true);
      setRowError(undefined);
      setShowSaved(false);
    },
    saving: touched && pending,
    saved: showSaved,
    rowError,
  };
}

/** 行标签旁的保存状态小标记：spinner / 成功标记（1.5s 淡出）；空闲时不渲染、不占位。*/
function SaveIndicator({ saving, saved }: { saving: boolean; saved: boolean }) {
  if (!saving && !saved) return null;
  return (
    <span className="inline-flex shrink-0" aria-hidden>
      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground-tertiary" />}
      {!saving && saved && <Check className="h-3.5 w-3.5 text-success" />}
    </span>
  );
}

/** 行内红色错误文案。*/
function RowError({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <p role="alert" className="mt-1.5 text-xs text-danger">
      {t('settings.rows.failedToSave', { error: error instanceof Error ? error.message : String(error) })}
    </p>
  );
}

export function SwitchRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onSave: (v: boolean) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  return (
    <SettingRow
      label={props.label}
      description={props.description}
      indicator={<SaveIndicator saving={status.saving} saved={status.saved} />}
      footer={<RowError error={status.rowError} />}
    >
      <Switch
        checked={props.checked}
        aria-label={props.label}
        disabled={status.saving}
        onCheckedChange={(v) => {
          status.markSaving();
          props.onSave(v);
        }}
      />
    </SettingRow>
  );
}

export function SegmentedRow<T extends string>(props: {
  label: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  onSave: (v: T) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  return (
    <SettingRow
      label={props.label}
      description={props.description}
      indicator={<SaveIndicator saving={status.saving} saved={status.saved} />}
      footer={<RowError error={status.rowError} />}
    >
      <Segmented<T>
        value={props.value}
        options={props.options}
        aria-label={props.label}
        disabled={status.saving}
        onChange={(v) => {
          if (v === props.value) return;
          status.markSaving();
          props.onSave(v);
        }}
      />
    </SettingRow>
  );
}

export function SelectRow<T extends string>(props: {
  label: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  onSave: (v: T) => void;
  save?: RowSaveState;
  disabled?: boolean;
}) {
  const selectId = useId();
  const status = useRowSaveStatus(props.save);
  return (
    <SettingRow
      label={props.label}
      description={props.description}
      indicator={<SaveIndicator saving={status.saving} saved={status.saved} />}
      footer={<RowError error={status.rowError} />}
    >
      <Select
        id={selectId}
        value={props.value}
        aria-label={props.label}
        disabled={props.disabled || status.saving}
        className="min-w-36 max-w-full"
        onChange={(e) => {
          const v = e.target.value as T;
          if (v === props.value) return;
          status.markSaving();
          props.onSave(v);
        }}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

/** MultiSelectRow 选项行的可视 checkbox：真实 input 为 sr-only peer，此标记承接勾选/半选/锁定态。*/
function CheckboxMark({ checked, indeterminate, muted }: {
  checked: boolean;
  indeterminate?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
        'transition-colors duration-fast ease-standard',
        'peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring/40',
        checked || indeterminate
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-input-border bg-input-bg',
        muted && 'opacity-50',
      )}
    >
      {indeterminate ? (
        <Minus className="h-3 w-3" strokeWidth={3} />
      ) : checked ? (
        <Check className="h-3 w-3" strokeWidth={3} />
      ) : null}
    </span>
  );
}

export function MultiSelectRow<T extends string>(props: {
  label: string;
  description?: string;
  allLabel: string;
  value: 'all' | readonly T[];
  options: Array<{ value: T; label: string; description?: string }>;
  onSave: (value: 'all' | T[]) => void;
  save?: RowSaveState;
  loading?: boolean;
}) {
  const { t } = useI18n();
  const status = useRowSaveStatus(props.save);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 悬浮层 fixed 定位样式：设置卡片 overflow-hidden、内容区滚动，面板必须 portal 到 body 才不被裁切。
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);

  // 打开时按触发按钮定位（右缘对齐、默认向下、空间不足翻转向上），滚动/缩放时跟随重算。
  useLayoutEffect(() => {
    if (!open) return;
    const MARGIN = 8;
    const GAP = 4;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(320, window.innerWidth - MARGIN * 2);
      const left = Math.min(Math.max(MARGIN, rect.right - width), window.innerWidth - width - MARGIN);
      const spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN;
      const spaceAbove = rect.top - GAP - MARGIN;
      const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(120, Math.min(316, openUp ? spaceAbove : spaceBelow));
      setPanelStyle(
        openUp
          ? { left, width, maxHeight, bottom: window.innerHeight - rect.top + GAP }
          : { left, width, maxHeight, top: rect.bottom + GAP },
      );
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // 点外/Escape 关闭。Escape 在 document 冒泡阶段截停，避免连带触发 Settings 弹窗的 window 级关闭。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const validValues = new Set(props.options.map((option) => option.value));
  const selected = props.value === 'all'
    ? new Set(props.options.map((option) => option.value))
    : new Set(props.value.filter((value) => validValues.has(value)));
  const selectedOptions = props.options.filter((option) => selected.has(option.value));
  const disabled = status.saving || props.loading;
  const isAll = props.value === 'all';
  // 半选：显式子集模式下（含恰好全选，语义上不覆盖未来新项目）All 行显示中间态。
  const partial = !isAll && selected.size > 0;
  const summary = isAll
    ? props.allLabel
    : props.loading
      ? t('settings.rows.loadingProjects')
      : selectedOptions.length === 1
        ? selectedOptions[0].label
        : t('settings.rows.projectsSelected', { count: selectedOptions.length });

  const commit = (value: 'all' | T[]) => {
    status.markSaving();
    props.onSave(value);
  };

  return (
    <SettingRow
      label={props.label}
      description={props.description}
      indicator={<SaveIndicator saving={status.saving} saved={status.saved} />}
      footer={<RowError error={status.rowError} />}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'inline-flex h-7 min-w-32 max-w-56 items-center justify-between gap-2 rounded-md border border-input-border',
          'bg-input-bg px-2 text-xs text-foreground transition-colors',
          'hover:border-border-strong focus-ring disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-border-strong',
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-foreground-tertiary transition-transform', open && 'rotate-180')} />
      </button>

      {open && panelStyle &&
        createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="fixed z-command flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-lg animate-fade-in"
          >
            <label
              className={cn(
                'flex min-h-9 shrink-0 items-center gap-2.5 border-b border-border px-3 text-xs text-foreground',
                disabled || props.options.length === 0 ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-subtle',
              )}
            >
              <input
                type="checkbox"
                className="peer sr-only"
                checked={isAll}
                disabled={disabled || props.options.length === 0}
                ref={(el) => {
                  if (el) el.indeterminate = partial;
                }}
                onChange={(event) => {
                  if (event.target.checked) {
                    commit('all');
                  } else {
                    commit(props.options.map((option) => option.value));
                  }
                }}
              />
              <CheckboxMark checked={isAll} indeterminate={partial} muted={disabled} />
              <span className="font-medium">{props.allLabel}</span>
              {!props.loading && !isAll && (
                <span className="ml-auto tabular-nums text-[11px] text-foreground-tertiary">
                  {selected.size}/{props.options.length}
                </span>
              )}
            </label>

            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {props.loading ? (
                <div className="px-3 py-3 text-xs text-foreground-tertiary">{t('settings.rows.loadingProjects')}</div>
              ) : props.options.length === 0 ? (
                <div className="px-3 py-3 text-xs text-foreground-tertiary">{t('settings.rows.noProjects')}</div>
              ) : (
                props.options.map((option) => {
                  const checked = selected.has(option.value);
                  const isLastSelected = !isAll && checked && selected.size === 1;
                  const locked = disabled || isLastSelected;
                  return (
                    <label
                      key={option.value}
                      title={isLastSelected ? t('settings.rows.selectAnotherProject') : undefined}
                      className={cn(
                        'flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-xs',
                        locked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-subtle',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={checked}
                        disabled={locked}
                        onChange={(event) => {
                          const next = props.options
                            .map((item) => item.value)
                            .filter((value) => value !== option.value && selected.has(value));
                          if (event.target.checked) next.push(option.value);
                          if (next.length > 0) commit(next);
                        }}
                      />
                      <CheckboxMark checked={checked} muted={locked} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">{option.label}</span>
                        {option.description && (
                          <span className="block truncate text-[11px] text-foreground-tertiary">{option.description}</span>
                        )}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </SettingRow>
  );
}

export function NumberRow(props: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  onSave: (v: number) => void;
  save?: RowSaveState;
}) {
  const { t } = useI18n();
  const status = useRowSaveStatus(props.save);
  const [draft, setDraft] = useState(String(props.value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(props.value));
    setInvalid(false);
  }, [props.value]);

  const commit = () => {
    const parsed = validateIntInRange(draft, props.min, props.max);
    if (parsed === null) {
      // 非法：不提交，回滚到服务端值。
      setDraft(String(props.value));
      setInvalid(false);
      return;
    }
    if (parsed === props.value) return;
    status.markSaving();
    props.onSave(parsed);
  };

  return (
    <SettingRow
      label={props.label}
      description={props.description}
      indicator={<SaveIndicator saving={status.saving} saved={status.saved} />}
      footer={
        <>
          {invalid && (
            <p className="mt-1.5 text-xs text-danger sm:text-right">
              {t('settings.rows.integerRange', { min: props.min, max: props.max })}
            </p>
          )}
          <RowError error={status.rowError} />
        </>
      }
    >
      <Input
        type="number"
        value={draft}
        min={props.min}
        max={props.max}
        disabled={status.saving}
        aria-label={props.label}
        aria-invalid={invalid}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(validateIntInRange(e.target.value, props.min, props.max) === null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur();
        }}
        className={cn('h-7 w-24 px-2 text-xs text-right', invalid && 'border-danger')}
      />
    </SettingRow>
  );
}

export function TextRow(props: {
  label: string;
  description?: string;
  value: string;
  type?: 'text' | 'password';
  placeholder?: string;
  onSave: (v: string) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);

  const commit = () => {
    if (draft === props.value) return;
    status.markSaving();
    props.onSave(draft);
  };

  return (
    <SettingRow
      label={props.label}
      description={props.description}
      indicator={<SaveIndicator saving={status.saving} saved={status.saved} />}
      footer={<RowError error={status.rowError} />}
    >
      <Input
        type={props.type ?? 'text'}
        value={draft}
        placeholder={props.placeholder}
        disabled={status.saving}
        aria-label={props.label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur();
        }}
        className="h-7 w-56 max-w-full px-2 text-xs"
      />
    </SettingRow>
  );
}

export function TextareaRow(props: {
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  rows?: number;
  onSave: (v: string) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);

  const commit = () => {
    if (draft === props.value) return;
    status.markSaving();
    props.onSave(draft);
  };

  return (
    <SettingRow
      label={props.label}
      description={props.description}
      layout="stack"
      indicator={<SaveIndicator saving={status.saving} saved={status.saved} />}
      footer={<RowError error={status.rowError} />}
    >
      <Textarea
        value={draft}
        rows={props.rows ?? 3}
        placeholder={props.placeholder}
        disabled={status.saving}
        aria-label={props.label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="w-full p-2 text-sm"
      />
    </SettingRow>
  );
}
