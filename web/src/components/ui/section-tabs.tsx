import type { LucideIcon } from "lucide-react";
import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { TabIndicator } from "./tab-indicator";

export type SectionTab = {
  value: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
};

export function SectionTabButton({
  active,
  icon: Icon,
  label,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active: boolean;
  icon?: LucideIcon;
  label: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn("section-tab", active && "active", className)}
      {...props}
    >
      {children}
      {Icon && <Icon size={15} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}

export function SectionTabs({
  label,
  value,
  items,
  onValueChange,
  className,
}: {
  label: string;
  value: string;
  items: SectionTab[];
  onValueChange: (value: string) => void;
  className?: string;
}) {
  const indicatorId = useId();
  return (
    <div
      className={cn("section-tabs", className)}
      role="group"
      aria-label={label}
    >
      {items.map(({ value: key, label: title, icon: Icon, disabled }) => (
        <SectionTabButton
          key={key}
          active={value === key}
          icon={Icon}
          label={title}
          aria-pressed={value === key}
          disabled={disabled}
          onClick={() => onValueChange(key)}
        >
          {value === key && <TabIndicator id={indicatorId} />}
        </SectionTabButton>
      ))}
    </div>
  );
}
