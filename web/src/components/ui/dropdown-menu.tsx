import type { ComponentProps } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

const menuItemClass =
  "relative flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-md px-3 py-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

function DropdownMenu(
  props: ComponentProps<typeof DropdownMenuPrimitive.Root>,
) {
  return <DropdownMenuPrimitive.Root {...props} />;
}

function DropdownMenuTrigger(
  props: ComponentProps<typeof DropdownMenuPrimitive.Trigger>,
) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 8,
  collisionPadding = 16,
  portalContainer,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  portalContainer?: HTMLElement | null;
}) {
  return (
    <DropdownMenuPrimitive.Portal container={portalContainer}>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        className={cn(
          "z-80 max-h-(--radix-dropdown-menu-content-available-height) min-w-40 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
          className,
        )}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(menuItemClass, className)}
      {...props}
    />
  );
}

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn(menuItemClass, "pl-9", className)}
      {...props}
    >
      <span className="absolute left-3 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-3 py-2 text-sm font-medium", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
};
