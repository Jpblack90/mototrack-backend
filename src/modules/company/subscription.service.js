import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { logAudit } from '../../shared/audit.js';

const VALID_METHODS = ['yape', 'plin', 'transferencia', 'efectivo'];

/**
 * Retorna la fecha actual en la zona horaria America/Lima en formato YYYY-MM-DD.
 */
export function getLimaDateStr() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Convierte un valor de fecha (Date o String) a formato YYYY-MM-DD sin desplazamiento de zona horaria.
 * @param {string|Date} val
 * @returns {string|null}
 */
export function toDateStr(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(val);
  }
  return String(val).slice(0, 10);
}

/**
 * Calcula la diferencia en días enteros entre dos fechas YYYY-MM-DD (d2 - d1).
 */
export function diffDays(d1Str, d2Str) {
  const [y1, m1, day1] = d1Str.split('-').map(Number);
  const [y2, m2, day2] = d2Str.split('-').map(Number);
  const utc1 = Date.UTC(y1, m1 - 1, day1);
  const utc2 = Date.UTC(y2, m2 - 1, day2);
  return Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24));
}

/**
 * Registra un pago de suscripción de forma atómica en una transacción.
 *
 * @param {object} params
 * @param {number} params.companyId ID de la empresa
 * @param {number|string} params.amount Monto del pago en S/
 * @param {string} params.method Método ('yape', 'plin', 'transferencia', 'efectivo')
 * @param {string} [params.reference] N.º de operación o referencia
 * @param {number} [params.months=1] Meses contratados (1 a 12)
 * @param {string} [params.notes] Notas u observaciones adicionales
 * @param {object} [params.client] Cliente pg existente (opcional)
 */
export async function recordPayment({
  companyId,
  amount,
  method,
  reference = null,
  months = 1,
  notes = null,
  client = null,
}) {
  const cId = parseInt(companyId, 10);
  if (!cId || isNaN(cId)) {
    throw new AppError('El ID de empresa debe ser un número válido.', 'INVALID_INPUT', 422);
  }

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new AppError('El monto debe ser un número positivo mayor a 0.', 'INVALID_INPUT', 422);
  }

  const cleanMethod = String(method || '').trim().toLowerCase();
  if (!VALID_METHODS.includes(cleanMethod)) {
    throw new AppError(
      `Método de pago inválido. Permitidos: ${VALID_METHODS.join(', ')}.`,
      'INVALID_INPUT',
      422
    );
  }

  const numMonths = parseInt(months, 10);
  if (isNaN(numMonths) || numMonths < 1 || numMonths > 12) {
    throw new AppError('Los meses deben ser un entero entre 1 y 12.', 'INVALID_INPUT', 422);
  }

  const cleanRef = reference ? String(reference).trim().slice(0, 60) : null;
  const cleanNotes = notes ? String(notes).trim() : null;

  const runWithClient = async (db) => {
    // 1. Obtener estado actual de la empresa con bloqueo FOR UPDATE
    const { rows: companyRows } = await db.query(
      `SELECT id, razon_social, nombre_comercial, status, is_active, trial_ends_at, paid_until::text AS paid_until
       FROM companies
       WHERE id = $1
       FOR UPDATE`,
      [cId]
    );

    if (companyRows.length === 0) {
      throw new AppError(`Empresa #${cId} no encontrada.`, 'NOT_FOUND', 404);
    }

    const prevCompany = companyRows[0];

    // 2. Calcular period_from y period_to en PostgreSQL según regla de negocio
    // Si extiende una suscripción vigente (paid_until >= hoy):
    // - period_from: día siguiente al vencimiento anterior (evita solapamiento)
    // - period_to: paid_until + N meses (el nuevo vencimiento; cálculo de paid_until NO cambia)
    // Si la suscripción no está vigente (paid_until < hoy o NULL):
    // - period_from: hoy
    // - period_to: hoy + N meses
    const { rows: calcRows } = await db.query(
      `SELECT
         (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date::text AS hoy,
         CASE
           WHEN $1::date IS NOT NULL AND $1::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date
             THEN ($1::date + INTERVAL '1 day')::date::text
           ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date::text
         END AS period_from,
         (GREATEST(COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date), (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date) + ($2 || ' months')::interval)::date::text AS period_to`,
      [prevCompany.paid_until, numMonths]
    );

    const { period_from, period_to } = calcRows[0];

    // 3. Insertar pago en subscription_payments
    const { rows: payRows } = await db.query(
      `INSERT INTO subscription_payments (company_id, amount, method, reference, months, period_from, period_to, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, company_id, amount, method, reference, months, period_from::text, period_to::text, notes, created_at`,
      [cId, numAmount, cleanMethod, cleanRef, numMonths, period_from, period_to, cleanNotes]
    );

    const payment = {
      ...payRows[0],
      amount: Number(payRows[0].amount),
    };

    // 4. Actualizar estado de la empresa a 'active' con nuevo paid_until y trial_ends_at en NULL
    const { rows: updatedRows } = await db.query(
      `UPDATE companies
       SET status = 'active',
           is_active = true,
           paid_until = $2::date,
           trial_ends_at = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, razon_social, nombre_comercial, status, is_active, trial_ends_at, paid_until::text AS paid_until`,
      [cId, period_to]
    );

    const updatedCompany = updatedRows[0];

    // 5. Registrar en audit_logs (inmutable, user_id NULL para operaciones administrativas externas)
    await logAudit(db, {
      companyId: cId,
      userId: null,
      entity: 'company',
      entityId: cId,
      action: 'subscription_payment',
      changes: {
        payment_id: payment.id,
        amount: numAmount,
        method: cleanMethod,
        reference: cleanRef,
        months: numMonths,
        period_from,
        period_to,
        paid_until: { old: prevCompany.paid_until, new: period_to },
        status: { old: prevCompany.status, new: 'active' },
        trial_ends_at: { old: prevCompany.trial_ends_at, new: null },
      },
    });

    return {
      payment,
      company: updatedCompany,
      previous: prevCompany,
    };
  };

  if (client) {
    return await runWithClient(client);
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const result = await runWithClient(dbClient);
    await dbClient.query('COMMIT');
    return result;
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
}

/**
 * Job: Marca como 'suspended' todas las empresas 'active' cuyo paid_until + días de gracia sea menor a hoy.
 * Idempotente, seguro ante múltiples instancias concurrentes y auditado.
 *
 * @param {number} [customGraceDays] Días de gracia (por defecto variable de entorno BILLING_GRACE_DAYS o 5)
 */
export async function markOverdueSubscriptions(customGraceDays = null) {
  const envGrace = process.env.BILLING_GRACE_DAYS;
  const graceDays =
    customGraceDays !== null && customGraceDays !== undefined
      ? Number(customGraceDays)
      : envGrace !== undefined && envGrace !== ''
        ? Number(envGrace)
        : 5;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Actualización atómica de empresas activas con paid_until que pasaron el periodo de gracia
    const updateQuery = `
      UPDATE companies
      SET status = 'suspended',
          updated_at = NOW()
      WHERE status = 'active'
        AND paid_until IS NOT NULL
        AND (paid_until + ($1 || ' days')::interval)::date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Lima')::date
      RETURNING id, razon_social, nombre_comercial, paid_until::text AS paid_until
    `;

    const { rows } = await client.query(updateQuery, [graceDays]);

    // Registrar auditoría para cada empresa suspendida automáticamente
    for (const row of rows) {
      await logAudit(client, {
        companyId: row.id,
        userId: null,
        entity: 'company',
        entityId: row.id,
        action: 'auto_suspend',
        changes: {
          status: { old: 'active', new: 'suspended' },
          paid_until: row.paid_until,
          grace_days: graceDays,
          suspended_at: new Date().toISOString(),
        },
      });
    }

    await client.query('COMMIT');

    return {
      suspended: rows.length,
      grace_days: graceDays,
      companies: rows.map((r) => ({
        id: r.id,
        name: r.nombre_comercial || r.razon_social,
        paid_until: r.paid_until,
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Obtiene el historial de pagos de suscripción de una empresa.
 * @param {number} companyId
 */
export async function getCompanyPayments(companyId) {
  const { rows } = await pool.query(
    `SELECT id, amount, method, reference, months,
            period_from::text AS period_from,
            period_to::text AS period_to,
            notes, created_at
     FROM subscription_payments
     WHERE company_id = $1
     ORDER BY id DESC`,
    [companyId]
  );

  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount),
    method: r.method,
    reference: r.reference || null,
    months: r.months,
    period_from: r.period_from,
    period_to: r.period_to,
    notes: r.notes || null,
    created_at: r.created_at,
  }));
}

/**
 * Calcula la información y estado de facturación para la respuesta de /api/company/plan.
 *
 * @param {object} company Objeto de empresa con status, paid_until, trial_ends_at
 * @param {string|null} role Rol del usuario consultante ('admin', 'cajero', etc.)
 * @param {object} [client] Cliente de BD opcional
 */
export async function getBillingInfo(company, role = null, client = null) {
  const db = client || pool;
  const hoyStr = getLimaDateStr();
  const envGrace = process.env.BILLING_GRACE_DAYS;
  const graceDays = envGrace !== undefined && envGrace !== '' ? Number(envGrace) : 5;

  const paidUntilStr = toDateStr(company.paid_until);

  let billingStatus = 'active';
  let daysLeft = null;
  let graceDaysLeft = null;

  if (company.status === 'suspended') {
    billingStatus = 'suspended';
    daysLeft = 0;
    graceDaysLeft = 0;
  } else if (!paidUntilStr) {
    // Si paid_until es NULL
    if (company.status === 'trial') {
      billingStatus = 'trial';
      if (company.trial_ends_at) {
        const trialEndStr = toDateStr(company.trial_ends_at);
        daysLeft = Math.max(0, diffDays(hoyStr, trialEndStr));
      }
    } else {
      // Empresas internas / demo con paid_until NULL y status 'active' no vencen nunca
      billingStatus = 'active';
      daysLeft = null;
      graceDaysLeft = null;
    }
  } else {
    // paid_until está presente
    const daysUntilDue = diffDays(hoyStr, paidUntilStr);

    if (daysUntilDue >= 0) {
      billingStatus = 'active';
      daysLeft = daysUntilDue;
      graceDaysLeft = null;
    } else {
      // Venció (paid_until < hoy)
      const daysOverdue = Math.abs(daysUntilDue);
      if (daysOverdue <= graceDays) {
        billingStatus = 'grace';
        daysLeft = 0;
        graceDaysLeft = graceDays - daysOverdue;
      } else {
        billingStatus = 'suspended';
        daysLeft = 0;
        graceDaysLeft = 0;
      }
    }
  }

  // Último pago registrado
  const { rows: payRows } = await db.query(
    `SELECT created_at, amount, method
     FROM subscription_payments
     WHERE company_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [company.id]
  );

  const lastPayment = payRows.length > 0
    ? {
        date: payRows[0].created_at,
        amount: Number(payRows[0].amount),
        method: payRows[0].method,
      }
    : null;

  // Las instrucciones de pago solo se incluyen para rol admin
  const paymentInstructions =
    role === 'admin' && process.env.PAYMENT_INSTRUCTIONS?.trim()
      ? process.env.PAYMENT_INSTRUCTIONS.trim()
      : null;

  return {
    status: billingStatus,
    paid_until: paidUntilStr,
    days_left: daysLeft,
    grace_days_left: graceDaysLeft,
    last_payment: lastPayment,
    payment_instructions: paymentInstructions,
  };
}
