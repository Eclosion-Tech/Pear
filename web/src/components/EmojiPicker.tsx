"use client";

import { useRef, useState } from "react";
import { FloatingPopup } from "./FloatingPopup";

const EMOJIS = [
  "📄", "📊", "📁", "📌", "📎", "📅", "📆", "📋", "🔗", "✏️",
  "📝", "🗂️", "📂", "🏷️", "⭐", "💡", "🔒", "✅", "❌", "💬",
  "📌", "🎯", "🚀", "📌", "🔔", "❤️", "🔥", "👍", "📌", "🏠",
];

interface EmojiPickerProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Current icon (emoji string) or undefined if none; null is treated as none. */
  currentIcon?: string | null;
  onSelect: (emoji: string | null) => void;
  onClose: () => void;
}

export function EmojiPicker({ anchorRef, currentIcon, onSelect, onClose }: EmojiPickerProps) {
  return (
    <FloatingPopup anchorRef={anchorRef} onClose={onClose} className="p-2 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl">
      <div className="grid grid-cols-6 gap-0.5 max-h-48 overflow-y-auto">
        <button
          type="button"
          onClick={() => { onSelect(null); onClose(); }}
          className="w-8 h-8 flex items-center justify-center rounded text-xs text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          title="Remove icon"
        >
          ✕
        </button>
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => { onSelect(emoji); onClose(); }}
            className={`w-8 h-8 flex items-center justify-center rounded text-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ${(currentIcon ?? undefined) === emoji ? "bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-500/50" : ""}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </FloatingPopup>
  );
}
