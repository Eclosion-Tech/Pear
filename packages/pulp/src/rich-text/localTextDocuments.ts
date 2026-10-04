import { useEffect } from "react";
import * as Y from "yjs";

const documents = new Map<string, Set<Y.Doc>>();

/** Separate editor/undo state per occurrence, immediate text updates per source. */
export function connectLocalTextDocument(namespace: string, id: bigint, doc: Y.Doc): () => void {
  const key = JSON.stringify([namespace, String(id)]);
  let peers = documents.get(key);
  if (!peers) { peers = new Set(); documents.set(key, peers); }
  for (const peer of peers) Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), "remote");
  peers.add(doc);
  const update = (data: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    for (const peer of peers) if (peer !== doc) Y.applyUpdate(peer, data, "remote");
  };
  doc.on("update", update);
  return () => {
    doc.off("update", update);
    peers.delete(doc);
    if (!peers.size && documents.get(key) === peers) documents.delete(key);
  };
}

export function useLocalTextDocument(namespace: string, id: bigint, doc: Y.Doc): void {
  useEffect(() => connectLocalTextDocument(namespace, id, doc), [namespace, id, doc]);
}
