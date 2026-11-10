import 'dotenv/config';
import http from 'http';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';
import { generateSunatRuc } from '../../src/modules/company/company.service.js';

const API_URL = `http://localhost:${process.env.PORT ?? 4000}/api`;
const JWT_SECRET = process.env.JWT_SECRET || 'MySecretK3yForJWTs1234567890!@#%^&*()_+|';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASA] ${message}`);
  } else {
    failedTests++;
    console.error(`  [FALLA] ${message}`);
  }
}

function makeToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
}

async function request(path, options = {}) {
  const url = `${API_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const config = {
    method: options.method || 'GET',
    headers,
  };
  if (options.body) {
    config.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, config);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // respuesta no JSON
  }
  return { status: res.status, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🧪  INICIANDO SUITE VERIFY-13-1: PSE NUBEFACT (RF-28, RF-29)');
  console.log('===============================================================\n');

  let mockBehavior = 'normal';
  let receivedRequests = [];
  const testTokenVal = 'super-secret-nubefact-token-123456';
  const expectedAuthHeader = `Token token="${testTokenVal}"`;

  // 1. Levantar servidor mock HTTP para simular la API REST de Nubefact
  const mockServer = http.createServer((req, res) => {
    let bodyStr = '';
    req.on('data', (chunk) => {
      bodyStr += chunk;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(bodyStr);
      } catch {}

      const authHeader = req.headers['authorization'] || '';
      receivedRequests.push({
        method: req.method,
        url: req.url,
        authHeader,
        body,
      });

      // Validar auth header exacto (NubeFact-json.php línea 158: Authorization: Token token="...")
      if (mockBehavior === 'auth_fail' || authHeader !== expectedAuthHeader) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          errors: 'No se pudo autenticar, token incorrecto o eliminado',
          codigo: 10,
        }));
        return;
      }

      if (mockBehavior === 'server_error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          errors: 'Error interno desconocido',
          codigo: 40,
        }));
        return;
      }

      if (mockBehavior === 'timeout') {
        // Destruir socket sin responder para simular fallo de red inmediato
        req.destroy();
        return;
      }

      if (mockBehavior === 'duplicate') {
        if (body.operacion === 'generar_comprobante') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // Respuesta exacta según Manual pág. 15 ("MANEJO DE ERRORES", Código 23)
          res.end(JSON.stringify({
            errors: 'Este documento ya existe en NubeFacT',
            codigo: 23,
          }));
          return;
        }
        // En consultar_comprobante responde éxito (Estructura exacta Manual pág. 13)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          tipo_de_comprobante: body.tipo_de_comprobante || 2,
          serie: body.serie || 'B001',
          numero: Number(body.numero) || 51,
          enlace: 'https://nubefact.test/cpe/dup-recup',
          enlace_del_pdf: 'https://nubefact.test/pdf/dup-recup.pdf',
          enlace_del_xml: 'https://nubefact.test/xml/dup-recup.xml',
          enlace_del_cdr: 'https://nubefact.test/xml/dup-recup.cdr',
          aceptada_por_sunat: true,
          sunat_description: 'La Boleta numero B001-51, ha sido aceptada',
          sunat_note: null,
          sunat_responsecode: '0',
          sunat_soap_error: '',
          cadena_para_codigo_qr: 'QR_DUP_RECUPERADO_123456',
          codigo_hash: 'HASH_DUP_123456',
        }));
        return;
      }

      if (mockBehavior === 'error_serie_no_registrada') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Error con palabra "registrada" pero NO duplicado (Manual pág. 15, Código 21)
        res.end(JSON.stringify({
          errors: 'La serie no está registrada',
          codigo: 21,
        }));
        return;
      }

      if (mockBehavior === 'duplicate_but_not_found') {
        if (body.operacion === 'generar_comprobante') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            errors: 'Este documento ya existe en NubeFacT',
            codigo: 23,
          }));
          return;
        }
        // En consultar_comprobante responde que NO existe (Manual pág. 15, Código 24)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          errors: 'El documento indicado no existe o no fue enviado a NubeFacT',
          codigo: 24,
        }));
        return;
      }

      if (mockBehavior === 'reject_sunat') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          tipo_de_comprobante: body.tipo_de_comprobante,
          serie: body.serie,
          numero: Number(body.numero),
          enlace: null,
          enlace_del_pdf: null,
          enlace_del_xml: null,
          enlace_del_cdr: null,
          aceptada_por_sunat: false,
          sunat_description: 'El RUC no se encuentra activo y habido en el padrón de SUNAT',
          sunat_note: null,
          sunat_responsecode: '2017',
          sunat_soap_error: '',
          codigo_hash: null,
          cadena_para_codigo_qr: null,
        }));
        return;
      }

      // Normal accept (Estructura oficial Manual pág. 13)
      const docType = body.tipo_de_comprobante === 1 ? 'Factura' : (body.tipo_de_comprobante === 3 ? 'Nota de Crédito' : 'Boleta');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tipo_de_comprobante: body.tipo_de_comprobante,
        serie: body.serie,
        numero: Number(body.numero),
        enlace: `https://nubefact.test/cpe/${body.serie}-${body.numero}`,
        enlace_del_pdf: `https://nubefact.test/pdf/${body.serie}-${body.numero}.pdf`,
        enlace_del_xml: `https://nubefact.test/xml/${body.serie}-${body.numero}.xml`,
        enlace_del_cdr: `https://nubefact.test/xml/${body.serie}-${body.numero}.cdr`,
        aceptada_por_sunat: true,
        sunat_description: `La ${docType} numero ${body.serie}-${body.numero}, ha sido aceptada`,
        sunat_note: null,
        sunat_responsecode: '0',
        sunat_soap_error: '',
        codigo_hash: `HASH_${body.serie}_${body.numero}`,
        cadena_para_codigo_qr: `QR_${body.serie}_${body.numero}|${body.total}|${body.cliente_numero_de_documento}`,
      }));
    });
  });

  await new Promise((resolve) => {
    mockServer.listen(0, '0.0.0.0', resolve);
  });
  const mockPort = mockServer.address().port;
  const mockNubefactUrl = `http://host.docker.internal:${mockPort}/api/v1/nubefact`;

  let companyA = null;
  let companyB = null;

  try {
    // 2. Sembrar empresas de prueba
    const seeded = await seedTestCompany();
    companyA = seeded.companyA;
    companyB = seeded.companyB;

    // Limpiar comprobantes y correlativos previos para pruebas limpias
    await pool.query(`DELETE FROM credit_notes WHERE company_id IN ($1, $2)`, [companyA.companyId, companyB.companyId]);
    await pool.query(`DELETE FROM invoices WHERE company_id IN ($1, $2)`, [companyA.companyId, companyB.companyId]);
    await pool.query(`DELETE FROM invoice_series WHERE company_id IN ($1, $2)`, [companyA.companyId, companyB.companyId]);

    // Crear o recuperar un cajero para companyA
    const hash = await bcrypt.hash('Demo1234!', 10);
    const { rows: cashierRows } = await pool.query(
      `INSERT INTO users (company_id, name, email, password_hash, role)
       VALUES ($1, 'Cajero Taller A', 'cajeroa@mototrack.local', $2, 'cajero')
       ON CONFLICT (email) DO UPDATE SET is_active = true, role = 'cajero'
       RETURNING id, email`,
      [companyA.companyId, hash]
    );
    const cashierA = cashierRows[0];

    const adminTokenA = makeToken({
      id: companyA.adminId,
      email: companyA.adminEmail,
      role: 'admin',
      company_id: companyA.companyId,
    });

    const cashierTokenA = makeToken({
      id: cashierA.id,
      email: cashierA.email,
      role: 'cajero',
      company_id: companyA.companyId,
    });

    const adminTokenB = makeToken({
      id: companyB.adminId,
      email: companyB.adminEmail,
      role: 'admin',
      company_id: companyB.companyId,
    });

    console.log('--- CASO 1: Test de Conexión PSE y Validaciones ---');
    // 1.1 Probar conexión con token y URL
    mockBehavior = 'normal';
    const testPseRes = await request('/company/pse/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        pse_url: mockNubefactUrl,
        pse_token: testTokenVal,
      },
    });
    assert(testPseRes.status === 200, `POST /api/company/pse/test retorna 200 (obtuvo ${testPseRes.status})`);
    assert(testPseRes.data?.data?.connected === true, 'Test de conexión reporta connected: true');

    // 1.2 Probar con auth fallida en mock
    mockBehavior = 'auth_fail';
    const testPseAuthFail = await request('/company/pse/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        pse_url: mockNubefactUrl,
        pse_token: 'bad-token',
      },
    });
    assert(testPseAuthFail.status === 422, `POST /api/company/pse/test con token inválido retorna 422 (obtuvo ${testPseAuthFail.status})`);
    mockBehavior = 'normal';

    // 1.3 Probar RBAC: cajero no puede hacer test de conexión
    const testPseRbac = await request('/company/pse/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cashierTokenA}` },
      body: { pse_url: mockNubefactUrl, pse_token: testTokenVal },
    });
    assert(testPseRbac.status === 403, `POST /api/company/pse/test con rol cajero retorna 403 (obtuvo ${testPseRbac.status})`);

    console.log('\n--- CASO 2: Configuración de Empresa con Proveedor Nubefact y Series ---');
    const updateCompRes = await request('/company', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        pse_provider: 'nubefact',
        pse_url: mockNubefactUrl,
        pse_token: testTokenVal,
        series_boleta: 'B001',
        series_factura: 'F001',
        series_nc_boleta: 'BC01',
        series_nc_factura: 'FC01',
      },
    });
    assert(updateCompRes.status === 200, `PUT /api/company retorna 200 (obtuvo ${updateCompRes.status})`);
    assert(updateCompRes.data?.data?.pse_provider === 'nubefact', 'pse_provider configurado como "nubefact"');
    assert(updateCompRes.data?.data?.pse_token_set === true, 'pse_token_set es true');
    assert(updateCompRes.data?.data?.pse_token_last4 === '3456', 'pse_token_last4 muestra los últimos 4 caracteres ("3456")');
    assert(updateCompRes.data?.data?.pse_token === undefined, 'Zero-Leak: pse_token en texto plano NO viaja en la respuesta');
    assert(updateCompRes.data?.data?.pse_token_enc === undefined, 'Zero-Leak: pse_token_enc NO viaja en la respuesta');

    console.log('\n--- CASO 3: Correlativos Iniciales y Gestión de Series ---');
    // 3.1 Consultar series
    const getSeriesRes = await request('/company/series', {
      headers: { Authorization: `Bearer ${adminTokenA}` },
    });
    assert(getSeriesRes.status === 200, `GET /api/company/series retorna 200 (obtuvo ${getSeriesRes.status})`);
    assert(Array.isArray(getSeriesRes.data?.data) && getSeriesRes.data?.data?.length === 4, 'Retorna las 4 series activas');

    // 3.2 Actualizar correlativo inicial a 50 (ej: migración)
    const updateSerieRes = await request('/company/series/B001', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: { last_number: 50 },
    });
    assert(updateSerieRes.status === 200, `PUT /api/company/series/B001 a 50 retorna 200 (obtuvo ${updateSerieRes.status})`);
    assert(updateSerieRes.data?.data?.last_number === 50, 'last_number actualizado a 50');

    // 3.3 Intentar reducir correlativo debe fallar con 422
    const reduceSerieRes = await request('/company/series/B001', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: { last_number: 20 },
    });
    assert(reduceSerieRes.status === 422, `Intentar reducir correlativo retorna 422 (obtuvo ${reduceSerieRes.status})`);

    // 3.4 RBAC: cajero no puede modificar correlativo
    const rbacSerieRes = await request('/company/series/B001', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cashierTokenA}` },
      body: { last_number: 60 },
    });
    assert(rbacSerieRes.status === 403, `Cajero modificando correlativo retorna 403 (obtuvo ${rbacSerieRes.status})`);

    console.log('\n--- CASO 4: Auditoría Segura del Token (Zero-Leak en BD) ---');
    const { rows: auditRows } = await pool.query(
      `SELECT changes FROM audit_logs
       WHERE company_id = $1 AND entity = 'company' AND action = 'update'
       ORDER BY id DESC LIMIT 1`,
      [companyA.companyId]
    );
    assert(auditRows.length > 0, 'Existe registro de auditoría para la actualización de company');
    const auditChanges = auditRows[0]?.changes;
    assert(auditChanges?.pse_token?.new === 'token PSE actualizado', 'Auditoría registra pse_token como "token PSE actualizado"');
    assert(!JSON.stringify(auditChanges).includes(testTokenVal), 'Zero-Leak: Token en claro NO existe en audit_logs');

    console.log('\n--- CASO 5: Emisión de Boleta Aceptada con Nubefact ---');
    // Crear producto y venta en companyA
    const { rows: prodRows } = await pool.query(
      `INSERT INTO products (company_id, name, sku, sale_price, cost_price, stock, min_stock)
       VALUES ($1, 'Casco Integral AGV', 'CAS-001', 200.00, 120.00, 10, 2)
       ON CONFLICT (company_id, sku) DO UPDATE SET stock = 10, is_active = true
       RETURNING id`,
      [companyA.companyId]
    );
    const prodId = prodRows[0].id;

    const saleRes = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        customer_name: 'Juan Perez',
        payment_method: 'efectivo',
        items: [{ product_id: prodId, quantity: 1 }],
      },
    });
    assert(saleRes.status === 201, `Venta creada con éxito (status ${saleRes.status})`);
    const saleId = saleRes.data?.data?.id;

    mockBehavior = 'normal';
    receivedRequests = [];

    const invoiceRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        sale_id: saleId,
        comprobante_type: 'boleta',
        customer_document_type: 'DNI',
        customer_document_number: '71234567',
      },
    });
    assert(invoiceRes.status === 201, `Boleta emitida con éxito (status ${invoiceRes.status})`);
    const invData = invoiceRes.data?.data;
    assert(invData?.estado === 'accepted', 'Boleta en estado "accepted"');
    assert(invData?.numero === 51, `Correlativo asignado correctamente (51 tras configurar base 50, obtuvo ${invData?.numero})`);
    assert(invData?.pdf_url?.startsWith('https://nubefact.test/pdf/B001-51'), 'pdf_url guardado correctamente');
    assert(invData?.hash?.includes('HASH_B001_51'), 'hash del comprobante guardado');
    assert(invData?.qr_string?.includes('QR_B001_51'), 'cadena para código QR guardada');

    // Verificar que mock recibió request con Authorization token
    const lastReq = receivedRequests[receivedRequests.length - 1];
    assert(lastReq?.authHeader === `Token token="${testTokenVal}"`, 'Mock de Nubefact recibió header Authorization con el token descifrado');
    assert(lastReq?.body?.tipo_de_comprobante === 2, 'Payload tipo_de_comprobante: 2 (Boleta)');

    console.log('\n--- CASO 6: Factura Rechazada por SUNAT ---');
    mockBehavior = 'reject_sunat';

    const saleFactura = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        customer_name: 'Empresa Inactiva SAC',
        payment_method: 'efectivo',
        items: [{ product_id: prodId, quantity: 1 }],
      },
    });
    const saleFacturaId = saleFactura.data?.data?.id;

    const invoiceFacturaRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        sale_id: saleFacturaId,
        comprobante_type: 'factura',
        customer_document_type: 'RUC',
        customer_document_number: '20100000001',
      },
    });
    assert(invoiceFacturaRes.status === 201, `Factura procesada (status ${invoiceFacturaRes.status})`);
    const invFacturaData = invoiceFacturaRes.data?.data;
    assert(invFacturaData?.estado === 'rejected', 'Factura rechazada queda con estado "rejected"');
    assert(invFacturaData?.is_contingency === false, 'Factura rechazada no es contingencia');
    const cdrDesc = invFacturaData?.cdr_response?.sunat_description || invFacturaData?.cdr_response?.description;
    assert(cdrDesc?.includes('no se encuentra activo'), 'cdr_response contiene el motivo de rechazo de SUNAT');

    console.log('\n--- CASO 7: Fallo de Red -> Modo Contingencia y Reintento Exitoso ---');
    mockBehavior = 'timeout';

    const saleContingencia = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        customer_name: 'Cliente Contingencia',
        payment_method: 'efectivo',
        items: [{ product_id: prodId, quantity: 1 }],
      },
    });
    const saleContId = saleContingencia.data?.data?.id;

    const invContRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        sale_id: saleContId,
        comprobante_type: 'boleta',
      },
    });
    assert(invContRes.status === 201, `Comprobante con timeout retorna 201 (RF-28)`);
    assert(invContRes.data?.data?.estado === 'contingency', 'Comprobante queda en estado "contingency"');
    assert(invContRes.data?.data?.is_contingency === true, 'is_contingency es true');
    const contInvoiceId = invContRes.data?.data?.id;

    // Restaurar mock a normal y reintentar
    mockBehavior = 'normal';
    const retryRes = await request(`/invoicing/${contInvoiceId}/retry`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminTokenA}` },
    });
    assert(retryRes.status === 200, `Reintento de contingencia retorna 200 (obtuvo ${retryRes.status})`);
    assert(retryRes.data?.data?.estado === 'accepted', 'Tras reintento, comprobante pasa a "accepted"');
    assert(retryRes.data?.data?.is_contingency === false, 'is_contingency pasa a false');
    assert(Boolean(retryRes.data?.data?.pdf_url), 'Reintento almacena pdf_url');

    console.log('\n--- CASO 8: Idempotencia ante Respuesta "Ya Existe" (Duplicidad en Nubefact) ---');
    mockBehavior = 'duplicate';

    const saleDup = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        customer_name: 'Cliente Duplicado',
        payment_method: 'efectivo',
        items: [{ product_id: prodId, quantity: 1 }],
      },
    });
    const saleDupId = saleDup.data?.data?.id;

    const invDupRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        sale_id: saleDupId,
        comprobante_type: 'boleta',
      },
    });
    assert(invDupRes.status === 201, `Envío con duplicado en PSE retorna 201`);
    assert(invDupRes.data?.data?.estado === 'accepted', 'Recuperado por consultar_comprobante en estado "accepted"');
    assert(invDupRes.data?.data?.pdf_url?.includes('dup-recup.pdf'), 'Recuperó pdf_url de la consulta');
    assert(invDupRes.data?.data?.qr_string?.includes('QR_DUP_RECUPERADO'), 'Recuperó qr_string de la consulta');

    console.log('\n--- CASO 8b: Error no duplicado con palabra "registrada" ("La serie no está registrada") ---');
    mockBehavior = 'error_serie_no_registrada';
    receivedRequests = [];

    const saleReg = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        customer_name: 'Cliente Serie No Registrada',
        payment_method: 'efectivo',
        items: [{ product_id: prodId, quantity: 1 }],
      },
    });
    const saleRegId = saleReg.data?.data?.id;

    const invRegRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        sale_id: saleRegId,
        comprobante_type: 'boleta',
      },
    });
    assert(invRegRes.status === 201, `Comprobante con serie no registrada procesado (status ${invRegRes.status})`);
    assert(invRegRes.data?.data?.estado === 'rejected', 'Comprobante queda con estado "rejected"');
    assert(invRegRes.data?.data?.is_contingency === false, 'Comprobante rechazado no es contingencia');
    const consultCalls = receivedRequests.filter((r) => r.body?.operacion === 'consultar_comprobante');
    assert(consultCalls.length === 0, 'NO se llamó a consultar_comprobante ante error no duplicado');

    console.log('\n--- CASO 8c: Supuesto duplicado pero documento no existe en consulta -> Modo Contingencia ---');
    mockBehavior = 'duplicate_but_not_found';
    receivedRequests = [];

    const saleNotFound = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        customer_name: 'Cliente Dup No Existe',
        payment_method: 'efectivo',
        items: [{ product_id: prodId, quantity: 1 }],
      },
    });
    const saleNotFoundId = saleNotFound.data?.data?.id;

    const invNotFoundRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        sale_id: saleNotFoundId,
        comprobante_type: 'boleta',
      },
    });
    assert(invNotFoundRes.status === 201, `Comprobante dup-no-encontrado procesado (status ${invNotFoundRes.status})`);
    assert(invNotFoundRes.data?.data?.estado === 'contingency', 'Comprobante queda en estado "contingency"');
    assert(invNotFoundRes.data?.data?.is_contingency === true, 'is_contingency es true');
    const queryCalls = receivedRequests.filter((r) => r.body?.operacion === 'consultar_comprobante');
    assert(queryCalls.length === 1, 'Se intentó consultar_comprobante tras recibir duplicado (código 23)');

    console.log('\n--- CASO 9: Nota de Crédito por Anulación con Documento Modificado y Catálogo 09 ---');
    mockBehavior = 'normal';
    receivedRequests = [];

    // Crear venta y factura aceptada
    const saleParaAnular = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        customer_name: 'Taller Moto Sport SAC',
        payment_method: 'efectivo',
        items: [{ product_id: prodId, quantity: 2 }],
      },
    });
    const saleParaAnularId = saleParaAnular.data?.data?.id;

    const invParaAnular = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        sale_id: saleParaAnularId,
        comprobante_type: 'factura',
        customer_document_type: 'RUC',
        customer_document_number: generateSunatRuc('2055555555'),
      },
    });
    assert(invParaAnular.data?.data?.estado === 'accepted', 'Factura para anular emitida y aceptada');

    // Anular venta con motivo 01
    const voidRes = await request(`/sales/${saleParaAnularId}/void`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminTokenA}` },
      body: {
        void_reason: 'Error en la orden de compra del cliente',
        motivo_code: '01',
      },
    });
    assert(voidRes.status === 200, `Venta anulada con éxito (status ${voidRes.status})`);
    const createdNc = voidRes.data?.data?.credit_note;
    assert(Boolean(createdNc), 'Nota de crédito creada al anular venta con factura aceptada');
    assert(createdNc?.estado === 'accepted', 'Nota de crédito en estado "accepted"');
    assert(createdNc?.serie === 'FC01', `Serie asignada FC01 (obtuvo ${createdNc?.serie})`);
    assert(Boolean(createdNc?.pdf_url), 'Nota de crédito contiene pdf_url');
    assert(Boolean(createdNc?.hash), 'Nota de crédito contiene hash');
    assert(Boolean(createdNc?.qr_string), 'Nota de crédito contiene qr_string');

    // Verificar request recibido por el mock para la NC
    const ncReq = receivedRequests[receivedRequests.length - 1];
    assert(ncReq?.body?.tipo_de_comprobante === 3, 'NC enviada con tipo_de_comprobante: 3');
    assert(ncReq?.body?.documento_que_se_modifica_tipo === 1, 'NC modifica factura (tipo 1)');
    assert(ncReq?.body?.documento_que_se_modifica_serie === invParaAnular.data?.data?.serie, 'NC modifica la serie de factura correcta');
    assert(ncReq?.body?.documento_que_se_modifica_numero === invParaAnular.data?.data?.numero, 'NC modifica el número de factura correcto');
    assert(ncReq?.body?.tipo_de_nota_de_credito === 1, 'NC catálogo 09 SUNAT tipo 1 (Anulación de la operación)');

    console.log('\n--- CASO 10: Datos Estructurados de Tickets (Boleta y Nota de Crédito) ---');
    const ticketInvRes = await request(`/invoicing/${invData?.id}/ticket`, {
      headers: { Authorization: `Bearer ${adminTokenA}` },
    });
    assert(ticketInvRes.status === 200, `GET /api/invoicing/:id/ticket retorna 200`);
    const compTicket = ticketInvRes.data?.data?.comprobante;
    assert(compTicket?.pdf_url === invData?.pdf_url, 'Ticket contiene pdf_url');
    assert(compTicket?.hash === invData?.hash, 'Ticket contiene hash');
    assert(compTicket?.qr_string === invData?.qr_string, 'Ticket contiene qr_string');
    assert(compTicket?.pse_provider === 'nubefact', 'Ticket indica pse_provider "nubefact"');

    const ticketNcRes = await request(`/invoicing/credit-notes/${createdNc?.id}/ticket`, {
      headers: { Authorization: `Bearer ${adminTokenA}` },
    });
    assert(ticketNcRes.status === 200, `GET /api/invoicing/credit-notes/:id/ticket retorna 200`);
    const cnTicket = ticketNcRes.data?.data?.credit_note;
    assert(cnTicket?.pdf_url === createdNc?.pdf_url, 'Ticket de NC contiene pdf_url');
    assert(cnTicket?.hash === createdNc?.hash, 'Ticket de NC contiene hash');
    assert(cnTicket?.qr_string === createdNc?.qr_string, 'Ticket de NC contiene qr_string');
    assert(cnTicket?.pse_provider === 'nubefact', 'Ticket de NC indica pse_provider "nubefact"');

    console.log('\n--- CASO 11: Aislamiento Multi-Tenant y Proveedor Simulado Intacto ---');
    // 11.1 Taller B tiene pse_provider = 'simulado'
    const getCompB = await request('/company', {
      headers: { Authorization: `Bearer ${adminTokenB}` },
    });
    assert(getCompB.data?.data?.pse_provider === 'simulado', 'Taller B mantiene pse_provider "simulado"');

    // 11.2 Crear venta y boleta en Taller B -> debe emitirse aceptada sin llamar a Nubefact
    const countReqsBefore = receivedRequests.length;
    const { rows: prodBRows } = await pool.query(
      `INSERT INTO products (company_id, name, sku, sale_price, cost_price, stock, min_stock)
       VALUES ($1, 'Bujía NGK', 'BUJ-002', 25.00, 15.00, 20, 5)
       ON CONFLICT (company_id, sku) DO UPDATE SET stock = 20, is_active = true
       RETURNING id`,
      [companyB.companyId]
    );
    const prodBId = prodBRows[0].id;

    const saleB = await request('/sales', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenB}` },
      body: {
        customer_name: 'Cliente Taller B',
        payment_method: 'efectivo',
        items: [{ product_id: prodBId, quantity: 1 }],
      },
    });
    const invBRes = await request('/invoicing', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTokenB}` },
      body: {
        sale_id: saleB.data?.data?.id,
        comprobante_type: 'boleta',
      },
    });
    assert(invBRes.status === 201, `Boleta en Taller B creada con éxito`);
    assert(invBRes.data?.data?.estado === 'accepted', 'Boleta en Taller B simulado queda en estado "accepted"');
    assert(receivedRequests.length === countReqsBefore, 'Taller B con proveedor simulado NO emitió ninguna petición hacia Nubefact');

    // 11.3 Taller B no puede acceder a ticket ni correlativos de Taller A
    const tenantLeakTicket = await request(`/invoicing/${invData?.id}/ticket`, {
      headers: { Authorization: `Bearer ${adminTokenB}` },
    });
    assert(tenantLeakTicket.status === 404, `Aislamiento: Taller B intentando ver ticket de Taller A retorna 404 (obtuvo ${tenantLeakTicket.status})`);

    const tenantLeakSeries = await request('/company/series/B001', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminTokenB}` },
      body: { last_number: 999 },
    });
    // Solo actualiza su propia serie en Taller B, no la de Taller A
    const checkSeriesA = await request('/company/series', {
      headers: { Authorization: `Bearer ${adminTokenA}` },
    });
    const serieB001A = checkSeriesA.data?.data?.find((s) => s.serie === 'B001');
    assert(serieB001A?.last_number !== 999, 'Aislamiento: Serie de Taller A no fue afectada por Taller B');

  } catch (err) {
    console.error('💥 Error inesperado durante la ejecución de la suite:', err);
    failedTests++;
  } finally {
    // Apagar servidor mock
    mockServer.close();

    // Limpieza de datos de prueba (Regla 8)
    if (companyA?.companyId) {
      await pool.query(`UPDATE companies SET is_active = false WHERE id = $1`, [companyA.companyId]);
    }
    if (companyB?.companyId) {
      await pool.query(`UPDATE companies SET is_active = false WHERE id = $1`, [companyB.companyId]);
    }

    console.log('\n===============================================================');
    console.log(`🏁 RESULTADOS: ${passedTests} pasadas, ${failedTests} fallidas (Total: ${totalTests})`);
    console.log('===============================================================\n');

    process.exit(failedTests > 0 ? 1 : 0);
  }
}

run();
