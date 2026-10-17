import type { ComponentProps, ReactNode } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import "./play-button.css";

type PlayButtonProps = Omit<ComponentProps<typeof Button>, "asChild"> & {
  icon?: ReactNode;
};

export function PlayButton({
  children,
  className,
  icon = (
    <Play
      className="play-action-glyph"
      fill="currentColor"
      aria-hidden="true"
    />
  ),
  type = "button",
  ...props
}: PlayButtonProps) {
  return (
    <Button {...props} type={type} className={cn("play-action", className)}>
      <span className="play-action-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </Button>
  );
}
