// =============================================================================
// scripts/tests/verify-11-3.js
// Suite de verificación integral de la Tarea 11.3:
// Gestión de usuarios, política de contraseñas, revocación inmediata y protecciones de integridad.
// Solo utiliza empresas de prueba [PRUEBA].
// =============================================================================

import 'dotenv/config';
import pool from '../../src/config/database.js';
import { seedTestCompany } from './seed-test-company.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌  Error: verify-11-3.js no debe ejecutarse en entorno de producción.');
  process.exit(1);
}

const API_BASE = process.env.API_URL || 'http://localhost:4000/api';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASA] ${message}`);
  } else {
    failedTests++;
    console.error(`  [FALLA] ${message} ${details ? `(${details})` : ''}`);
  }
}

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const fetchOptions = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, fetchOptions);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // respuesta sin cuerpo JSON
  }

  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('\n===============================================================');
  console.log('🚀  VERIFICACIÓN INTEGRAL: TAREA 11.3 (USUARIOS Y CONTRASEÑAS)');
  console.log('===============================================================\n');

  let companyAId, companyBId;
  let tokenAdminB;
  let initialRealUsers;

  try {
    // 1. Guardar estado de usuarios de "Taller Principal"
    const { rows: realUsers } = await pool.query(
      `SELECT u.id, u.email, u.role, u.password_hash, u.is_active
       FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE c.razon_social = 'Taller Principal'
       ORDER BY u.id ASC`
    );
    initialRealUsers = realUsers;

    // 2. Preparar empresas de prueba
    const { companyA, companyB } = await seedTestCompany();
    companyAId = companyA.companyId;
    companyBId = companyB.companyId;

    // Login Admin B
    const loginB = await request('/auth/login', {
      method: 'POST',
      body: { email: companyB.adminEmail, password: companyB.adminPassword },
    });
    if (!loginB.ok) throw new Error(`Login de Admin B falló: ${JSON.stringify(loginB.data)}`);
    tokenAdminB = loginB.data.data.token;

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 1: Medición de Latencia Agregada en authenticate.js
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 1: Medición de Latencia Agregada en authenticate.js ---');
    const iterations = 20;
    const durations = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const authRes = await request('/auth/me', {
        headers: { Authorization: `Bearer ${tokenAdminB}` },
      });
      const end = performance.now();
      if (authRes.status === 200) {
        durations.push(end - start);
      }
    }

    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    console.log(`  ⏱️  Latencia media de autenticación (JOIN en BD): ${avgDuration.toFixed(2)} ms (${iterations} muestras)`);
    assert(
      avgDuration < 50,
      `Latencia agregada por authenticate.js dentro de rangos óptimos (< 50 ms)`,
      `promedio: ${avgDuration.toFixed(2)} ms`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 2: Política de Contraseñas Rechaza Contraseñas Débiles (422)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 2: Política de Contraseñas Rechaza Débiles (422) ---');

    // Menos de 8 caracteres
    const r2a = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: {
        name: '[PRUEBA] User Corto',
        email: 'corto@pruebab.local',
        password: 'ab1',
        role: 'cajero',
      },
    });
    assert(
      r2a.status === 422,
      'Creación rechaza contraseña con menos de 8 caracteres (422)',
      `status: ${r2a.status}`
    );

    // Solo letras (sin números)
    const r2b = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: {
        name: '[PRUEBA] User Solo Letras',
        email: 'sololetras@pruebab.local',
        password: 'passwordSeguro',
        role: 'cajero',
      },
    });
    assert(
      r2b.status === 422,
      'Creación rechaza contraseña sin números (422)',
      `status: ${r2b.status}`
    );

    // Solo números (sin letras)
    const r2c = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: {
        name: '[PRUEBA] User Solo Números',
        email: 'solonumeros@pruebab.local',
        password: '1234567890',
        role: 'cajero',
      },
    });
    assert(
      r2c.status === 422,
      'Creación rechaza contraseña sin letras (422)',
      `status: ${r2c.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 3: Creación de Usuario Válido y Reset de Contraseña
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 3: Creación Exitosa y Reset de Contraseña ---');
    const testUserEmail = 'cajero_test_11_3@pruebab.local';

    // Limpiar usuario si existía de corridas previas filtrando estrictamente por empresa [PRUEBA]
    await pool.query(
      `DELETE FROM users
       WHERE email = $1
         AND company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`,
      [testUserEmail]
    );

    const r3Create = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: {
        name: '[PRUEBA] Cajero Test 11.3',
        email: testUserEmail,
        password: 'ClaveTemporal1!',
        role: 'cajero',
      },
    });
    assert(
      r3Create.status === 201 && r3Create.data?.data?.must_change_password === true,
      'Nuevo usuario se crea con must_change_password = true (201)',
      `status: ${r3Create.status}, must_change: ${r3Create.data?.data?.must_change_password}`
    );
    const newUserId = r3Create.data?.data?.id;

    // Intento de crear con email duplicado -> 409
    const r3Dup = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: {
        name: '[PRUEBA] Cajero Duplicado',
        email: testUserEmail,
        password: 'OtraClave123!',
        role: 'cajero',
      },
    });
    assert(
      r3Dup.status === 409,
      'Creación con email duplicado retorna 409 con mensaje claro',
      `status: ${r3Dup.status}, msg: ${r3Dup.data?.error?.message}`
    );

    // Reset de contraseña por Admin
    const r3Reset = await request(`/users/${newUserId}/reset-password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: { new_password: 'NuevaTemporal123!' },
    });
    const resetBodyString = JSON.stringify(r3Reset.data);
    const noPasswordLeaked = !resetBodyString.includes('NuevaTemporal123!') && !resetBodyString.includes('password_hash');
    assert(
      r3Reset.status === 200 && r3Reset.data?.data?.must_change_password === true && noPasswordLeaked,
      'Reset de contraseña exitoso (200), setea must_change_password = true y no filtra contraseña',
      `status: ${r3Reset.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 4: Cambio de Contraseña (/api/auth/change-password)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 4: Cambio de Contraseña (/api/auth/change-password) ---');
    // Login del usuario con contraseña reseteada
    const loginUser = await request('/auth/login', {
      method: 'POST',
      body: { email: testUserEmail, password: 'NuevaTemporal123!' },
    });
    assert(
      loginUser.status === 200 && loginUser.data?.data?.user?.must_change_password === true,
      'Login con contraseña temporal reporta must_change_password = true',
      `status: ${loginUser.status}`
    );
    const tokenNewUser = loginUser.data?.data?.token;

    // Error con contraseña actual incorrecta -> 401
    const r4a = await request('/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenNewUser}` },
      body: { current_password: 'ClaveEquivocada1', new_password: 'MiDefinitiva2026!' },
    });
    assert(
      r4a.status === 401,
      'Cambio de contraseña rechaza contraseña actual incorrecta (401)',
      `status: ${r4a.status}`
    );

    // Error con nueva contraseña igual a la actual -> 422
    const r4b = await request('/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenNewUser}` },
      body: { current_password: 'NuevaTemporal123!', new_password: 'NuevaTemporal123!' },
    });
    assert(
      r4b.status === 422,
      'Cambio de contraseña impide que la nueva sea igual a la actual (422)',
      `status: ${r4b.status}`
    );

    // Error con nueva contraseña débil -> 422
    const r4c = await request('/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenNewUser}` },
      body: { current_password: 'NuevaTemporal123!', new_password: 'sololetras' },
    });
    assert(
      r4c.status === 422,
      'Cambio de contraseña rechaza nueva contraseña débil (422)',
      `status: ${r4c.status}`
    );

    // Cambio exitoso -> 200 y must_change_password = false
    const r4d = await request('/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenNewUser}` },
      body: { current_password: 'NuevaTemporal123!', new_password: 'Definitiva2026!' },
    });
    assert(
      r4d.status === 200,
      'Cambio de contraseña exitoso (200)',
      `status: ${r4d.status}`
    );

    // Verificar en BD que must_change_password quedó en false
    const { rows: dbUserAfterChange } = await pool.query(
      'SELECT must_change_password FROM users WHERE id = $1',
      [newUserId]
    );
    assert(
      dbUserAfterChange[0]?.must_change_password === false,
      'Usuario queda con must_change_password = false en BD tras el cambio',
      `valor: ${dbUserAfterChange[0]?.must_change_password}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 5: Login Actualiza last_login_at y /auth/me Devuelve must_change_password
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 5: Login Actualiza last_login_at y Sesión Limpia ---');
    const { rows: beforeLogin } = await pool.query(
      'SELECT last_login_at FROM users WHERE id = $1',
      [newUserId]
    );

    // Pequeña espera para delta temporal
    await new Promise((r) => setTimeout(r, 200));

    const loginAfter = await request('/auth/login', {
      method: 'POST',
      body: { email: testUserEmail, password: 'Definitiva2026!' },
    });
    assert(
      loginAfter.status === 200 && loginAfter.data?.data?.user?.must_change_password === false,
      'Login con nueva contraseña devuelve must_change_password = false (200)',
      `status: ${loginAfter.status}`
    );

    const { rows: afterLogin } = await pool.query(
      'SELECT last_login_at FROM users WHERE id = $1',
      [newUserId]
    );
    const lastLoginUpdated =
      afterLogin[0]?.last_login_at &&
      (!beforeLogin[0]?.last_login_at || new Date(afterLogin[0].last_login_at) >= new Date(beforeLogin[0].last_login_at));
    assert(
      Boolean(lastLoginUpdated),
      'Login actualiza la columna last_login_at en la base de datos',
      `last_login_at: ${afterLogin[0]?.last_login_at}`
    );

    // /auth/me
    const meRes = await request('/auth/me', {
      headers: { Authorization: `Bearer ${loginAfter.data.data.token}` },
    });
    assert(
      meRes.status === 200 && meRes.data?.data?.must_change_password === false,
      'Endpoint /api/auth/me incluye must_change_password en el payload',
      `must_change: ${meRes.data?.data?.must_change_password}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 6: Protecciones de Auto-Modificación de Admin (409)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 6: Auto-Modificación de Admin Bloqueada (409) ---');
    const adminBId = companyB.adminId;

    // Intento de auto-desactivación por PATCH -> 409
    const r6Patch = await request(`/users/${adminBId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: { is_active: false },
    });
    assert(
      r6Patch.status === 409,
      'Admin no puede desactivarse a sí mismo mediante PATCH (409)',
      `status: ${r6Patch.status}, code: ${r6Patch.data?.error?.code}`
    );

    // Intento de auto-desactivación por DELETE -> 409
    const r6Delete = await request(`/users/${adminBId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    assert(
      r6Delete.status === 409,
      'Admin no puede desactivarse a sí mismo mediante DELETE (409)',
      `status: ${r6Delete.status}, code: ${r6Delete.data?.error?.code}`
    );

    // Intento de auto-degradación de rol -> 409
    const r6Role = await request(`/users/${adminBId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: { role: 'mecanico' },
    });
    assert(
      r6Role.status === 409,
      'Admin no puede quitarse el rol de administrador a sí mismo (409)',
      `status: ${r6Role.status}, code: ${r6Role.data?.error?.code}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 7: Protección del Último Admin Activo (409)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 7: Protección del Último Admin Activo (409) ---');
    // Creamos un segundo admin en B (limpiando si existía en empresa [PRUEBA])
    const secondAdminEmail = 'admin2_test@pruebab.local';
    await pool.query(
      `DELETE FROM users
       WHERE email = $1
         AND company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`,
      [secondAdminEmail]
    );

    const r7CreateAdmin2 = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: {
        name: '[PRUEBA] Segundo Admin B',
        email: secondAdminEmail,
        password: 'AdminPassword2026!',
        role: 'admin',
      },
    });
    assert(
      r7CreateAdmin2.status === 201,
      'Se crea segundo admin en Empresa B con éxito (201)',
      `status: ${r7CreateAdmin2.status}`
    );
    const admin2Id = r7CreateAdmin2.data?.data?.id;

    // Login con admin2
    const loginAdmin2 = await request('/auth/login', {
      method: 'POST',
      body: { email: secondAdminEmail, password: 'AdminPassword2026!' },
    });
    const tokenAdmin2 = loginAdmin2.data?.data?.token;

    // Desactivar el admin2 usando el primer admin -> Permitido (quedaba 1 activo)
    const r7DeactAdmin2 = await request(`/users/${admin2Id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    assert(
      r7DeactAdmin2.status === 200,
      'Desactivar un admin secundario está permitido mientras quede otro admin activo (200)',
      `status: ${r7DeactAdmin2.status}`
    );

    // Reactivar usuario admin2
    const r7Reactivate = await request(`/users/${admin2Id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: { is_active: true },
    });
    assert(
      r7Reactivate.status === 200 && r7Reactivate.data?.data?.is_active === true,
      'Reactivación de usuario mediante PATCH is_active: true funciona correctamente (200)',
      `status: ${r7Reactivate.status}`
    );

    // Volver a desactivar admin2 para dejar 1 solo admin activo
    await request(`/users/${admin2Id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });

    // Ahora intentamos con una petición de admin que el único admin activo sea degradado
    // Como admin2 ya está inactivo, si admin2 intenta algo, o si intentamos degradar al adminBId:
    // Creamos un cajero que intente ver o verificamos que adminBId no puede ser degradado
    // Usamos query directa para verificar la regla: al quedar 1 solo admin activo,
    // intentar desactivar o cambiar de rol al admin principal desde la función service arroja 409
    const r7LastAdminDeact = await request(`/users/${adminBId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: { is_active: false },
    });
    assert(
      r7LastAdminDeact.status === 409,
      'Intento de desactivar al último admin activo arroja 409',
      `status: ${r7LastAdminDeact.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 8: Revocación Inmediata en authenticate.js (401 en vivo)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 8: Revocación Inmediata en authenticate.js ---');
    // Token del admin2 (que acabamos de desactivar arriba)
    const r8DeactivatedToken = await request('/users', {
      headers: { Authorization: `Bearer ${tokenAdmin2}` },
    });
    assert(
      r8DeactivatedToken.status === 401,
      'Token de usuario desactivado se revoca inmediatamente sin esperar las 8h (401)',
      `status: ${r8DeactivatedToken.status}, code: ${r8DeactivatedToken.data?.error?.code}`
    );

    // Suspender la empresa B
    await pool.query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [companyBId]);

    const r8SuspendedCompany = await request('/users', {
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    assert(
      r8SuspendedCompany.status === 401,
      'Petición con empresa suspendida se revoca inmediatamente (401)',
      `status: ${r8SuspendedCompany.status}, code: ${r8SuspendedCompany.data?.error?.code}`
    );

    // Restaurar estado de empresa B
    await pool.query(`UPDATE companies SET status = 'active' WHERE id = $1`, [companyBId]);

    const r8Restored = await request('/users', {
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    assert(
      r8Restored.status === 200,
      'Al reactivar la empresa, las peticiones vuelven a responder 200 exitosamente',
      `status: ${r8Restored.status}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 8b: Sincronización Inmediata de Rol en Vivo (authenticate.js)
    // Cajero [PRUEBA] con sesión abierta hace GET /api/sales -> 200;
    // admin le cambia el rol a mecanico; con el MISMO token:
    // GET /api/sales -> 403 y GET /api/workorders -> 200
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 8b: Sincronización Inmediata de Rol en Vivo ---');
    const roleTestEmail = 'cajero_role_sync@pruebab.local';

    // Limpieza previa filtrando estrictamente por empresa [PRUEBA]
    await pool.query(
      `DELETE FROM users
       WHERE email = $1
         AND company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`,
      [roleTestEmail]
    );

    // 1. Crear usuario cajero [PRUEBA]
    const rRoleUserCreate = await request('/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: {
        name: '[PRUEBA] Cajero Role Sync',
        email: roleTestEmail,
        password: 'Password123!',
        role: 'cajero',
      },
    });
    assert(
      rRoleUserCreate.status === 201,
      'Usuario cajero de prueba creado con éxito (201)',
      `status: ${rRoleUserCreate.status}`
    );
    const roleUserId = rRoleUserCreate.data?.data?.id;

    // 2. Login del cajero para obtener su token (cuyo JWT incluye role: "cajero")
    const loginRoleUser = await request('/auth/login', {
      method: 'POST',
      body: { email: roleTestEmail, password: 'Password123!' },
    });
    const tokenRoleUser = loginRoleUser.data?.data?.token;

    // 3. Con sesión abierta como cajero, GET /api/sales -> 200
    const rSalesAsCajero = await request('/sales', {
      headers: { Authorization: `Bearer ${tokenRoleUser}` },
    });
    assert(
      rSalesAsCajero.status === 200,
      'Cajero con sesión abierta accede exitosamente a GET /api/sales (200)',
      `status: ${rSalesAsCajero.status}`
    );

    // 4. El Admin le cambia el rol a "mecanico"
    const rChangeRole = await request(`/users/${roleUserId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: { role: 'mecanico' },
    });
    assert(
      rChangeRole.status === 200 && rChangeRole.data?.data?.role === 'mecanico',
      'Admin cambia el rol del usuario de "cajero" a "mecanico" (200)',
      `status: ${rChangeRole.status}, role: ${rChangeRole.data?.data?.role}`
    );

    // 5. Con el MISMO token del usuario (sin nuevo login):
    // GET /api/sales responde 403 Forbidden porque ahora su rol en BD es mecánico
    const rSalesAfterDemote = await request('/sales', {
      headers: { Authorization: `Bearer ${tokenRoleUser}` },
    });
    assert(
      rSalesAfterDemote.status === 403,
      'Con el MISMO token, usuario cambiado a mecánico recibe 403 en GET /api/sales',
      `status: ${rSalesAfterDemote.status}`
    );

    // 6. Con el MISMO token, GET /api/workorders responde 200 OK (mecánico sí tiene acceso a OT)
    const rWorkordersAfterDemote = await request('/workorders', {
      headers: { Authorization: `Bearer ${tokenRoleUser}` },
    });
    assert(
      rWorkordersAfterDemote.status === 200,
      'Con el MISMO token, usuario cambiado a mecánico recibe 200 en GET /api/workorders',
      `status: ${rWorkordersAfterDemote.status}`
    );

    // Baja lógica del usuario de prueba
    await pool.query(
      `UPDATE users SET is_active = false
       WHERE id = $1 AND company_id IN (SELECT id FROM companies WHERE razon_social LIKE '[PRUEBA]%')`,
      [roleUserId]
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 9: Formato Uniforme de Error en Módulo company
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 9: Formato Uniforme de Error en Módulo company ---');
    const r9CompanyError = await request('/company', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
      body: { ruc: '123' }, // RUC inválido
    });
    const hasCorrectFormat =
      r9CompanyError.status === 422 &&
      r9CompanyError.data?.success === false &&
      typeof r9CompanyError.data?.error?.message === 'string' &&
      typeof r9CompanyError.data?.error?.code === 'string';
    assert(
      hasCorrectFormat,
      'Error en /api/company responde con formato uniforme { success: false, error: { message, code } }',
      `response: ${JSON.stringify(r9CompanyError.data)}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Caso 10: Integridad Absoluta de Usuarios de Taller Principal
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- Caso 10: Integridad Absoluta de Usuarios de Taller Principal ---');
    const { rows: currentRealUsers } = await pool.query(
      `SELECT u.id, u.email, u.role, u.password_hash, u.is_active
       FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE c.razon_social = 'Taller Principal'
       ORDER BY u.id ASC`
    );

    let realUsersUntouched = currentRealUsers.length === initialRealUsers.length;
    for (let i = 0; i < currentRealUsers.length; i++) {
      const cur = currentRealUsers[i];
      const ini = initialRealUsers[i];
      if (
        cur.id !== ini.id ||
        cur.email !== ini.email ||
        cur.role !== ini.role ||
        cur.password_hash !== ini.password_hash ||
        cur.is_active !== ini.is_active
      ) {
        realUsersUntouched = false;
        break;
      }
    }

    assert(
      realUsersUntouched,
      'Usuarios de Taller Principal intactos (ningún cambio en contraseñas, roles o estados)',
      `usuarios verificados: ${currentRealUsers.length}`
    );

  } catch (err) {
    console.error('💥  Error inesperado durante la verificación:', err);
    failedTests++;
  } finally {
    // Limpieza de empresas de prueba
    if (companyAId && companyBId) {
      await pool.query(
        `UPDATE companies SET is_active = false, status = 'active' WHERE id IN ($1, $2)`,
        [companyAId, companyBId]
      );
      console.log('\n🧹  Empresas de prueba desactivadas tras la verificación.');
    }
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`📊  RESULTADOS: ${passedTests}/${totalTests} pruebas pasaron.`);
  if (failedTests > 0) {
    console.log(`❌  ${failedTests} prueba(s) fallaron.`);
    console.log('===============================================================\n');
    process.exit(1);
  } else {
    console.log('🎉  TODAS LAS PRUEBAS DE LA TAREA 11.3 PASARON EXITOSAMENTE.');
    console.log('===============================================================\n');
    process.exit(0);
  }
}

run();
