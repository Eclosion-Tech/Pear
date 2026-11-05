"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RecordDetailView } from "@eclosion-tech/trellis-react";
import {
  connectionIdentity,
  type ComponentDataAdapter,
  type ComponentSource,
  type OpenRecordRef,
} from "@eclosion-tech/trellis";

type PanelRecordRef = OpenRecordRef & { surfaceId: string };
const historyChanged = "pear:open-record";

function historyRecord(state: unknown): PanelRecordRef | null {
  if (!state || typeof state !== "object" || !("pearOpenRecord" in state)) return null;
  const ref = state.pearOpenRecord;
  if (!ref || typeof ref !== "object") return null;
  for (const field of ["workspace", "surfaceId", "connectionIdentity", "source", "recordId"] as const) {
    if (!(field in ref) || typeof ref[field as keyof typeof ref] !== "string") return null;
  }
  return ref as PanelRecordRef;
}

/** History is shared by all component instances; only the matching owner opens. */
export function useOpenRecordPanel(workspace: string | undefined, surfaceId: string | undefined) {
  const [record, setRecord] = useState<PanelRecordRef | null>(null);
  const closing = useRef(false);
  useEffect(() => {
    const restore = () => {
      closing.current = false;
      setRecord(historyRecord(window.history.state));
    };
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener(historyChanged, restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener(historyChanged, restore);
    };
  }, []);
  const onOpenRecord = useCallback((ref: PanelRecordRef) => {
    if (ref.workspace !== workspace || ref.surfaceId !== surfaceId) return;
    window.history.pushState({ pearOpenRecord: ref }, "");
    // pushState does not emit popstate. Notify other mounted component owners.
    window.dispatchEvent(new Event(historyChanged));
  }, [workspace, surfaceId]);
  const onClose = useCallback(() => {
    const current = historyRecord(window.history.state);
    if (closing.current || current?.workspace !== workspace || current?.surfaceId !== surfaceId) return;
    closing.current = true;
    window.history.back();
  }, [workspace, surfaceId]);
  return {
    openRecord: record?.workspace === workspace && record?.surfaceId === surfaceId ? record : null,
    onOpenRecord,
    onClose,
  };
}

export function RecordDetailPanel({ recordRef, source, adapter, onClose }: {
  recordRef: PanelRecordRef;
  source: ComponentSource | undefined;
  adapter: ComponentDataAdapter;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<{
    source: ComponentSource | undefined;
    identity: string;
    matches: boolean;
  } | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const finish = (matches: boolean) => {
      if (!cancelled) setChecked({ source, identity: recordRef.connectionIdentity, matches });
    };
    // A saved history entry must never follow a source that has been reconnected.
    if (source?.connection) {
      void connectionIdentity(source.connection).then(
        identity => finish(identity === recordRef.connectionIdentity),
        () => finish(false),
      );
    } else finish(false);
    return () => { cancelled = true; };
  }, [source, recordRef.connectionIdentity]);
  const resolved = checked?.source === source && checked?.identity === recordRef.connectionIdentity;
  return createPortal(
    <aside
      role="dialog"
      aria-label="Record details"
      className="trellis-authored-component fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <button ref={closeButton} type="button" onClick={onClose} aria-label="Close record details">
        Close
      </button>
      {!resolved ? <p role="status">Loading record…</p> : checked?.matches && source ? (
        <RecordDetailView source={source} recordId={recordRef.recordId} adapter={adapter} />
      ) : <p role="status">This record source is unavailable or has changed.</p>}
    </aside>,
    document.body,
  );
}
