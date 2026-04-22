"use client";

export type PropertyTypeTag =
  | "Text"
  | "Number"
  | "Date"
  | "Select"
  | "MultiSelect"
  | "Relation"
  | "Checkbox"
  | "Url"
  | "Person"
  | "Ai";

const PROPERTY_TYPES: { tag: PropertyTypeTag; icon: string; label: string }[] =
  [
    { tag: "Text", icon: "T", label: "Text" },
    { tag: "Number", icon: "#", label: "Number" },
    { tag: "Date", icon: "📅", label: "Date" },
    { tag: "Select", icon: "◉", label: "Select" },
    { tag: "MultiSelect", icon: "☰", label: "Multi-select" },
    { tag: "Relation", icon: "↗", label: "Relation" },
    { tag: "Checkbox", icon: "✓", label: "Checkbox" },
    { tag: "Url", icon: "🔗", label: "URL" },
    { tag: "Person", icon: "👤", label: "Person" },
    { tag: "Ai", icon: "✨", label: "AI" },
  ];

interface PropertyTypePickerProps {
  onSelect: (tag: PropertyTypeTag) => void;
}

/**
 * Pure list of property type options.
 * Positioning, outside-click, and Escape handling are delegated to FloatingPopup.
 */
export function PropertyTypePicker({ onSelect }: PropertyTypePickerProps) {
  return (
    <>
      <div className="px-3 py-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider border-b border-neutral-100 dark:border-neutral-700">
        Property type
      </div>
      {PROPERTY_TYPES.map(({ tag, icon, label }) => (
        <button
          key={tag}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
          onClick={() => onSelect(tag)}
        >
          <span className="w-4 text-center font-mono text-xs text-neutral-400 dark:text-neutral-500">
            {icon}
          </span>
          {label}
        </button>
      ))}
    </>
  );
}
