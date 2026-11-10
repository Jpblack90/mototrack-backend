import pool from '../../config/database.js';
import { AppError } from '../../shared/errors/AppError.js';
import { logAudit, diffObjects } from '../../shared/audit.js';
import { encrypt, decrypt } from '../../shared/utils/crypto.js';
import { testHooksEnabled } from '../../shared/utils/testHooks.js';
import { nubefactProvider } from '../invoicing/pse/nubefact.js';

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
 * Genera un RUC válido según el algoritmo oficial de SUNAT (Módulo 11)
 * a partir de los primeros 10 dígitos (prefijo 10, 15, 16, 17 o 20 + 8 dígitos).
 * @param {string} base10
 * @returns {string} RUC completo de 11 dígitos
 */
export function generateSunatRuc(base10 = '2099999991') {
  const base = String(base10).slice(0, 10);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(base[i], 10) * weights[i];
  }
  const residue = sum % 11;
  const diff = 11 - residue;
  const checkDigit = diff === 10 ? 0 : (diff === 11 ? 1 : diff);
  return base + checkDigit;
}

/**
 * Valida si una URL pertenece a la API de Nubefact (HTTPS y dominio nubefact.com).
 * En entorno de desarrollo o pruebas con testHooksEnabled(), permite localhost / HTTP.
 *
 * @param {string} urlStr
 * @returns {boolean}
 */
export function isValidPseUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) return false;
  try {
    const parsed = new URL(urlStr.trim());
    if (testHooksEnabled()) {
      if (['localhost', '127.0.0.1', 'host.docker.internal'].includes(parsed.hostname)) {
        return true;
      }
    }
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'nubefact.com' || parsed.hostname.endsWith('.nubefact.com');
  } catch {
    return false;
  }
}

/**
 * Valida el formato de serie de comprobante electrónico (4 caracteres alfanuméricos).
 * @param {string} serie
 * @param {'B'|'F'} prefix
 * @returns {boolean}
 */
export function isValidSerie(serie, prefix) {
  if (typeof serie !== 'string') return false;
  const regex = prefix === 'B' ? /^[B][A-Za-z0-9]{3}$/ : /^[F][A-Za-z0-9]{3}$/;
  return regex.test(serie.trim());
}

/**
 * Obtiene los datos de configuración de una empresa por ID.
 * Nunca expone el token de PSE completo ni el texto cifrado.
 * @param {number} companyId
 */
export async function getById(companyId) {
  const result = await pool.query(
    `SELECT id, ruc, razon_social, nombre_comercial, direccion, telefono, email,
            logo_data, igv_rate, approval_threshold, not_picked_up_days, status,
            trial_ends_at, terms_accepted_at,
            pse_provider, pse_url, pse_token_enc,
            series_boleta, series_factura, series_nc_boleta, series_nc_factura
     FROM companies
     WHERE id = $1`,
    [companyId]
  );

  if (result.rows.length === 0) {
    throw new AppError('Empresa no encontrada.', 404, 'NOT_FOUND');
  }

  const row = result.rows[0];
  let days_left = null;
  if (row.status === 'trial' && row.trial_ends_at) {
    const diffMs = new Date(row.trial_ends_at).getTime() - Date.now();
    days_left = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  }

  let pse_token_last4 = null;
  if (row.pse_token_enc) {
    try {
      const dec = decrypt(row.pse_token_enc);
      pse_token_last4 = dec && dec.length >= 4 ? dec.slice(-4) : (dec || null);
    } catch {
      pse_token_last4 = null;
    }
  }

  const { pse_token_enc, ...safeRow } = row;

  return {
    ...safeRow,
    pse_provider: row.pse_provider || 'simulado',
    pse_url: row.pse_url || null,
    pse_token_set: Boolean(row.pse_token_enc),
    pse_token_last4,
    series_boleta: row.series_boleta || 'B001',
    series_factura: row.series_factura || 'F001',
    series_nc_boleta: row.series_nc_boleta || 'BC01',
    series_nc_factura: row.series_nc_factura || 'FC01',
    igv_rate: parseFloat(row.igv_rate),
    approval_threshold: parseFloat(row.approval_threshold),
    not_picked_up_days: parseInt(row.not_picked_up_days, 10),
    days_left,
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
    pse_provider,
    pse_url,
    pse_token,
    series_boleta,
    series_factura,
    series_nc_boleta,
    series_nc_factura,
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
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        throw new AppError('El correo electrónico no tiene un formato válido.', 422, 'INVALID_FIELD');
      }
      sanitizedEmail = trimmedEmail;
    }
  }

  // 4. Validar igv_rate
  let sanitizedIgvRate = undefined;
  if (igv_rate !== undefined) {
    const numIgv = parseFloat(igv_rate);
    if (isNaN(numIgv) || numIgv < 0 || numIgv > 1) {
      throw new AppError('La tasa de IGV debe ser un número decimal entre 0 y 1 (ej: 0.18).', 422, 'INVALID_FIELD');
    }
    sanitizedIgvRate = numIgv;
  }

  // 5. Validar approval_threshold
  let sanitizedApprovalThreshold = undefined;
  if (approval_threshold !== undefined) {
    const numThreshold = parseFloat(approval_threshold);
    if (isNaN(numThreshold) || numThreshold < 0) {
      throw new AppError('El umbral de aprobación debe ser un número mayor o igual a 0.', 422, 'INVALID_FIELD');
    }
    sanitizedApprovalThreshold = numThreshold;
  }

  // 6. Validar not_picked_up_days
  let sanitizedNotPickedUpDays = undefined;
  if (not_picked_up_days !== undefined) {
    const numDays = parseInt(not_picked_up_days, 10);
    if (isNaN(numDays) || numDays < 1 || numDays > 365) {
      throw new AppError('Los días para marcar moto no recogida deben estar entre 1 y 365.', 422, 'INVALID_FIELD');
    }
    sanitizedNotPickedUpDays = numDays;
  }

  // 7. Validar logo_data (Base64)
  let sanitizedLogo = undefined;
  if (logo_data !== undefined) {
    if (logo_data === null || logo_data === '') {
      sanitizedLogo = null;
    } else {
      if (typeof logo_data !== 'string' || !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(logo_data)) {
        throw new AppError(
          'El logo debe ser una imagen válida en formato Data URL Base64 (PNG, JPEG o WEBP).',
          422,
          'INVALID_FIELD'
        );
      }
      const base64Data = logo_data.split(',')[1] || '';
      const sizeInBytes = Buffer.byteLength(base64Data, 'base64');
      if (sizeInBytes > 2 * 1024 * 1024) {
        throw new AppError('El logo no debe exceder 2 MB de tamaño.', 422, 'LOGO_TOO_LARGE');
      }
      sanitizedLogo = logo_data;
    }
  }

  // 8. Validar pse_provider
  let sanitizedPseProvider = undefined;
  if (pse_provider !== undefined) {
    if (!['simulado', 'nubefact'].includes(pse_provider)) {
      throw new AppError('El proveedor de PSE debe ser "simulado" o "nubefact".', 422, 'INVALID_FIELD');
    }
    sanitizedPseProvider = pse_provider;
  }

  // 9. Validar pse_url
  let sanitizedPseUrl = undefined;
  if (pse_url !== undefined) {
    if (pse_url === null || pse_url === '') {
      sanitizedPseUrl = null;
    } else {
      if (!isValidPseUrl(pse_url)) {
        throw new AppError(
          'La ruta de Nubefact debe ser HTTPS y pertenecer al dominio nubefact.com.',
          422,
          'INVALID_PSE_URL'
        );
      }
      sanitizedPseUrl = String(pse_url).trim();
    }
  }

  // 10. Validar pse_token
  let sanitizedPseTokenEnc = undefined;
  let tokenChanged = false;
  if (pse_token !== undefined) {
    if (pse_token === null || String(pse_token).trim() === '') {
      sanitizedPseTokenEnc = null;
      tokenChanged = true;
    } else {
      const trimmedToken = String(pse_token).trim();
      sanitizedPseTokenEnc = encrypt(trimmedToken);
      tokenChanged = true;
    }
  }

  // 11. Validar series
  let sanitizedSeriesBoleta = undefined;
  if (series_boleta !== undefined) {
    if (!isValidSerie(series_boleta, 'B')) {
      throw new AppError('La serie de boleta debe tener 4 caracteres alfanuméricos y comenzar con B (ej: B001).', 422, 'INVALID_SERIE');
    }
    sanitizedSeriesBoleta = series_boleta.trim().toUpperCase();
  }

  let sanitizedSeriesFactura = undefined;
  if (series_factura !== undefined) {
    if (!isValidSerie(series_factura, 'F')) {
      throw new AppError('La serie de factura debe tener 4 caracteres alfanuméricos y comenzar con F (ej: F001).', 422, 'INVALID_SERIE');
    }
    sanitizedSeriesFactura = series_factura.trim().toUpperCase();
  }

  let sanitizedSeriesNcBoleta = undefined;
  if (series_nc_boleta !== undefined) {
    if (!isValidSerie(series_nc_boleta, 'B')) {
      throw new AppError('La serie de nota de crédito para boleta debe comenzar con B (ej: BC01).', 422, 'INVALID_SERIE');
    }
    sanitizedSeriesNcBoleta = series_nc_boleta.trim().toUpperCase();
  }

  let sanitizedSeriesNcFactura = undefined;
  if (series_nc_factura !== undefined) {
    if (!isValidSerie(series_nc_factura, 'F')) {
      throw new AppError('La serie de nota de crédito para factura debe comenzar con F (ej: FC01).', 422, 'INVALID_SERIE');
    }
    sanitizedSeriesNcFactura = series_nc_factura.trim().toUpperCase();
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

    // Validar completitud de configuración si se activa o mantiene nubefact
    const targetProvider = sanitizedPseProvider !== undefined ? sanitizedPseProvider : existing.pse_provider;
    const targetUrl = sanitizedPseUrl !== undefined ? sanitizedPseUrl : existing.pse_url;
    const targetTokenEnc = sanitizedPseTokenEnc !== undefined ? sanitizedPseTokenEnc : existing.pse_token_enc;

    if (targetProvider === 'nubefact') {
      if (!targetUrl || !targetTokenEnc) {
        throw new AppError(
          'Para activar Nubefact debes configurar la Ruta (URL) y el Token de autorización.',
          422,
          'PSE_CONFIG_INCOMPLETE'
        );
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
    if (sanitizedPseProvider !== undefined) {
      fields.push(`pse_provider = $${paramIndex++}`);
      values.push(sanitizedPseProvider);
    }
    if (sanitizedPseUrl !== undefined) {
      fields.push(`pse_url = $${paramIndex++}`);
      values.push(sanitizedPseUrl);
    }
    if (sanitizedPseTokenEnc !== undefined) {
      fields.push(`pse_token_enc = $${paramIndex++}`);
      values.push(sanitizedPseTokenEnc);
    }
    if (sanitizedSeriesBoleta !== undefined) {
      fields.push(`series_boleta = $${paramIndex++}`);
      values.push(sanitizedSeriesBoleta);
    }
    if (sanitizedSeriesFactura !== undefined) {
      fields.push(`series_factura = $${paramIndex++}`);
      values.push(sanitizedSeriesFactura);
    }
    if (sanitizedSeriesNcBoleta !== undefined) {
      fields.push(`series_nc_boleta = $${paramIndex++}`);
      values.push(sanitizedSeriesNcBoleta);
    }
    if (sanitizedSeriesNcFactura !== undefined) {
      fields.push(`series_nc_factura = $${paramIndex++}`);
      values.push(sanitizedSeriesNcFactura);
    }

    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(companyId);

      await client.query(
        `UPDATE companies SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
    }

    // Obtener empresa actualizada (sin devolver pse_token_enc)
    const { rows: updatedRows } = await client.query(
      `SELECT id, ruc, razon_social, nombre_comercial, direccion, telefono, email,
              logo_data, igv_rate, approval_threshold, not_picked_up_days, status,
              pse_provider, pse_url, pse_token_enc,
              series_boleta, series_factura, series_nc_boleta, series_nc_factura
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
      'pse_provider',
      'pse_url',
      'series_boleta',
      'series_factura',
      'series_nc_boleta',
      'series_nc_factura',
    ];
    const diff = diffObjects(existing, updatedCompany, tracked) || {};

    // Auditoría de token de PSE: NUNCA volcar el token plano ni el ciphertext
    if (tokenChanged) {
      diff.pse_token = {
        old: existing.pse_token_enc ? 'token previo' : null,
        new: sanitizedPseTokenEnc ? 'token PSE actualizado' : 'token eliminado',
      };
    }

    // Manejo de logo_data para auditoría
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

    let pse_token_last4 = null;
    if (updatedCompany.pse_token_enc) {
      try {
        const dec = decrypt(updatedCompany.pse_token_enc);
        pse_token_last4 = dec && dec.length >= 4 ? dec.slice(-4) : (dec || null);
      } catch {
        pse_token_last4 = null;
      }
    }

    const { pse_token_enc: _enc, ...safeUpdated } = updatedCompany;

    return {
      ...safeUpdated,
      pse_provider: updatedCompany.pse_provider || 'simulado',
      pse_url: updatedCompany.pse_url || null,
      pse_token_set: Boolean(updatedCompany.pse_token_enc),
      pse_token_last4,
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

/**
 * Prueba la conectividad con Nubefact usando consultar_comprobante (operación inofensiva).
 *
 * @param {number} companyId
 * @param {{ pse_url?: string, pse_token?: string }} [params]
 */
export async function testPseConnection(companyId, params = {}) {
  let url = params.pse_url;
  let token = params.pse_token;

  if (!url || !token) {
    const { rows } = await pool.query(
      `SELECT pse_url, pse_token_enc FROM companies WHERE id = $1`,
      [companyId]
    );
    if (rows.length === 0) {
      throw new AppError('Empresa no encontrada.', 404, 'NOT_FOUND');
    }
    url = url || rows[0].pse_url;
    if (!token && rows[0].pse_token_enc) {
      token = decrypt(rows[0].pse_token_enc);
    }
  }

  if (!url || !token) {
    throw new AppError('Debes ingresar la Ruta y el Token para probar la conexión.', 422, 'PSE_CONFIG_INCOMPLETE');
  }

  if (!isValidPseUrl(url)) {
    throw new AppError('La ruta de Nubefact debe ser HTTPS y pertenecer al dominio nubefact.com.', 422, 'INVALID_PSE_URL');
  }

  const dummyCompany = {
    pse_url: url,
    pse_token_enc: encrypt(token),
  };

  try {
    const result = await nubefactProvider.query({
      company: dummyCompany,
      document: { tipo_de_comprobante: 1, serie: 'F001', numero: 1 },
    });

    if (result.raw?.errors && /no autorizado|token inv[aá]lido|unauthorized/i.test(String(result.raw.errors))) {
      throw new AppError(`Error de autenticación con Nubefact: ${result.raw.errors}`, 422, 'PSE_AUTH_FAILED');
    }

    return {
      connected: true,
      message: 'Conexión con Nubefact establecida correctamente.',
      provider: 'nubefact',
      details: result.sunat_description || 'Servicio de Nubefact respondiendo correctamente.',
    };
  } catch (err) {
    if (err.code === 'PSE_UNAVAILABLE') {
      throw new AppError('No se pudo conectar con la URL de Nubefact. Verifica la ruta o tu conexión a internet.', 504, 'PSE_UNAVAILABLE');
    }
    throw err;
  }
}

/**
 * Obtiene las series configuradas de la empresa con su correlativo numérico actual.
 *
 * @param {number} companyId
 */
export async function getSeries(companyId) {
  const { rows: companyRows } = await pool.query(
    `SELECT series_boleta, series_factura, series_nc_boleta, series_nc_factura
     FROM companies WHERE id = $1`,
    [companyId]
  );
  if (companyRows.length === 0) {
    throw new AppError('Empresa no encontrada.', 404, 'NOT_FOUND');
  }
  const co = companyRows[0];

  const seriesDef = [
    { tipo: 'boleta', label: 'Boleta de Venta', serie: co.series_boleta || 'B001' },
    { tipo: 'factura', label: 'Factura Electrónica', serie: co.series_factura || 'F001' },
    { tipo: 'nc_boleta', label: 'Nota de Crédito (Boleta)', serie: co.series_nc_boleta || 'BC01' },
    { tipo: 'nc_factura', label: 'Nota de Crédito (Factura)', serie: co.series_nc_factura || 'FC01' },
  ];

  const { rows: correlatives } = await pool.query(
    `SELECT serie, last_number FROM invoice_series WHERE company_id = $1`,
    [companyId]
  );
  const corrMap = new Map(correlatives.map((c) => [c.serie, c.last_number]));

  return seriesDef.map((s) => ({
    ...s,
    last_number: corrMap.get(s.serie) ?? 0,
  }));
}

/**
 * Actualiza el último número correlativo usado para una serie.
 * Solo permite fijar valores mayores o iguales al actual.
 *
 * @param {number} companyId
 * @param {string} serie
 * @param {number} lastNumber
 * @param {number|null} [userId]
 */
export async function updateSerieCorrelative(companyId, serie, lastNumber, userId = null) {
  const num = parseInt(lastNumber, 10);
  if (isNaN(num) || num < 0) {
    throw new AppError('El correlativo debe ser un número entero mayor o igual a 0.', 422, 'INVALID_CORRELATIVE');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: currentRows } = await client.query(
      `SELECT last_number FROM invoice_series WHERE company_id = $1 AND serie = $2 FOR UPDATE`,
      [companyId, serie]
    );

    const currentNumber = currentRows.length > 0 ? currentRows[0].last_number : 0;
    if (num < currentNumber) {
      throw new AppError(
        `El último número no puede ser menor al actual (${currentNumber}).`,
        422,
        'INVALID_CORRELATIVE'
      );
    }

    const { rows: updatedRows } = await client.query(
      `INSERT INTO invoice_series (company_id, serie, last_number)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, serie)
       DO UPDATE SET last_number = $3
       RETURNING last_number`,
      [companyId, serie, num]
    );

    await logAudit(client, {
      companyId,
      userId,
      entity: 'series',
      entityId: companyId,
      action: 'update_correlative',
      changes: {
        serie,
        last_number: { old: currentNumber, new: num },
      },
    });

    await client.query('COMMIT');
    return {
      serie,
      last_number: updatedRows[0].last_number,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
