"use client";

interface MeetingNotesBannerProps {
  showPermissionPrompt: boolean;
  showMeetingPrompt: boolean;
  /** True when the Tauri tray fired the pear-desktop-meeting-hint event. */
  fromDesktopTray?: boolean;
  onRequestPermission: () => void;
  onStartRecording: () => void;
  onDismiss: () => void;
}

/**
 * Notion-style floating hint: offer to capture notes when the browser exposes
 * microphone device labels that look like an active conferencing app.
 */
export function MeetingNotesBanner({
  showPermissionPrompt,
  showMeetingPrompt,
  fromDesktopTray,
  onRequestPermission,
  onStartRecording,
  onDismiss,
}: MeetingNotesBannerProps) {
  if (!showPermissionPrompt && !showMeetingPrompt) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 left-0 right-0 z-30 flex justify-center px-4">
      <div
        className="pointer-events-auto flex max-w-lg flex-col gap-3 rounded-xl border border-neutral-200 bg-white/95 p-4 shadow-lg backdrop-blur-md dark:border-neutral-700 dark:bg-neutral-900/95"
        role="status"
      >
        {showPermissionPrompt && (
          <>
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              Allow microphone access so Pear can detect when a conferencing app is using your mic
              (Zoom, Meet, Teams, and similar). Nothing is recorded until you choose to start.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                Not now
              </button>
              <button
                type="button"
                onClick={onRequestPermission}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                Allow microphone
              </button>
            </div>
          </>
        )}
        {showMeetingPrompt && !showPermissionPrompt && (
          <>
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              {fromDesktopTray
                ? "Capture notes on this page? (from Pear Desktop tray)"
                : "Looks like you might be in a call. Capture notes on this page?"}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={onStartRecording}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
              >
                Start recording
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
