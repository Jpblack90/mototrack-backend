import pool from '../../config/database.js';

export async function getAll() {
  const { rows } = await pool.query('SELECT * FROM invoices ORDER BY id ASC');
  return rows;
}

export async function getById(id) {
  const { rows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function create(data) {
  const { sale_id, customer_ruc, customer_name, serie, correlativo, total_amount, igv, status } = data;
  const { rows } = await pool.query(
    `INSERT INTO invoices
       (sale_id, customer_ruc, customer_name, serie, correlativo, total_amount, igv, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [sale_id, customer_ruc, customer_name, serie, correlativo, total_amount, igv, status ?? 'draft']
  );
  return rows[0];
}

export async function update(id, data) {
  const { status, sunat_response } = data;
  const { rows } = await pool.query(
    `UPDATE invoices
     SET status=$1, sunat_response=$2, updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [status, JSON.stringify(sunat_response ?? {}), id]
  );
  return rows[0] ?? null;
}

export async function remove(id) {
  await pool.query('DELETE FROM invoices WHERE id = $1', [id]);
}
