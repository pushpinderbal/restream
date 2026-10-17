// Adapted from shadcn/ui Accordion (MIT).
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";

function Accordion({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item> & {
  variant?: "default" | "panel";
}) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      data-variant={variant}
      className={cn(
        "group/accordion-item",
        variant === "panel"
          ? "rounded-lg border border-border bg-muted"
          : "border-b last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function AccordionTrigger({
  className,
  children,
  description,
  icon,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger> & {
  description?: string;
  icon?: React.ReactNode;
}) {
  const labelId = React.useId();
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        type="button"
        aria-labelledby={description ? labelId : undefined}
        aria-describedby={description ? `${labelId}-description` : undefined}
        className={cn(
          "flex flex-1 items-center justify-between gap-[16px] rounded-[8px] py-[16px] text-left text-[14px] font-medium transition-colors outline-none hover:text-foreground motion-reduce:transition-none keyboard-focus:bg-accent keyboard-focus:[&_[data-slot=accordion-title]]:underline disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180",
          "group-data-[variant=panel]/accordion-item:px-4 group-data-[variant=panel]/accordion-item:py-3 group-data-[variant=panel]/accordion-item:font-semibold group-data-[variant=panel]/accordion-item:hover:bg-accent",
          className,
        )}
        {...props}
      >
        {description || icon ? (
          <span className="flex min-w-0 items-center gap-3">
            {icon && (
              <span
                aria-hidden="true"
                className="shrink-0 text-muted-foreground [&_svg]:size-5"
              >
                {icon}
              </span>
            )}
            <span className="min-w-0">
              <span
                data-slot="accordion-title"
                id={description ? labelId : undefined}
                className="block underline-offset-4"
              >
                {children}
              </span>
              {description && (
                <span
                  id={`${labelId}-description`}
                  className="mt-0.5 block text-[13px] font-normal leading-5 text-muted-foreground"
                >
                  {description}
                </span>
              )}
            </span>
          </span>
        ) : (
          <span data-slot="accordion-title" className="underline-offset-4">
            {children}
          </span>
        )}
        <ChevronDownIcon
          aria-hidden="true"
          className="pointer-events-none size-[16px] shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none group-data-[variant=panel]/accordion-item:size-5"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden text-[14px] data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down data-[state=closed]:motion-reduce:animate-none data-[state=open]:motion-reduce:animate-none"
      {...props}
    >
      <div
        className={cn(
          "pt-0 pb-[16px] group-data-[variant=panel]/accordion-item:px-4 group-data-[variant=panel]/accordion-item:pt-1",
          className,
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Content>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
