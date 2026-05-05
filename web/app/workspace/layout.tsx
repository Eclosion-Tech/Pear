import { Suspense } from "react";
import { WorkspaceShell } from "@/src/components/WorkspaceShell";

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <div className="h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-200 overflow-hidden" />
      }
    >
      <WorkspaceShell>{children}</WorkspaceShell>
    </Suspense>
  );
}
