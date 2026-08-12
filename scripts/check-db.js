/**
 * Diagnostico da conexao com o Supabase.
 *
 *   npm run db:check
 *
 * Diz exatamente o que esta faltando: chave errada, schema nao aplicado
 * ou tudo certo.
 */

import { config } from '../src/config.js';
import { dbRpc, dbSelect } from '../src/supabase.js';

const TABLES = [
  'products',
  'orders',
  'admins',
  'admin_sessions',
  'auth_attempts',
  'rate_limits',
  'audit_log',
];

const FUNCTIONS = ['bump_rate_limit', 'check_auth_lock', 'register_auth_failure', 'cleanup_expired'];

console.log(`\nSupabase: ${config.supabase.url}\n`);

let missing = 0;

for (const table of TABLES) {
  try {
    await dbSelect(table, { select: '*', limit: 1 });
    console.log(`  OK     tabela ${table}`);
  } catch (err) {
    missing++;
    console.log(`  FALTA  tabela ${table} — ${err.message}`);
  }
}

console.log('');

for (const fn of FUNCTIONS) {
  try {
    // Argumentos inofensivos so para verificar se a funcao existe.
    const args =
      fn === 'bump_rate_limit'
        ? { p_key: '__diagnostico__', p_window_ms: 1000, p_max: 1000000 }
        : fn === 'cleanup_expired'
          ? {}
          : { p_key: '__diagnostico__' };

    await dbRpc(fn, args);
    console.log(`  OK     função ${fn}()`);
  } catch (err) {
    missing++;
    console.log(`  FALTA  função ${fn}() — ${err.message}`);
  }
}

if (missing) {
  console.log(
    `\n${missing} item(ns) faltando.\n` +
      `Abra o SQL Editor do Supabase e rode o conteúdo de supabase/schema.sql.\n`
  );
  process.exit(1);
}

const products = await dbSelect('products', { select: 'id,name,active' });
const admins = await dbSelect('admins', { select: 'username,active' });

console.log('\nSchema aplicado e acessível.\n');
console.log(`  produtos cadastrados: ${products.length}`);
console.log(`  administradores:      ${admins.length}${admins.length ? '' : '  <- rode: npm run admin:create'}`);
console.log('');
process.exit(0);
