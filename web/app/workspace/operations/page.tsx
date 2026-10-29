import { ProductOperationsOidcPanel } from '@/src/components/ProductOperationsOidcPanel';
import { operationsProducts } from '@/src/lib/product-operations/proxy';

export const dynamic = 'force-dynamic';
export default function ProductOperationsPage() {
  const workspaceSlug = process.env.PRODUCT_OPERATIONS_WORKSPACE_SLUG ?? '';
  const products = process.env.PRODUCT_OPERATIONS_SERVICE_URL ? operationsProducts(process.env.PRODUCT_OPERATIONS_UI_PRODUCTS, workspaceSlug) : [];
  return <ProductOperationsOidcPanel workspaceSlug={workspaceSlug} products={products} />;
}
