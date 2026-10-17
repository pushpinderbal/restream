/* Adapted from Spectrum UI Multiple Selector (Apache-2.0).
 * https://spectrumhq.in/docs/multiple-selector-with-form
 * Local categories only: cmdk handles filtering, focus and keyboard selection. */
import { useMemo, useState } from "react";
import { Command } from "cmdk";
import { X } from "lucide-react";
import type { Category } from "../../api";

const groups = { live: "Live TV", movie: "Movies", series: "Shows" } as const;
export function CategorySelector({
  id,
  label,
  categories,
  values,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  categories: Category[];
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = useMemo(
    () =>
      categories.map((category) => ({
        ...category,
        value: `${category.kind}:${category.id}`,
      })),
    [categories],
  );
  const remove = (value: string) =>
    onChange(values.filter((entry) => entry !== value));
  return (
    <div className="settings-category-field">
      <label htmlFor={id}>{label}</label>
      <Command
        className="settings-category-selector"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.stopPropagation();
          }
        }}
      >
        <div className="settings-category-control">
          {values.map((value) => {
            const option = options.find(
              (entry) => entry.value.toLowerCase() === value.toLowerCase(),
            );
            return (
              <span className="settings-category-chip" key={value}>
                <span>
                  {option ? `${option.name} · ${groups[option.kind]}` : value}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${option?.name || value} from ${label}`}
                  onClick={() => remove(value)}
                >
                  <X size={13} aria-hidden />
                </button>
              </span>
            );
          })}
          <Command.Input
            id={id}
            disabled={disabled}
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setOpen(true);
            }}
            placeholder="Search categories…"
            onFocus={() => setOpen(true)}
            onBlur={(event) => {
              if (
                !event.currentTarget.parentElement?.parentElement?.contains(
                  event.relatedTarget,
                )
              )
                setOpen(false);
            }}
            aria-label={label}
          />
        </div>
        {open && !disabled && (
          <Command.List aria-label={`${label} options`}>
            <Command.Empty>
              {categories.length
                ? "No matching categories."
                : "Categories appear after connecting your provider."}
            </Command.Empty>
            {Object.entries(groups).map(([kind, name]) => (
              <Command.Group key={kind} heading={name}>
                {options
                  .filter(
                    (option) =>
                      option.kind === kind &&
                      !values.some(
                        (value) =>
                          value.toLowerCase() === option.value.toLowerCase(),
                      ),
                  )
                  .map((option) => (
                    <Command.Item
                      key={option.value}
                      value={option.value}
                      keywords={[option.name, name]}
                      onMouseDown={(event) => event.preventDefault()}
                      onSelect={() => {
                        onChange([...values, option.value]);
                        setQuery("");
                      }}
                    >
                      {option.name}
                    </Command.Item>
                  ))}
              </Command.Group>
            ))}
          </Command.List>
        )}
      </Command>
    </div>
  );
}
