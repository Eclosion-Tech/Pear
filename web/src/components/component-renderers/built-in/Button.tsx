"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { BlockRendererProps } from "@eclosion-tech/pulp";
import { useFormContext } from "../FormContext";
import {
  useGeneratedUiInteraction,
  type GeneratedAutomationAction,
} from "../GeneratedUiInteractionContext";

/**
 * Built-in `Button` — action trigger with sprint-4 wiring for common types.
 */
type ButtonProps = {
  label?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  action?: {
    type?: string;
    pageId?: string | number;
    url?: string;
    automationId?: string | number;
    input?: Record<string, unknown>;
    confirmation?: string;
  };
};

const VARIANT_CLASS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    "bg-indigo-600 hover:bg-indigo-500 text-white border-transparent",
  secondary:
    "bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-neutral-900 dark:text-neutral-100 border-neutral-200 dark:border-neutral-700",
  danger:
    "bg-red-600 hover:bg-red-500 text-white border-transparent",
  ghost:
    "bg-transparent hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-transparent",
};

export function ButtonRenderer({ node }: BlockRendererProps) {
  const props = useMemo<ButtonProps>(() => safeParse(node.props), [node.props]);
  const router = useRouter();
  const form = useFormContext();
  const generatedUi = useGeneratedUiInteraction();
  const variant = props.variant ?? "secondary";
  const cls = VARIANT_CLASS[variant];
  const actionType = props.action?.type;

  const wired =
    actionType === "submit_form" ||
    actionType === "navigate" ||
    actionType === "open_url" ||
    (actionType === "trigger_automation" && generatedUi != null);
  const invocationStatus = generatedUi?.statusFor(node.id) ?? {
    busy: false,
    tone: "idle" as const,
    message: null,
  };

  async function handleClick() {
    switch (actionType) {
      case "submit_form":
        form?.requestSubmit();
        break;
      case "navigate": {
        const raw = props.action?.pageId;
        if (raw == null || raw === "") return;
        router.push(`/workspace/${String(raw)}`);
        break;
      }
      case "open_url": {
        const url = props.action?.url;
        if (!url) return;
        window.open(url, "_blank", "noopener,noreferrer");
        break;
      }
      case "trigger_automation": {
        if (!generatedUi) return;
        const confirmation = props.action?.confirmation;
        if (confirmation && !window.confirm(confirmation)) return;
        await generatedUi.invoke(node.id, props.action as GeneratedAutomationAction);
        break;
      }
      default:
        break;
    }
  }

  return (
    <div className="my-1 flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={!wired || invocationStatus.busy}
        onClick={() => void handleClick()}
        title={
          wired
            ? undefined
            : `Action "${actionType ?? "(unset)"}" is not available in this surface`
        }
        className={`inline-flex items-center justify-center rounded-md
                    border px-4 py-1.5 text-sm font-medium
                    transition-colors disabled:cursor-not-allowed disabled:opacity-80
                    ${cls}`}
      >
        {invocationStatus.busy ? "Working…" : (props.label ?? "Button")}
      </button>
      {invocationStatus.message && (
        <span
          role={invocationStatus.tone === "error" ? "alert" : "status"}
          className={`text-xs ${
            invocationStatus.tone === "error"
              ? "text-red-600 dark:text-red-400"
              : invocationStatus.tone === "success"
                ? "text-green-700 dark:text-green-400"
                : "text-neutral-500 dark:text-neutral-400"
          }`}
        >
          {invocationStatus.message}
        </span>
      )}
    </div>
  );
}

function safeParse(s: string): ButtonProps {
  try {
    return JSON.parse(s) as ButtonProps;
  } catch {
    return {};
  }
}
