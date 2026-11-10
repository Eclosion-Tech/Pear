"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  canonicalJson,
  connectionIdentity,
  type AuthoredComponent,
  type ComponentDataAdapter,
  type OpenRecordRef,
} from "@eclosion-tech/trellis";
import { blockReferenceHref } from "@/src/lib/blockReferenceLink";

type RecordRef = OpenRecordRef & { surfaceId: string };
type Options = {
  workspace: string | undefined;
  surfaceId: string | undefined;
  principal: string;
  sources: AuthoredComponent["sources"] | undefined;
  read: () => AuthoredComponent;
  adapter: ComponentDataAdapter;
  openPanel: (ref: RecordRef) => void;
};

/** Trellis emits identities; only Pear knows that database records are pages. */
export function useOpenWorkspaceRecord(options: Options) {
  const router = useRouter();
  const live = useRef(options);
  live.current = options;
  const pending = useRef<AbortController | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => () => pending.current?.abort(), [
    options.workspace, options.surfaceId, options.principal, options.sources, options.adapter,
  ]);

  const onOpenRecord = useCallback(async (ref: RecordRef) => {
    const owner = live.current;
    // Standalone Pear has no slug; Trellis represents that workspace as "".
    if (ref.workspace !== (owner.workspace ?? "") || ref.surfaceId !== owner.surfaceId) return;
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    const url = window.location.href;
    const current = () => !request.signal.aborted &&
      live.current.workspace === owner.workspace && live.current.surfaceId === owner.surfaceId &&
      live.current.principal === owner.principal && live.current.sources === owner.sources &&
      live.current.adapter === owner.adapter && window.location.href === url;
    const sourceFrom = (saved: AuthoredComponent) =>
      Object.hasOwn(saved.sources, ref.source) ? saved.sources[ref.source] : undefined;
    setMessage("Loading record…");
    try {
      const source = sourceFrom(owner.read());
      if (!source?.connection || await connectionIdentity(source.connection) !== ref.connectionIdentity) {
        if (current()) setMessage("This record source is unavailable or has changed.");
        return;
      }
      if (!current()) return;
      if (source.connection.adapter !== "pear.database") {
        setMessage(null);
        owner.openPanel(ref);
        return;
      }
      // IDs are local page identities, never arbitrary URLs supplied by a source.
      if (!/^[1-9]\d*$/.test(ref.recordId) || !owner.adapter.read) {
        setMessage("This record is unavailable.");
        return;
      }
      const result = await owner.adapter.read(source, ref.recordId, { signal: request.signal });
      if (!current()) return;
      // A reconnect/deletion can arrive while the read is in flight.
      const latest = sourceFrom(live.current.read());
      if (!latest || canonicalJson(latest) !== canonicalJson(source)) {
        setMessage("This record source is unavailable or has changed.");
        return;
      }
      if (result.status !== "ready" || result.record?.id !== ref.recordId) {
        setMessage(result.message ?? "This record is unavailable.");
        return;
      }
      setMessage(null);
      // One router entry preserves the dashboard URL and Next's Back/scroll state.
      router.push(blockReferenceHref({ surfaceId: BigInt(result.record.id) }, owner.workspace));
    } catch {
      if (current()) setMessage("This record is unavailable.");
    }
  }, [router]);

  return { onOpenRecord, message };
}
