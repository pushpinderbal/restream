import * as React from "react";
import { BorderBeam, type BorderBeamColorVariant } from "border-beam";
import { Search, X } from "lucide-react";

import { cn } from "../../lib/utils";
import { useSurfaceTheme, type SurfaceTheme } from "./use-surface-theme";

export interface BeamSearchProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  alwaysOn?: boolean;
  colorVariant?: BorderBeamColorVariant;
  theme?: SurfaceTheme;
  trailing?: React.ReactNode;
  className?: string;
}

export function BeamSearch({
  value,
  defaultValue = "",
  onChange,
  onSubmit,
  placeholder = "Search…",
  ariaLabel,
  autoFocus = false,
  alwaysOn = false,
  colorVariant = "colorful",
  theme = "auto",
  trailing,
  className,
}: BeamSearchProps) {
  const resolvedTheme = useSurfaceTheme(theme);
  const [innerValue, setInnerValue] = React.useState(defaultValue);
  const [focused, setFocused] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const currentValue = value ?? innerValue;

  const update = (nextValue: string) => {
    if (value === undefined) setInnerValue(nextValue);
    onChange?.(nextValue);
  };

  return (
    <BorderBeam
      size="line"
      colorVariant={colorVariant}
      theme={resolvedTheme}
      active={alwaysOn || focused}
      className={cn("beam-search w-full", className)}
    >
      <label
        className={cn(
          "flex h-12 w-full items-center gap-3 rounded-xl border border-white/12 bg-neutral-950/90 px-3.5 transition-colors",
          focused && "border-white/20",
        )}
      >
        <Search className="size-4 shrink-0 text-neutral-400" aria-hidden />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          type="search"
          value={currentValue}
          aria-label={ariaLabel}
          placeholder={placeholder}
          onChange={(event) => update(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit?.(currentValue);
            if (event.key === "Escape") update("");
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-100 outline-none placeholder:text-neutral-500 [&::-webkit-search-cancel-button]:hidden"
        />
        {currentValue ? (
          <button
            type="button"
            aria-label="Clear search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              update("");
              inputRef.current?.focus();
            }}
            className="flex size-7 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/8 hover:text-neutral-100"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          trailing
        )}
      </label>
    </BorderBeam>
  );
}
