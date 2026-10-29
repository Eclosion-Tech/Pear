export default function WorkspacePage() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <p className="text-neutral-600 text-sm">
          Select a page from the sidebar, or create a new one.
        </p>
        {process.env.PRODUCT_OPERATIONS_SERVICE_URL && process.env.PRODUCT_OPERATIONS_UI_PRODUCTS && <a href="/workspace/operations" className="mt-5 inline-block text-sm text-emerald-700 underline underline-offset-4 dark:text-emerald-400">Open product operations</a>}
      </div>
    </div>
  );
}
