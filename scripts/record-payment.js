#!/usr/bin/env node
// =============================================================================
// scripts/record-payment.js
// Registra un pago manual de suscripción (Yape, Plin, Transferencia o Efectivo),
// actualiza la fecha de vencimiento (paid_until), activa la empresa y registra
// la operación en audit_logs de forma atómica en una única transacción.
//
// Uso:
//   node scripts/record-payment.js --company <id> --amount <S/> --method <yape|plin|transferencia|efectivo> [--ref <n.º>] [--months 1] [--notes "..."]
// =============================================================================

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import pool from '../src/config/database.js';
import { recordPayment } from '../src/modules/company/subscription.service.js';

function parseArgs(args) {
  const params = {
    company: null,
    amount: null,
    method: null,
    ref: null,
    months: 1,
    notes: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--company' && args[i + 1]) {
      params.company = args[++i];
    } else if (arg === '--amount' && args[i + 1]) {
      params.amount = args[++i];
    } else if (arg === '--method' && args[i + 1]) {
      params.method = args[++i];
    } else if (arg === '--ref' && args[i + 1]) {
      params.ref = args[++i];
    } else if (arg === '--months' && args[i + 1]) {
      params.months = args[++i];
    } else if (arg === '--notes' && args[i + 1]) {
      params.notes = args[++i];
    }
  }

  return params;
}

function printUsage() {
  console.log('\n📖  Uso de record-payment.js:');
  console.log('    node scripts/record-payment.js --company <id> --amount <S/> --method <yape|plin|transferencia|efectivo> [--ref <n.º>] [--months 1] [--notes "..."]\n');
  console.log('    Parámetros obligatorios:');
  console.log('      --company  ID numérico de la empresa a la que se le registra el pago');
  console.log('      --amount   Monto pagado en Soles (positivo, ej: 99.00)');
  console.log('      --method   Método de pago (yape, plin, transferencia, efectivo)');
  console.log('    Parámetros opcionales:');
  console.log('      --ref      Número de operación o comprobante de transferencia');
  console.log('      --months   Cantidad de meses contratados (1 a 12, por defecto 1)');
  console.log('      --notes    Notas adicionales u observaciones del pago\n');
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (!parsed.company || !parsed.amount || !parsed.method) {
    console.error('\n❌  Error: Faltan parámetros obligatorios (--company, --amount, --method).');
    printUsage();
    process.exit(1);
  }

  const companyId = parseInt(parsed.company, 10);
  if (isNaN(companyId) || companyId <= 0) {
    console.error(`\n❌  Error: El ID de empresa "${parsed.company}" no es válido.`);
    process.exit(1);
  }

  const amount = Number(parsed.amount);
  if (isNaN(amount) || amount <= 0) {
    console.error(`\n❌  Error: El monto "${parsed.amount}" debe ser un número positivo.`);
    process.exit(1);
  }

  const cleanMethod = String(parsed.method).toLowerCase().trim();
  const validMethods = ['yape', 'plin', 'transferencia', 'efectivo'];
  if (!validMethods.includes(cleanMethod)) {
    console.error(`\n❌  Error: Método "${parsed.method}" inválido. Permitidos: ${validMethods.join(', ')}.`);
    process.exit(1);
  }

  const months = parseInt(parsed.months, 10);
  if (isNaN(months) || months < 1 || months > 12) {
    console.error(`\n❌  Error: Los meses (${parsed.months}) deben ser un entero entre 1 y 12.`);
    process.exit(1);
  }

  try {
    const result = await recordPayment({
      companyId,
      amount,
      method: cleanMethod,
      reference: parsed.ref,
      months,
      notes: parsed.notes,
    });

    const companyName = result.company.nombre_comercial || result.company.razon_social;
    console.log('\n===============================================================');
    console.log('✅  PAGO DE SUSCRIPCIÓN REGISTRADO CON ÉXITO');
    console.log('===============================================================');
    console.log(`🏢  Empresa        : #${result.company.id} - ${companyName}`);
    console.log(`💰  Monto          : S/ ${Number(result.payment.amount).toFixed(2)} (${result.payment.method.toUpperCase()})`);
    if (result.payment.reference) {
      console.log(`🔖  Referencia     : ${result.payment.reference}`);
    }
    console.log(`🗓️   Meses          : +${result.payment.months} mes(es)`);
    console.log(`📅  Periodo cubierto: ${result.payment.period_from}  ➔  ${result.payment.period_to}`);
    console.log(`📌  Nuevo vencimiento: ${result.company.paid_until}`);
    console.log(`🟢  Estado empresa : ${result.company.status.toUpperCase()} (trial_ends_at: NULL)`);
    console.log(`🛡️   Auditoría      : Registrado en audit_logs (action: 'subscription_payment')`);
    console.log('===============================================================\n');

    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(`\n💥  Error al registrar pago para empresa #${companyId}:`, err.message || err);
    await pool.end();
    process.exit(1);
  }
}

main();
