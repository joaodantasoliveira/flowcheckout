/**
 * Cria (ou redefine) o usuario administrador do painel.
 *
 *   npm run admin:create
 *
 * A senha e digitada sem eco e nunca fica no historico do shell.
 * O segredo TOTP e mostrado UMA unica vez — cadastre no autenticador na hora.
 */

import crypto from 'node:crypto';
import readline from 'node:readline';

import { audit } from '../src/audit.js';
import { checkDatabase, dbInsert, dbSelectOne, dbUpdate } from '../src/supabase.js';
import { generateTotpSecret, hashPassword, totpUri, verifyTotp } from '../src/crypto-utils.js';

/** Pergunta simples, com eco. Abre e fecha o readline a cada uso. */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Leitura em modo raw, sem eco — usada para a senha. */
function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);

    const stdin = process.stdin;
    const chunks = [];

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const finish = (value) => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };

    function onData(input) {
      for (const char of input) {
        if (char === String.fromCharCode(10) || char === String.fromCharCode(13) || char === String.fromCharCode(4)) return finish(chunks.join(String()));

        if (char === String.fromCharCode(3)) {
          // Ctrl+C
          if (stdin.isTTY) stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(1);
        }

        if (char === String.fromCharCode(127) || char === String.fromCharCode(8)) {
          chunks.pop();
          continue;
        }

        if (char >= ' ') chunks.push(char);
      }
    }

    stdin.on('data', onData);
  });
}

function passwordProblems(password) {
  const problems = [];
  if (password.length < 12) problems.push('pelo menos 12 caracteres');
  if (!/[a-z]/.test(password)) problems.push('uma letra minúscula');
  if (!/[A-Z]/.test(password)) problems.push('uma letra maiúscula');
  if (!/\d/.test(password)) problems.push('um número');
  if (!/[^\w\s]/.test(password)) problems.push('um símbolo');
  return problems;
}

async function main() {
  console.log('\n=== Criar administrador do painel ===\n');

  const database = await checkDatabase();
  if (!database.ok) {
    console.error('Não foi possível falar com o banco:', database.error, '\n');
    console.error('Se a mensagem fala em tabela não encontrada, abra o SQL Editor');
    console.error('do Supabase e rode o conteúdo de supabase/schema.sql.\n');
    process.exit(1);
  }

  const username = (await ask('Usuário: ')).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    console.error('\nUsuário inválido. Use 3 a 32 caracteres: letras, números, ponto, hífen ou _.\n');
    process.exit(1);
  }

  const existing = await dbSelectOne('admins', { filters: { username: `eq.${username}` } });
  if (existing) {
    const confirm = (await ask(`\n"${username}" já existe. Redefinir senha e 2FA? (digite SIM) `)).trim();
    if (confirm !== 'SIM') {
      console.log('\nCancelado.\n');
      process.exit(0);
    }
  }

  const name = (await ask('Nome de exibição: ')).trim() || username;

  const password = await askHidden('Senha (não aparece na tela): ');
  const problems = passwordProblems(password);
  if (problems.length) {
    console.error(`\nSenha fraca. Precisa de: ${problems.join(', ')}.\n`);
    process.exit(1);
  }

  const repeat = await askHidden('Repita a senha: ');
  if (repeat !== password) {
    console.error('\nAs senhas não conferem. Nada foi gravado.\n');
    process.exit(1);
  }

  const secret = generateTotpSecret();
  const uri = totpUri({ secret, account: username });

  console.log('\n--------------------------------------------------');
  console.log('  SEGUNDO FATOR (2FA)');
  console.log('--------------------------------------------------\n');
  console.log('  Abra o Google Authenticator, Authy ou 1Password e');
  console.log('  cadastre a chave abaixo ("inserir chave manualmente"):\n');
  console.log(`     ${secret.match(/.{1,4}/g).join(' ')}\n`);
  console.log('  Ou cole esta URI no seu gerenciador de senhas:\n');
  console.log(`     ${uri}\n`);
  console.log('  Esta chave NÃO será mostrada de novo.');
  console.log('--------------------------------------------------\n');

  // Confirma que o autenticador foi mesmo cadastrado antes de gravar:
  // evita criar um acesso que ninguem consegue usar.
  const code = await ask('Digite o código de 6 dígitos que aparece no app: ');

  if (verifyTotp(secret, code) === null) {
    console.error('\nCódigo incorreto. Nada foi gravado — rode o comando de novo.\n');
    process.exit(1);
  }

  const row = {
    username,
    name,
    password_hash: hashPassword(password),
    totp_secret: secret,
    last_totp_counter: 0,
    active: true,
    updated_at: new Date().toISOString(),
  };

  const admin = existing
    ? await dbUpdate('admins', { id: `eq.${existing.id}` }, row)
    : await dbInsert('admins', { id: crypto.randomUUID(), ...row });

  await audit(existing ? 'admin.redefinido' : 'admin.criado', {
    adminId: admin.id,
    detail: { username },
  });

  console.log(`\n✓ Administrador "${username}" pronto.\n`);
  console.log('  Guarde a chave 2FA num gerenciador de senhas. Sem ela e sem a');
  console.log('  senha não há acesso ao painel — e não existe recuperação por');
  console.log('  e-mail, de propósito.\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('\nErro:', err.message, '\n');
  process.exit(1);
});
