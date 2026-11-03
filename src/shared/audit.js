/**
 * Helper transaccional de auditoría para MotoTrack AI.
 * Participa estrictamente en la transacción abierta del cliente PostgreSQL.
 */

/**
 * Inserta un registro de auditoría utilizando el cliente de la transacción activa.
 * Si la transacción hace ROLLBACK, el log se descarta.
 * Si falla la inserción, lanza error provocando el rollback de la operación.
 *
 * @param {import('pg').PoolClient} client  Cliente con transacción abierta (BEGIN)
 * @param {object} param1
 * @param {number} param1.companyId
 * @param {number|null} [param1.userId]
 * @param {string} param1.entity            'product' | 'sale' | 'invoice' | 'user' | 'company'
 * @param {number|null} [param1.entityId]
 * @param {string} param1.action            'create' | 'update' | 'deactivate' | 'reactivate' | 'void' | 'retry_contingency' | 'role_change' | 'password_reset' | 'forced_negative_margin'
 * @param {object|null} [param1.changes]    { [campo]: { old, new } } o resumen estructurado
 */
export async function logAudit(client, {
  companyId,
  userId = null,
  entity,
  entityId = null,
  action,
  changes = null,
}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('logAudit requiere un cliente de PostgreSQL (PoolClient) con transacción activa.');
  }

  await client.query(
    `INSERT INTO audit_logs (company_id, user_id, entity, entity_id, action, changes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      companyId,
      userId ?? null,
      entity,
      entityId != null ? Number(entityId) : null,
      action,
      changes ? JSON.stringify(changes) : null,
    ]
  );
}

/**
 * Compara dos objetos sobre una lista de campos y devuelve un mapa de diferencias:
 * { [campo]: { old, new } }
 *
 * @param {object} oldObj
 * @param {object} newObj
 * @param {string[]} trackedFields
 * @returns {object|null} Diferencias encontradas o null si son idénticos
 */
export function diffObjects(oldObj = {}, newObj = {}, trackedFields = []) {
  const diff = {};
  let hasChanges = false;

  for (const field of trackedFields) {
    if (newObj[field] === undefined) continue;

    const oldVal = oldObj[field];
    const newVal = newObj[field];

    // Comparación especial para arrays (ej. compatible_models)
    if (Array.isArray(oldVal) || Array.isArray(newVal)) {
      const oldArr = Array.isArray(oldVal) ? oldVal : [];
      const newArr = Array.isArray(newVal) ? newVal : [];
      const oldSorted = [...oldArr].sort().join('|');
      const newSorted = [...newArr].sort().join('|');

      if (oldSorted !== newSorted) {
        diff[field] = { old: oldArr, new: newArr };
        hasChanges = true;
      }
      continue;
    }

    // Comparación para números (manejando strings numéricos de Postgres NUMERIC)
    if (
      (typeof oldVal === 'number' || !isNaN(Number(oldVal))) &&
      (typeof newVal === 'number' || !isNaN(Number(newVal))) &&
      oldVal !== null &&
      newVal !== null
    ) {
      if (Number(oldVal) !== Number(newVal)) {
        diff[field] = { old: Number(oldVal), new: Number(newVal) };
        hasChanges = true;
      }
      continue;
    }

    // Comparación para strings / null / booleanos
    const normalizedOld = typeof oldVal === 'string' ? oldVal.trim() : oldVal;
    const normalizedNew = typeof newVal === 'string' ? newVal.trim() : newVal;

    if (normalizedOld !== normalizedNew) {
      diff[field] = { old: normalizedOld ?? null, new: normalizedNew ?? null };
      hasChanges = true;
    }
  }

  return hasChanges ? diff : null;
}
