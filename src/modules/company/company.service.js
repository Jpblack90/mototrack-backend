import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { logAudit, diffObjects } from '../../shared/audit.js';

/**
 * Valida un número de RUC peruano según el algoritmo oficial de SUNAT (Módulo 11).
 * @param {string} ruc
 * @returns {boolean}
 */
export function validateSunatRuc(ruc) {
  if (typeof ruc !== 'string' || !/^\d{11}$/.test(ruc)) {
    return false;
  }
  const prefix = ruc.slice(0, 2);
  const validPrefixes = ['10', '15', '16', '17', '20'];
  if (!validPrefixes.includes(prefix)) {
    return false;
  }

  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(ruc[i], 10) * weights[i];
  }

  const residue = sum % 11;
  const diff = 11 - residue;
  const checkDigit = diff === 10 ? 0 : (diff === 11 ? 1 : diff);

  return checkDigit === parseInt(ruc[10], 10);
}

/**
 * Obtiene los datos de configuración de una empresa por ID.
 * @param {number} companyId
 */
export async function getById(companyId) {
  const result = await pool.query(
    `SELECT id, ruc, razon_social, nombre_comercial, direccion, telefono, email,
            logo_data, igv_rate, approval_threshold, not_picked_up_days, status
     FROM companies
     WHERE id = $1`,
    [companyId]
  );

  if (result.rows.length === 0) {
    throw new AppError('Empresa no encontrada.', 404, 'NOT_FOUND');
  }

  const row = result.rows[0];
  return {
    ...row,
    igv_rate: parseFloat(row.igv_rate),
    approval_threshold: parseFloat(row.approval_threshold),
    not_picked_up_days: parseInt(row.not_picked_up_days, 10),
  };
}

/**
 * Actualiza los datos de configuración de una empresa.
 * @param {number} companyId
 * @param {object} data
 * @param {number|null} [userId]
 */
export async function update(companyId, data, userId = null) {
  const {
    ruc,
    razon_social,
    nombre_comercial,
    direccion,
    telefono,
    email,
    logo_data,
    igv_rate,
    approval_threshold,
    not_picked_up_days,
  } = data;

  // 1. Validar razon_social
  if (razon_social !== undefined) {
    if (typeof razon_social !== 'string' || razon_social.trim() === '') {
      throw new AppError('La razón social es obligatoria.', 422, 'INVALID_FIELD');
    }
    if (razon_social.trim().length > 200) {
      throw new AppError('La razón social no puede exceder 200 caracteres.', 422, 'INVALID_FIELD');
    }
  }

  // 2. Validar RUC
  let sanitizedRuc = undefined;
  if (ruc !== undefined) {
    if (ruc === null || ruc === '') {
      sanitizedRuc = null;
    } else {
      const trimmedRuc = String(ruc).trim();
      if (!validateSunatRuc(trimmedRuc)) {
        throw new AppError(
          'El RUC no es válido. Debe tener 11 dígitos, prefijo válido (10, 15, 16, 17 o 20) y dígito verificador SUNAT correcto.',
          422,
          'INVALID_RUC'
        );
      }
      sanitizedRuc = trimmedRuc;
    }
  }

  // 3. Validar email
  let sanitizedEmail = undefined;
  if (email !== undefined) {
    if (email === null || email === '') {
      sanitizedEmail = null;
    } else {
      const trimmedEmail = String(email).trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(trimmedEmail)) {
        throw new AppError('El correo electrónico no tiene un formato válido.', 422, 'INVALID_FIELD');
      }
      if (trimmedEmail.length > 150) {
        throw new AppError('El email no puede superar 150 caracteres.', 422, 'INVALID_FIELD');
      }
      sanitizedEmail = trimmedEmail;
    }
  }

  // 4. Validar logo_data
  let sanitizedLogo = undefined;
  if (logo_data !== undefined) {
    if (logo_data === null || logo_data === '') {
      sanitizedLogo = null;
    } else {
      if (typeof logo_data !== 'string' || !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(logo_data)) {
        throw new AppError('El logo debe ser una imagen válida en formato PNG, JPEG o WebP.', 422, 'INVALID_FIELD');
      }
      const base64Data = logo_data.split(',')[1] || '';
      const sizeInBytes = (base64Data.length * 3) / 4;
      if (sizeInBytes > 300 * 1024) {
        throw new AppError('El logo no debe superar los 300 KB.', 422, 'FILE_TOO_LARGE');
      }
      sanitizedLogo = logo_data;
    }
  }

  // 5. Validar igv_rate
  let sanitizedIgvRate = undefined;
  if (igv_rate !== undefined) {
    const num = Number(igv_rate);
    if (isNaN(num) || num < 0 || num > 0.30) {
      throw new AppError('El IGV debe ser un valor numérico entre 0 y 0.30 (0% y 30%).', 422, 'INVALID_FIELD');
    }
    sanitizedIgvRate = num;
  }

  // 6. Validar approval_threshold
  let sanitizedApprovalThreshold = undefined;
  if (approval_threshold !== undefined) {
    const num = Number(approval_threshold);
    if (isNaN(num) || num < 0) {
      throw new AppError('El umbral de aprobación debe ser mayor o igual a 0.', 422, 'INVALID_FIELD');
    }
    sanitizedApprovalThreshold = num;
  }

  // 7. Validar not_picked_up_days
  let sanitizedNotPickedUpDays = undefined;
  if (not_picked_up_days !== undefined) {
    const num = Number(not_picked_up_days);
    if (!Number.isInteger(num) || num < 1 || num > 365) {
      throw new AppError('Los días para moto no recogida deben ser un número entero entre 1 y 365.', 422, 'INVALID_FIELD');
    }
    sanitizedNotPickedUpDays = num;
  }

  // Sanitizar otros campos de texto
  const sanitizedRazonSocial = razon_social !== undefined ? razon_social.trim() : undefined;
  const sanitizedNombreComercial = nombre_comercial !== undefined ? (nombre_comercial ? String(nombre_comercial).trim().slice(0, 150) : null) : undefined;
  const sanitizedDireccion = direccion !== undefined ? (direccion ? String(direccion).trim() : null) : undefined;
  const sanitizedTelefono = telefono !== undefined ? (telefono ? String(telefono).trim().slice(0, 20) : null) : undefined;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Bloquear y obtener datos previos
    const { rows: existingRows } = await client.query(
      `SELECT * FROM companies WHERE id = $1 FOR UPDATE`,
      [companyId]
    );
    if (existingRows.length === 0) {
      throw new AppError('Empresa no encontrada.', 404, 'NOT_FOUND');
    }
    const existing = existingRows[0];

    // Verificar unicidad de RUC si cambió
    if (sanitizedRuc) {
      const { rows: existingRuc } = await client.query(
        'SELECT id FROM companies WHERE ruc = $1 AND id <> $2',
        [sanitizedRuc, companyId]
      );
      if (existingRuc.length > 0) {
        throw new AppError('El RUC ingresado ya pertenece a otra empresa.', 409, 'RUC_ALREADY_EXISTS');
      }
    }

    // Construir consulta dinámica
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (sanitizedRuc !== undefined) {
      fields.push(`ruc = $${paramIndex++}`);
      values.push(sanitizedRuc);
    }
    if (sanitizedRazonSocial !== undefined) {
      fields.push(`razon_social = $${paramIndex++}`);
      values.push(sanitizedRazonSocial);
    }
    if (sanitizedNombreComercial !== undefined) {
      fields.push(`nombre_comercial = $${paramIndex++}`);
      values.push(sanitizedNombreComercial);
    }
    if (sanitizedDireccion !== undefined) {
      fields.push(`direccion = $${paramIndex++}`);
      values.push(sanitizedDireccion);
    }
    if (sanitizedTelefono !== undefined) {
      fields.push(`telefono = $${paramIndex++}`);
      values.push(sanitizedTelefono);
    }
    if (sanitizedEmail !== undefined) {
      fields.push(`email = $${paramIndex++}`);
      values.push(sanitizedEmail);
    }
    if (sanitizedLogo !== undefined) {
      fields.push(`logo_data = $${paramIndex++}`);
      values.push(sanitizedLogo);
    }
    if (sanitizedIgvRate !== undefined) {
      fields.push(`igv_rate = $${paramIndex++}`);
      values.push(sanitizedIgvRate);
    }
    if (sanitizedApprovalThreshold !== undefined) {
      fields.push(`approval_threshold = $${paramIndex++}`);
      values.push(sanitizedApprovalThreshold);
    }
    if (sanitizedNotPickedUpDays !== undefined) {
      fields.push(`not_picked_up_days = $${paramIndex++}`);
      values.push(sanitizedNotPickedUpDays);
    }

    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(companyId);

      await client.query(
        `UPDATE companies SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
    }

    // Obtener empresa actualizada
    const { rows: updatedRows } = await client.query(
      `SELECT id, ruc, razon_social, nombre_comercial, direccion, telefono, email,
              logo_data, igv_rate, approval_threshold, not_picked_up_days, status
       FROM companies WHERE id = $1`,
      [companyId]
    );
    const updatedCompany = updatedRows[0];

    // Calcular diferencias (diff)
    const tracked = [
      'ruc',
      'razon_social',
      'nombre_comercial',
      'direccion',
      'telefono',
      'email',
      'igv_rate',
      'approval_threshold',
      'not_picked_up_days',
    ];
    const diff = diffObjects(existing, updatedCompany, tracked) || {};

    // Manejo de logo_data para auditoría: NUNCA guardar la cadena base64 completa
    if (sanitizedLogo !== undefined) {
      const oldLogo = existing.logo_data;
      const newLogo = updatedCompany.logo_data;
      if (oldLogo !== newLogo) {
        diff.logo_data = {
          old: oldLogo ? 'logo previo' : null,
          new: newLogo ? 'logo cambiado' : null,
        };
      }
    }

    if (Object.keys(diff).length > 0) {
      await logAudit(client, {
        companyId,
        userId,
        entity: 'company',
        entityId: companyId,
        action: 'update',
        changes: diff,
      });
    }

    await client.query('COMMIT');

    return {
      ...updatedCompany,
      igv_rate: parseFloat(updatedCompany.igv_rate),
      approval_threshold: parseFloat(updatedCompany.approval_threshold),
      not_picked_up_days: parseInt(updatedCompany.not_picked_up_days, 10),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
