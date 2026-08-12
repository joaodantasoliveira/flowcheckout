/**
 * Entrada para desenvolvimento local (`npm start`).
 * Na Vercel quem serve e api/index.js — os dois usam o mesmo app.
 */
import { app } from './src/app.js';
import { config } from './src/config.js';
import { checkDatabase } from './src/supabase.js';

const database = await checkDatabase();

app.listen(config.port, () => {
  console.log(`\n  Checkout rodando em  http://localhost:${config.port}`);
  console.log(`  Painel               http://localhost:${config.port}${config.admin.path}/`);
  console.log(`  Webhook configurado  ${config.publicUrl}/api/webhooks/misticpay/****\n`);

  if (!database.ok) {
    console.log('  --------------------------------------------------------');
    console.log('  BANCO NAO RESPONDEU:', database.error);
    console.log('');
    console.log('  Se a mensagem fala em tabela nao encontrada, o schema');
    console.log('  ainda nao foi aplicado. Abra o SQL Editor do Supabase e');
    console.log('  rode o conteudo de supabase/schema.sql (uma vez so).');
    console.log('  --------------------------------------------------------\n');
  }

  if (config.admin.host) console.log(`  Painel restrito ao host: ${config.admin.host}`);
  if (config.admin.ipAllowlist.length) {
    console.log(`  Painel restrito aos IPs: ${config.admin.ipAllowlist.join(', ')}`);
  }

  if (config.publicUrl.includes('localhost')) {
    console.log(
      '  Aviso: PUBLIC_URL aponta para localhost — a MisticPay nao conseguira\n' +
        '  entregar webhooks. Use ngrok em desenvolvimento. O polling de status\n' +
        '  continua funcionando normalmente.\n'
    );
  }
});
