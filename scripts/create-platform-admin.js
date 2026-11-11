#!/usr/bin/env node
// =============================================================================
// scripts/create-platform-admin.js
// Crea una cuenta de administrador de plataforma (soporte / dueño SaaS)
// generando una contraseña temporal aleatoria que se muestra UNA sola vez.
// La cuenta inicia con must_change_password = true.
//
// Uso:
//   node scripts/create-platform-admin.js --email <correo> --name "<nombre>"
// =============================================================================

import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import pool from '../src/config/database.js';
import { validatePasswordPolicy } from '../src/shared/utils/passwordPolicy.js';

const SALT_ROUNDS = 10;

function parseArgs(args) {
  const params = { email: null, name: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--email' && args[i + 1]) {
      params.email = args[++i];
    } else if (arg.startsWith('--email=')) {
      params.email = arg.slice('--email='.length);
    } else if (arg === '--name' && args[i + 1]) {
      params.name = args[++i];
    } else if (arg.startsWith('--name=')) {
      params.name = arg.slice('--name='.length);
    }
  }

  return params;
}

function generateTempPassword(length = 14) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;

  const chars = [
    letters[crypto.randomInt(0, letters.length)],
    digits[crypto.randomInt(0, digits.length)],
  ];
  while (chars.length < length) {
    chars.push(all[crypto.randomInt(0, all.length)]);
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  const candidate = chars.join('');
  if (!validatePasswordPolicy(candidate).valid) {
    return generateTempPassword(length);
  }
  return candidate;
}

function printUsage() {
  console.log('\n📖  Uso de create-platform-admin.js:');
  console.log('    node scripts/create-platform-admin.js --email <correo> --name "<nombre completo>"\n');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase() : '';
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';

  if (!email || !name) {
    console.error('\n❌  Error: Debes especificar --email y --name.');
    printUsage();
    process.exit(1);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`\n❌  Error: El correo "${email}" no tiene un formato válido.`);
    process.exit(1);
  }

  if (name.length > 150) {
    console.error('\n❌  Error: El nombre no puede superar 150 caracteres.');
    process.exit(1);
  }

  const tempPassword = generateTempPassword(14);
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  let client;
  try {
    client = await pool.connect();

    const { rows } = await client.query(
      `INSERT INTO platform_admins (name, email, password_hash, is_active, must_change_password)
       VALUES ($1, $2, $3, true, true)
       RETURNING id, name, email, is_active, must_change_password, created_at`,
      [name, email, passwordHash]
    );

    const created = rows[0];
    console.log('\n✅  Administrador de plataforma creado exitosamente:');
    console.log(`    ID                   : ${created.id}`);
    console.log(`    Nombre               : ${created.name}`);
    console.log(`    Email                : ${created.email}`);
    console.log(`    must_change_password : ${created.must_change_password}`);
    console.log(`    Contraseña temporal  : ${tempPassword}`);
    console.log('\n⚠️  Guarda esta contraseña ahora; no se volverá a mostrar.');
    console.log('   Deberás cambiarla obligatoriamente en el primer inicio de sesión.\n');
  } catch (err) {
    if (err.code === '23505') {
      console.error(`\n❌  Error: Ya existe un administrador de plataforma con el correo "${email}".\n`);
    } else {
      console.error('\n❌  Error al crear el administrador de plataforma:', err.message);
    }
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

main();
