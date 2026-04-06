"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Heuristic: after the browser exposes audio input labels (requires microphone
 * permission), many conferencing apps register devices whose labels mention
 * Zoom, Meet, Teams, etc. This is the same class of signal desktop apps use
 * for “meeting detected” hints; it is best-effort and may be false negative.
 */
const MEETING_DEVICE_LABEL_RE =
  /zoom|google meet|teams|microsoft teams|webex|slack|discord|facetime|meet\.google|\.zoom\.|whereby|around|jitsi|webinar|ringcentral|gotomeeting|bluejeans|skype/i;

const SESSION_BANNER_DISMISS = "pear-meeting-banner-dismissed";

const DESKTOP_MEETING_EVENT = "pear-desktop-meeting-hint";

export function useMeetingCallDetection() {
  const [detected, setDetected] = useState(false);
  const [needsPermissionHint, setNeedsPermissionHint] = useState(false);
  /** Tauri tray injects {@link DESKTOP_MEETING_EVENT} — works without mic label heuristics. */
  const [desktopTrayHint, setDesktopTrayHint] = useState(false);

  const scan = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      setDetected(false);
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const hit = inputs.some((d) => d.label && MEETING_DEVICE_LABEL_RE.test(d.label));
      setDetected(hit);
    } catch {
      setDetected(false);
    }
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

    let cancelled = false;

    async function init() {
      try {
        const perm = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        if (cancelled) return;
        if (perm.state === "denied") {
          setNeedsPermissionHint(false);
          setDetected(false);
          return;
        }
        if (perm.state === "granted") {
          setNeedsPermissionHint(false);
          await scan();
        } else {
          setNeedsPermissionHint(true);
        }
        perm.onchange = () => {
          if (perm.state === "granted") {
            setNeedsPermissionHint(false);
            void scan();
          }
          if (perm.state === "denied") {
            setNeedsPermissionHint(false);
            setDetected(false);
          }
        };
      } catch {
        await scan();
      }
    }

    void init();

    const onDeviceChange = () => void scan();
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    const iv = window.setInterval(() => void scan(), 45_000);

    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      clearInterval(iv);
    };
  }, [scan]);

  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setNeedsPermissionHint(false);
      await scan();
    } catch {
      setNeedsPermissionHint(false);
    }
  }, [scan]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onTray = () => setDesktopTrayHint(true);
    window.addEventListener(DESKTOP_MEETING_EVENT, onTray);
    return () => window.removeEventListener(DESKTOP_MEETING_EVENT, onTray);
  }, []);

  const clearDesktopTrayHint = useCallback(() => setDesktopTrayHint(false), []);

  return {
    detected,
    needsPermissionHint,
    requestPermission,
    desktopTrayHint,
    clearDesktopTrayHint,
  };
}

export function readMeetingBannerDismissedSession(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  return sessionStorage.getItem(SESSION_BANNER_DISMISS) === "1";
}

export function setMeetingBannerDismissedSession() {
  sessionStorage.setItem(SESSION_BANNER_DISMISS, "1");
}
