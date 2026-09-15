import pool from '../../config/database.js';
// RF-32: reutilización directa — NO reescribimos la query de contingencias.
// Esto garantiza que /api/dashboard/invoicing.pending_contingency sea IDÉNTICO
// a /api/invoicing/pending — misma función, imposible que se desincronicen.
import { getPendingContingency } from '../invoicing/invoicing.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Devuelve { from, to } como objetos Date.
 * Si no se pasan, usa el día de hoy (00:00:00 → 23:59:59.999 hora servidor).
 */
function resolveDateRange(from, to) {
  const now = new Date();

  let dateFrom;
  if (from) {
    dateFrom = new Date(from);
  } else {
    dateFrom = new Date(now);
    dateFrom.setHours(0, 0, 0, 0);
  }

  let dateTo;
  if (to) {
    dateTo = new Date(to);
  } else {
    dateTo = new Date(now);
    dateTo.setHours(23, 59, 59, 999);
  }

  return { dateFrom, dateTo };
}

// ─── Secciones del dashboard ──────────────────────────────────────────────────

/**
 * Resumen de ventas completadas en un rango de fechas.
 * Si no se pasan fechas, usa el día de hoy.
 *
 * @param {{ from?: string, to?: string }} param
 */
export async function getSalesSummary({ from, to } = {}) {
  const { dateFrom, dateTo } = resolveDateRange(from, to);

  // Totales generales
  const { rows: totals } = await pool.query(
    `SELECT
       COUNT(*)::INTEGER          AS total_sales_count,
       COALESCE(SUM(total), 0)    AS total_revenue
     FROM sales
     WHERE status    = 'completed'
       AND created_at >= $1
       AND created_at <= $2`,
    [dateFrom, dateTo]
  );

  // Desglose por método de pago
  const { rows: byPayment } = await pool.query(
    `SELECT
       payment_method,
       COUNT(*)::INTEGER       AS count,
       COALESCE(SUM(total), 0) AS revenue
     FROM sales
     WHERE status    = 'completed'
       AND created_at >= $1
       AND created_at <= $2
     GROUP BY payment_method
     ORDER BY revenue DESC`,
    [dateFrom, dateTo]
  );

  // Top 5 productos más vendidos (solo líneas con product_id, no kits)
  // Simplificación conocida: los kits se excluyen porque su unidad de medida
  // es el bundle, no el producto individual — incluirlos distorsionaría el ranking.
  const { rows: topProducts } = await pool.query(
    `SELECT
       p.id,
       p.name,
       p.sku,
       SUM(si.quantity)::INTEGER AS total_quantity_sold,
       SUM(si.subtotal)          AS total_revenue
     FROM   sale_items si
     JOIN   products   p  ON p.id = si.product_id
     JOIN   sales      s  ON s.id = si.sale_id
     WHERE  si.product_id IS NOT NULL
       AND  s.status     = 'completed'
       AND  s.created_at >= $1
       AND  s.created_at <= $2
     GROUP BY p.id, p.name, p.sku
     ORDER BY total_quantity_sold DESC
     LIMIT 5`,
    [dateFrom, dateTo]
  );

  return {
    period: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
    total_sales_count: totals[0].total_sales_count,
    total_revenue:     totals[0].total_revenue,
    revenue_by_payment_method: byPayment,
    top_products: topProducts,
  };
}

/**
 * Resumen del inventario: productos activos, stock bajo y valor total.
 */
export async function getInventorySummary() {
  // Total de productos activos
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::INTEGER AS total_active_products FROM products WHERE is_active = true`
  );

  // Productos con stock en o por debajo del mínimo
  const { rows: lowStock } = await pool.query(
    `SELECT id, name, sku, stock, min_stock
     FROM   products
     WHERE  is_active = true
       AND  stock <= min_stock
     ORDER  BY stock ASC`
  );

  // Valor total del inventario (stock × cost_price)
  const { rows: valueRows } = await pool.query(
    `SELECT ROUND(COALESCE(SUM(stock * cost_price), 0), 2) AS total_inventory_value
     FROM   products
     WHERE  is_active = true`
  );

  return {
    total_active_products:  countRows[0].total_active_products,
    low_stock_products:     lowStock,          // [] si no hay productos en stock bajo
    total_inventory_value:  valueRows[0].total_inventory_value,
  };
}

/**
 * Resumen de Órdenes de Trabajo: conteo por estado y total de OT activas.
 */
export async function getWorkOrdersSummary() {
  // Conteo por estado
  const { rows: byStatus } = await pool.query(
    `SELECT status, COUNT(*)::INTEGER AS count
     FROM   work_orders
     GROUP  BY status
     ORDER  BY count DESC`
  );

  // OT activas = cualquier estado excepto los estados finales
  const { rows: activeRows } = await pool.query(
    `SELECT COUNT(*)::INTEGER AS active_count
     FROM   work_orders
     WHERE  status NOT IN ('entregado', 'no_recogido')`
  );

  return {
    by_status:    byStatus,
    active_count: activeRows[0].active_count,
  };
}

/**
 * Resumen de facturación: conteo por estado y lista de comprobantes en contingencia.
 *
 * pending_contingency reutiliza getPendingContingency() de invoicing.service.js
 * directamente. NO se duplica la query — garantía de consistencia con
 * GET /api/invoicing/pending.
 */
export async function getInvoicingSummary() {
  // Conteo de comprobantes por estado
  const { rows: byEstado } = await pool.query(
    `SELECT estado, COUNT(*)::INTEGER AS count
     FROM   invoices
     GROUP  BY estado
     ORDER  BY count DESC`
  );

  // Reutilización directa — misma función, misma query, mismo resultado
  const pendingContingency = await getPendingContingency();

  return {
    by_estado:           byEstado,
    pending_contingency: pendingContingency,
  };
}

/**
 * Panel completo: llama a las 4 secciones en paralelo.
 * Si una sección falla individualmente, el error se propaga (Promise.all).
 *
 * @param {{ from?: string, to?: string }} param
 */
export async function getFullDashboard({ from, to } = {}) {
  const [sales, inventory, workorders, invoicing] = await Promise.all([
    getSalesSummary({ from, to }),
    getInventorySummary(),
    getWorkOrdersSummary(),
    getInvoicingSummary(),
  ]);

  return { sales, inventory, workorders, invoicing };
}
