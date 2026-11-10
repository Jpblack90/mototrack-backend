// =============================================================================
// scripts/tests/run-all-tests.js
// Ejecuta en orden todas las suites de prueba de MotoTrack AI:
// 1. isolation
// 2. users
// 3. audit
// 4. onboarding
// 5. ai
// 6. plans
// 7. payments
// 8. credit-notes
// 9. stock
// 10. pickup
// 11. whatsapp
// 12. company
// 13. pse
//
// Reinicia los contadores de rate limit entre suites para evitar que suites
// intensivas (como test:onboarding con 50 logins fallidos) bloqueen las siguientes.
// Al final presenta un resumen general (PASA/FALLA y conteo de pruebas).
// =============================================================================

import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const API_URL = process.env.API_URL || 'http://localhost:4000/api';

const SUITES = [
  { name: 'isolation',    script: 'scripts/tests/test-isolation.js' },
  { name: 'users',        script: 'scripts/tests/verify-11-3.js' },
  { name: 'audit',        script: 'scripts/tests/verify-11-4.js' },
  { name: 'onboarding',   script: 'scripts/tests/verify-11-5.js' },
  { name: 'ai',           script: 'scripts/tests/verify-12-0.js' },
  { name: 'plans',        script: 'scripts/tests/verify-12-1.js' },
  { name: 'payments',     script: 'scripts/tests/verify-12-2.js' },
  { name: 'credit-notes', script: 'scripts/tests/verify-12-3.js' },
  { name: 'stock',        script: 'scripts/tests/verify-12-4.js' },
  { name: 'pickup',       script: 'scripts/tests/verify-12-5.js' },
  { name: 'whatsapp',     script: 'scripts/tests/verify-12-6.js' },
  { name: 'company',      script: 'scripts/tests/verify-11-2b.js' },
  { name: 'pse',          script: 'scripts/tests/verify-13-1.js' },
  { name: 'billing',      script: 'scripts/tests/verify-13-2.js' },
  { name: 'mechanic',     script: 'scripts/tests/verify-14-1.js' },
];

async function resetRateLimit() {
  try {
    const res = await fetch(`${API_URL}/auth/reset-rate-limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      // Ignorar silenciosamente si no está disponible
    }
  } catch (_e) {
    // Si el backend no responde al reset, continuar
  }
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const fullPath = path.resolve(ROOT_DIR, suite.script);
    const child = spawn(process.execPath, [fullPath], {
      cwd: ROOT_DIR,
      env: { ...process.env },
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });

    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });

    child.on('close', (code) => {
      // Extraer métricas de pruebas del output
      let testsText = '';
      const resMatch = stdout.match(/RESULTADOS:\s*(\d+\/\d+|\d+)\s*pruebas\s*pasaron/i);
      if (resMatch) {
        testsText = resMatch[1];
        if (!testsText.includes('/')) testsText = `${testsText}/${testsText}`;
      } else {
        const passCount = (stdout.match(/\[PASA\]/g) || []).length;
        const failCount = (stdout.match(/\[FALLA\]/g) || []).length;
        const total = passCount + failCount;
        if (total > 0) {
          testsText = `${passCount}/${total}`;
        } else {
          const sections = (stdout.match(/---\s*\d+\./g) || []).length;
          testsText = sections > 0 ? `${sections}/${sections}` : (code === 0 ? 'OK' : 'ERROR');
        }
      }

      resolve({
        name: suite.name,
        passed: code === 0,
        tests: testsText,
        code,
      });
    });
  });
}

async function main() {
  console.log('===============================================================');
  console.log('🚀  EJECUTOR GENERAL DE SUITES BACKEND: test:all');
  console.log('===============================================================\n');

  const results = [];
  let anyFailed = false;

  for (let i = 0; i < SUITES.length; i++) {
    const suite = SUITES[i];

    // Reiniciar rate limits antes de cada suite para garantizar aislamiento
    await resetRateLimit();

    console.log(`\n▶️  [${i + 1}/${SUITES.length}] Ejecutando suite: ${suite.name} (${suite.script})...\n`);
    const res = await runSuite(suite);
    results.push(res);

    if (!res.passed) {
      anyFailed = true;
    }

    // Reiniciar rate limits inmediatamente después de la suite (vital tras test:onboarding)
    await resetRateLimit();
  }

  // Resumen final
  console.log('\n===============================================================');
  console.log('📊  RESUMEN FINAL DE SUITES (test:all)');
  console.log('===============================================================');

  let passedSuites = 0;
  let failedSuites = 0;

  results.forEach((r, idx) => {
    const num = String(idx + 1).padStart(2, ' ');
    const namePad = r.name.padEnd(14, ' ');
    const status = r.passed ? '✅ PASA ' : '❌ FALLA';
    const tests = `(${r.tests} pruebas)`.padStart(16, ' ');
    console.log(`  ${num}. ${namePad} | ${status} | ${tests}`);
    if (r.passed) passedSuites++;
    else failedSuites++;
  });

  console.log('---------------------------------------------------------------');
  console.log(`Total suites: ${results.length} | Aprobadas: ${passedSuites} | Fallidas: ${failedSuites}`);
  console.log('===============================================================\n');

  if (anyFailed) {
    console.error('💥 Al menos una suite de pruebas falló. Revisa los logs anteriores.');
    process.exit(1);
  } else {
    console.log('🎉 TODAS LAS SUITES DE PRUEBA PASARON EXITOSAMENTE.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Error fatal ejecutando test:all:', err);
  process.exit(1);
});
