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
 * Resumen de ventas completadas en un rango de fechas para la empresa dada.
 * Si no se pasan fechas, usa el día de hoy.
 *
 * @param {{ from?: string, to?: string }} param
 * @param {number} companyId
 */
export async function getSalesSummary({ from, to } = {}, companyId) {
  const { dateFrom, dateTo } = resolveDateRange(from, to);

  // Totales generales
  const { rows: totals } = await pool.query(
    `SELECT
       COUNT(*)::INTEGER          AS total_sales_count,
       COALESCE(SUM(total), 0)    AS total_revenue
     FROM sales
     WHERE company_id = $1
       AND status     = 'completed'
       AND created_at >= $2
       AND created_at <= $3`,
    [companyId, dateFrom, dateTo]
  );

  // Desglose por método de pago (RF-24: calculado desde sale_payments)
  const { rows: byPayment } = await pool.query(
    `SELECT
       sp.method               AS payment_method,
       COUNT(*)::INTEGER       AS count,
       COALESCE(SUM(sp.amount), 0) AS revenue
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     WHERE sp.company_id = $1
       AND s.company_id  = $1
       AND s.status      = 'completed'
       AND s.created_at >= $2
       AND s.created_at <= $3
     GROUP BY sp.method
     ORDER BY revenue DESC`,
    [companyId, dateFrom, dateTo]
  );

  // Top 5 productos más vendidos (solo líneas con product_id, no kits)
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
     WHERE  s.company_id = $1
       AND  si.product_id IS NOT NULL
       AND  s.status     = 'completed'
       AND  s.created_at >= $2
       AND  s.created_at <= $3
     GROUP BY p.id, p.name, p.sku
     ORDER BY total_quantity_sold DESC
     LIMIT 5`,
    [companyId, dateFrom, dateTo]
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
 * Resumen del inventario de la empresa: productos activos, stock bajo y valor total.
 * @param {number} companyId
 */
export async function getInventorySummary(companyId) {
  // Total de productos activos
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::INTEGER AS total_active_products FROM products WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );

  // Productos con stock en o por debajo del mínimo
  const { rows: lowStock } = await pool.query(
    `SELECT id, name, sku, stock, min_stock
     FROM   products
     WHERE  company_id = $1
       AND  is_active = true
       AND  stock <= min_stock
     ORDER  BY stock ASC`,
    [companyId]
  );

  // Valor total del inventario (stock × cost_price)
  const { rows: valueRows } = await pool.query(
    `SELECT ROUND(COALESCE(SUM(stock * cost_price), 0), 2) AS total_inventory_value
     FROM   products
     WHERE  company_id = $1 AND is_active = true`,
    [companyId]
  );

  return {
    total_active_products:  countRows[0].total_active_products,
    low_stock_products:     lowStock,          // [] si no hay productos en stock bajo
    total_inventory_value:  valueRows[0].total_inventory_value,
  };
}

/**
 * Resumen de Órdenes de Trabajo de la empresa: conteo por estado y total de OT activas.
 * @param {number} companyId
 */
export async function getWorkOrdersSummary(companyId) {
  // Conteo por estado
  const { rows: byStatus } = await pool.query(
    `SELECT status, COUNT(*)::INTEGER AS count
     FROM   work_orders
     WHERE  company_id = $1
     GROUP  BY status
     ORDER  BY count DESC`,
    [companyId]
  );

  // OT activas = cualquier estado excepto los estados finales
  const { rows: activeRows } = await pool.query(
    `SELECT COUNT(*)::INTEGER AS active_count
     FROM   work_orders
     WHERE  company_id = $1
       AND  status NOT IN ('entregado', 'no_recogido')`,
    [companyId]
  );

  return {
    by_status:    byStatus,
    active_count: activeRows[0].active_count,
  };
}

/**
 * Resumen de facturación de la empresa: conteo por estado, comprobantes en contingencia
 * y notas de crédito emitidas en el periodo (RF-23).
 *
 * @param {number|object} companyIdOrOptions
 * @param {object|number} optionsOrCompanyId
 */
export async function getInvoicingSummary(companyIdOrOptions, optionsOrCompanyId) {
  let companyId;
  let from;
  let to;

  if (typeof companyIdOrOptions === 'number') {
    companyId = companyIdOrOptions;
    from = optionsOrCompanyId?.from;
    to = optionsOrCompanyId?.to;
  } else {
    companyId = optionsOrCompanyId;
    from = companyIdOrOptions?.from;
    to = companyIdOrOptions?.to;
  }

  const { dateFrom, dateTo } = resolveDateRange(from, to);

  // Conteo de comprobantes por estado
  const { rows: byEstado } = await pool.query(
    `SELECT estado, COUNT(*)::INTEGER AS count
     FROM   invoices
     WHERE  company_id = $1
     GROUP  BY estado
     ORDER  BY count DESC`,
    [companyId]
  );

  // Reutilización directa — misma función, misma query, mismo resultado
  const pendingContingency = await getPendingContingency(companyId);

  // Notas de crédito del periodo
  const { rows: ncRows } = await pool.query(
    `SELECT
       COUNT(*)::INTEGER       AS count,
       COALESCE(SUM(total), 0) AS total
     FROM credit_notes
     WHERE company_id = $1
       AND estado     = 'accepted'
       AND created_at >= $2
       AND created_at <= $3`,
    [companyId, dateFrom, dateTo]
  );

  return {
    by_estado:           byEstado,
    pending_contingency: pendingContingency,
    credit_notes: {
      count: ncRows[0]?.count ?? 0,
      total: ncRows[0]?.total ?? 0,
    },
  };
}

/**
 * Panel completo: llama a las 4 secciones en paralelo para la empresa dada.
 * Si una sección falla individualmente, el error se propaga (Promise.all).
 *
 * @param {{ from?: string, to?: string }} param
 * @param {number} companyId
 */
export async function getFullDashboard({ from, to } = {}, companyId) {
  const [sales, inventory, workorders, invoicing, usersCountRes, totalSalesCountRes, companyRes] = await Promise.all([
    getSalesSummary({ from, to }, companyId),
    getInventorySummary(companyId),
    getWorkOrdersSummary(companyId),
    getInvoicingSummary({ from, to }, companyId),
    pool.query(`SELECT COUNT(*)::INTEGER AS count FROM users WHERE company_id = $1 AND is_active = true`, [companyId]),
    pool.query(`SELECT COUNT(*)::INTEGER AS count FROM sales WHERE company_id = $1 AND status = 'completed'`, [companyId]),
    pool.query(`SELECT ruc, logo_data FROM companies WHERE id = $1`, [companyId]),
  ]);

  const activeUsersCount = usersCountRes.rows[0]?.count ?? 0;
  const allTimeSalesCount = totalSalesCountRes.rows[0]?.count ?? 0;
  const companyData = companyRes.rows[0] ?? {};

  const onboarding = {
    has_ruc: Boolean(companyData.ruc),
    has_logo: Boolean(companyData.logo_data),
    active_users_count: activeUsersCount,
    total_active_products: inventory.total_active_products ?? 0,
    all_time_sales_count: allTimeSalesCount,
  };

  return { sales, inventory, workorders, invoicing, onboarding };
}
