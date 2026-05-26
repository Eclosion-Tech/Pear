"use client";

import { useCallback, useMemo } from "react";
import { usePulp, type BlockRendererProps } from "@eclosion-tech/pulp";
import { useAudioAttachment } from "@/src/components/AudioAttachmentContext";
import { AudioBlockContent } from "@/src/components/media/AudioBlockContent";

/**
 * Built-in `Audio` — recording / upload with transcript.
 *
 * Prop schema (`prop_schemas::AUDIO` in components.rs):
 *   { storageKey?, transcript?, durationSec?, boot? }
 */
type AudioProps = {
  storageKey?: string;
  transcript?: string;
  durationSec?: number;
  boot?: string;
};

export function AudioRenderer({ node }: BlockRendererProps) {
  const props = useMemo<AudioProps>(() => safeParse(node.props), [node.props]);
  const { updateBlockProps } = usePulp();
  const ctx = useAudioAttachment();

  const onPatch = useCallback(
    (patch: Partial<AudioProps>) => {
      updateBlockProps({
        componentId: node.id,
        propsJson: JSON.stringify({ ...props, ...patch }),
      });
    },
    [node.id, props, updateBlockProps],
  );

  return (
    <AudioBlockContent
      storageKey={props.storageKey ?? ""}
      transcript={props.transcript ?? ""}
      durationSec={props.durationSec ?? 0}
      boot={props.boot ?? ""}
      onPatch={onPatch}
      attachmentCtx={ctx}
    />
  );
}

function safeParse(s: string): AudioProps {
  try {
    return JSON.parse(s) as AudioProps;
  } catch {
    return {};
  }
}
