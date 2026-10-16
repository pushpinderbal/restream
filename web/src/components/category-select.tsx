import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import type { Category } from "../api";
import { Button } from "./ui/button";
import "./category-select.css";

export function CategorySelect({
  categories,
  value,
  onValueChange,
}: {
  categories: Category[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = [{ id: "*", name: "All categories" }, ...categories];
  if (value !== "*" && !categories.some((category) => category.id === value)) {
    options.push({ id: value, name: "Selected category" });
  }
  const selected = options.find((option) => option.id === value);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          className="category-select-trigger"
          role="combobox"
          aria-label="Category"
          aria-expanded={open}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="category-select-value">
            {selected?.name || "All categories"}
          </span>
          <ChevronDown
            className="size-[16px]"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="category-select-menu"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Choose category"
        >
          <Command
            className="category-select-command"
            defaultValue={value}
            loop
          >
            <div className="category-select-search">
              <Search size={17} strokeWidth={1.5} aria-hidden="true" />
              <Command.Input
                aria-label="Find category"
                placeholder="Find category…"
              />
            </div>
            <Command.List label="Categories" className="category-select-list">
              <Command.Empty className="category-select-empty">
                No categories found.
              </Command.Empty>
              {options.map((option) => (
                <Command.Item
                  key={option.id}
                  value={option.id}
                  keywords={[option.name]}
                  data-current={value === option.id}
                  className="category-select-option"
                  onSelect={() => {
                    setOpen(false);
                    onValueChange(option.id);
                  }}
                >
                  <span>{option.name}</span>
                  <Check
                    size={17}
                    strokeWidth={1.7}
                    className="category-select-check"
                    aria-hidden="true"
                  />
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
