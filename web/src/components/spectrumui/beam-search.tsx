import * as React from "react";
import { BorderBeam } from "border-beam";
import { Search, X } from "lucide-react";
import { useReducedMotion } from "motion/react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface BeamSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  className?: string;
}

export function BeamSearch({
  value,
  onChange,
  placeholder = "Search…",
  ariaLabel,
  autoFocus = false,
  className,
}: BeamSearchProps) {
  const reduceMotion = useReducedMotion();
  const [focused, setFocused] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <BorderBeam
      size="line"
      colorVariant="mono"
      theme="dark"
      active={!reduceMotion && focused}
      staticColors
      strength={0.45}
      glowSize={0.5}
      duration={3.6}
      className={cn("beam-search w-full", className)}
    >
      <div
        className={cn(
          "beam-search-control flex h-12 w-full items-center gap-3 rounded-xl border border-white/12 bg-neutral-950/90 px-3.5 transition-colors",
          focused && "border-white/20",
        )}
      >
        <Search className="size-4 shrink-0 text-neutral-400" aria-hidden />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          type="search"
          value={value}
          aria-label={ariaLabel}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onChange("");
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-100 outline-none placeholder:text-neutral-500 [&::-webkit-search-cancel-button]:hidden"
        />
        {value ? (
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Clear search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            className="beam-search-clear flex size-7 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-white/8 hover:text-neutral-100"
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </BorderBeam>
  );
}
