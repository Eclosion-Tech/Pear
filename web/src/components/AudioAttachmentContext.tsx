"use client";

import { createContext, useContext } from "react";

export type CreateAttachmentFn = (params: {
  pageId: bigint;
  filename: string;
  contentType: string;
  storageKey: string;
  sizeBytes: bigint;
}) => void;

export const AudioAttachmentContext = createContext<{
  pageId: bigint;
  createAttachment: CreateAttachmentFn;
} | null>(null);

export function useAudioAttachment() {
  const ctx = useContext(AudioAttachmentContext);
  return ctx;
}
