/**
 * Entrada da Vercel.
 *
 * A Vercel importa este arquivo e passa (req, res) direto para o app Express,
 * sem app.listen(). O vercel.json manda todas as rotas para ca, entao o
 * roteamento (inclusive o prefixo secreto do painel) continua igual ao local.
 */
import { app } from '../src/app.js';

export default app;
