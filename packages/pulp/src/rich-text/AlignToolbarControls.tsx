import type { TextAlign } from "./richTextFormatting";

export function AlignToolbarControls({
  align,
  onAlignChange,
}: {
  align: TextAlign;
  onAlignChange: (align: TextAlign) => void;
}) {
  return (
    <>
      <AlignButton align="left" active={align === "left"} onClick={() => onAlignChange("left")} />
      <AlignButton
        align="center"
        active={align === "center"}
        onClick={() => onAlignChange("center")}
      />
      <AlignButton align="right" active={align === "right"} onClick={() => onAlignChange("right")} />
    </>
  );
}

function AlignButton({
  align,
  active,
  onClick,
}: {
  align: TextAlign;
  active: boolean;
  onClick: () => void;
}) {
  const label =
    align === "left" ? "Align left" : align === "center" ? "Align center" : "Align right";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`min-w-[28px] rounded px-1.5 py-1 transition-colors ${
        active
          ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-white"
          : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      }`}
    >
      {align === "left" ? (
        <AlignLeftIcon />
      ) : align === "center" ? (
        <AlignCenterIcon />
      ) : (
        <AlignRightIcon />
      )}
    </button>
  );
}

function AlignLeftIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 6h18" /><path d="M3 12h12" /><path d="M3 18h16" />
    </svg>
  );
}

function AlignCenterIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 6h18" /><path d="M6 12h12" /><path d="M4 18h16" />
    </svg>
  );
}

function AlignRightIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 6h18" /><path d="M9 12h12" /><path d="M5 18h16" />
    </svg>
  );
}
