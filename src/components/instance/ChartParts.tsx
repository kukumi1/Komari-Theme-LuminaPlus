import type { ChartTooltipState } from "./chartShared";

export function ChartTooltip({ tooltip }: { tooltip: ChartTooltipState }) {
  if (!tooltip.show) return null;
  return (
    <div
      aria-hidden="true"
      className="instance-chart-tooltip"
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      <div className="instance-chart-tooltip-time">{tooltip.time}</div>
      {tooltip.rows.map((row, index) => (
        <div key={`${index}-${row.label}`} className="instance-chart-tooltip-entry">
          <div className="instance-chart-tooltip-row">
            <span
              aria-hidden="true"
              className="instance-chart-tooltip-dot"
              style={{ background: row.color }}
            />
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
          {row.note && <div className="instance-chart-tooltip-note">{row.note}</div>}
        </div>
      ))}
    </div>
  );
}

/** 三档以上的设置用循环按钮，比塞三个并排开关省横向空间——工具栏在移动端已经很挤。 */
export function CycleToggle<T extends string>({
  label,
  options,
  value,
  onChange,
  title,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  title?: string;
}) {
  const index = options.findIndex((option) => option.value === value);
  const current = options[index] ?? options[0];
  const next = options[(index + 1) % options.length] ?? options[0];
  if (!current || !next) return null;
  return (
    <button
      type="button"
      className="instance-toggle-button instance-cycle-button"
      onClick={() => onChange(next.value)}
      aria-label={`${label}：当前${current.label}，点击切换到${next.label}`}
      title={title}
    >
      <span className="instance-cycle-label">{label}</span>
      <span className="instance-cycle-value">{current.label}</span>
    </button>
  );
}

export function SwitchToggle({
  label,
  active,
  onToggle,
  title,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="instance-toggle-button instance-switch-button"
      data-active={active ? "true" : "false"}
      onClick={onToggle}
      aria-pressed={active}
      title={title}
    >
      <span className="instance-switch-copy">{label}</span>
      <span className="instance-switch-track" aria-hidden>
        <span className="instance-switch-thumb" />
      </span>
      <span className="instance-switch-state">{active ? "开启" : "关闭"}</span>
    </button>
  );
}
