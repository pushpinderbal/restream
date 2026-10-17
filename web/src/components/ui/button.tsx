import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "@radix-ui/react-slot";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-[8px] rounded-[8px] border border-transparent text-[14px] font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 outline-none keyboard-focus:outline-2 keyboard-focus:outline-offset-2 keyboard-focus:outline-foreground active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[16px]",
  {
    variants: {
      variant: {
        default: "bg-foreground text-background hover:bg-foreground/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60",
        outline:
          "border-input bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 keyboard-focus:outline-none keyboard-focus:underline keyboard-focus:underline-offset-4",
        link: "text-foreground underline-offset-4 hover:underline keyboard-focus:outline-none keyboard-focus:underline",
        tab: "section-tab keyboard-focus:outline-none",
      },
      size: {
        default: "h-[40px] px-[16px]",
        xs: "h-[24px] px-[8px] text-[12px] [&_svg:not([class*='size-'])]:size-[16px]",
        sm: "h-[32px] px-[12px]",
        lg: "h-[44px] px-[20px] [&_svg:not([class*='size-'])]:size-[18px]",
        icon: "size-[40px]",
        "icon-xs": "size-[24px]",
        "icon-sm": "size-[32px]",
        "icon-lg": "size-[44px] [&_svg:not([class*='size-'])]:size-[18px]",
      },
    },
    compoundVariants: [
      {
        variant: "ghost",
        size: ["icon", "icon-xs", "icon-sm", "icon-lg"],
        className: "relative focus-icon keyboard-focus:no-underline",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
