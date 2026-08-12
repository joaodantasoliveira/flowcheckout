import crypto from 'node:crypto';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { randomToken, safeEqual, verifyPassword, verifyTotp } from '../crypto-utils.js';
import { dbDelete, dbInsert, dbRpc, dbSelectOne, dbUpdate } from '../supabase.js';

const COOKIE = 'sid';

/** Sessao ociosa expira em 30 min; sessao absoluta em 12 h. */
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;

/**
 * Sessoes vivem na tabela admin_sessions.
 *
 * Guardamos apenas o SHA-256 do token: um dump do banco nao entrega cookies
 * utilizaveis. Em serverless nao ha alternativa a persistir — um Map em
 * memoria deslogaria o usuario a cada invocacao nova.
 */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const normalizeIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

/* ============================================================
   Cookies
   ============================================================ */

function parseCookies(header = '') {
  const jar = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

function setSessionCookie(res, token) {
  const bits = [
    `${COOKIE}=${token}`,
    `Path=${config.admin.path}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(ABSOLUTE_MS / 1000)}`,
  ];
  if (config.admin.cookieSecure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res) {
  const bits = [`${COOKIE}=`, `Path=${config.admin.path}`, 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (config.admin.cookieSecure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

/* ============================================================
   Barreiras de rede — antes de qualquer logica
   ============================================================ */

/**
 * Se ADMIN_HOST estiver definido, o painel so responde naquele host exato.
 * Acessar pelo dominio da loja devolve 404, identico a rota inexistente.
 */
export function hostGuard(req, res, next) {
  if (!config.admin.host) return next();

  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host !== config.admin.host.toLowerCase()) return res.status(404).end();

  next();
}

/** Allowlist opcional de IPs. A defesa mais forte se voce tem IP fixo ou VPN. */
export function ipGuard(req, res, next) {
  if (!config.admin.ipAllowlist.length) return next();

  const ip = normalizeIp(req.ip);
  if (!config.admin.ipAllowlist.includes(ip)) {
    console.warn(`[admin] acesso bloqueado por IP: ${ip}`);
    return res.status(404).end();
  }
  next();
}

/** Nenhuma pagina do painel pode ser cacheada, indexada ou enquadrada. */
export function noStore(req, res, next) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' https://fonts.googleapis.com; " +
      'font-src https://fonts.gstatic.com; ' +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "form-action 'self'; " +
      "base-uri 'none'; " +
      "frame-ancestors 'none'; " +
      "object-src 'none'",
  });
  next();
}

/* ============================================================
   Login / logout
   ============================================================ */

const rpcRow = (result) => (Array.isArray(result) ? result[0] : result) || {};

export async function login(req, res) {
  const ip = normalizeIp(req.ip);
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const totp = String(req.body?.totp || '');

  // Trava por IP e por usuario: trocar so um dos dois nao contorna.
  for (const key of [`ip:${ip}`, `user:${username}`]) {
    const lock = rpcRow(await dbRpc('check_auth_lock', { p_key: key }));
    if (lock.locked) {
      return res.status(429).json({
        error: `Muitas tentativas. Tente novamente em ${lock.retry_after}s.`,
      });
    }
  }

  const admin = await dbSelectOne('admins', { filters: { username: `eq.${username}` } });

  // Mensagem unica para usuario inexistente, senha errada e TOTP errado:
  // nao entregamos ao atacante em qual etapa ele falhou.
  const fail = async () => {
    await dbRpc('register_auth_failure', { p_key: `ip:${ip}` });
    await dbRpc('register_auth_failure', { p_key: `user:${username}` });
    await audit('login.falha', { ip, detail: { username } });
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  };

  if (!admin || !admin.active) {
    // Gasta o mesmo tempo de um scrypt real: o tempo de resposta nao pode
    // revelar se o usuario existe.
    verifyPassword(password, 'scrypt$32768$8$1$00$00');
    return fail();
  }

  if (!verifyPassword(password, admin.password_hash)) return fail();

  const counter = verifyTotp(admin.totp_secret, totp);
  if (counter === null) return fail();

  // Um mesmo codigo TOTP nao pode ser reaproveitado dentro da janela de 30s.
  if (admin.last_totp_counter && counter <= Number(admin.last_totp_counter)) {
    await audit('login.totp_reutilizado', { adminId: admin.id, ip });
    return res.status(401).json({ error: 'Código já utilizado. Aguarde o próximo.' });
  }

  await dbUpdate(
    'admins',
    { id: `eq.${admin.id}` },
    {
      last_totp_counter: counter,
      last_login_at: new Date().toISOString(),
      last_login_ip: ip,
      updated_at: new Date().toISOString(),
    }
  );

  await dbRpc('clear_auth_failures', { p_key: `ip:${ip}` });
  await dbRpc('clear_auth_failures', { p_key: `user:${username}` });

  const token = randomToken(32);
  await dbInsert('admin_sessions', {
    token_hash: hashToken(token),
    admin_id: admin.id,
    csrf: randomToken(24),
    ip,
    user_agent: req.get('user-agent') || '',
  });

  setSessionCookie(res, token);
  await audit('login.sucesso', { adminId: admin.id, ip });

  res.json({ ok: true, name: admin.name || admin.username });
}

export async function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await dbDelete('admin_sessions', { token_hash: `eq.${hashToken(token)}` });

  clearSessionCookie(res);
  await audit('logout', { adminId: req.admin?.id, ip: normalizeIp(req.ip) });
  res.json({ ok: true });
}

/* ============================================================
   Middleware de sessao
   ============================================================ */

export async function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];

  const reject = async (reason) => {
    if (token) await dbDelete('admin_sessions', { token_hash: `eq.${hashToken(token)}` });
    clearSessionCookie(res);
    return res.status(401).json({ error: reason });
  };

  if (!token) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Sessão expirada.' });
  }

  let session;
  try {
    session = await dbSelectOne('admin_sessions', {
      select: '*,admins(*)',
      filters: { token_hash: `eq.${hashToken(token)}` },
    });
  } catch (err) {
    console.error('[auth] falha ao consultar sessão:', err.message);
    return res.status(503).json({ error: 'Serviço indisponível. Tente novamente.' });
  }

  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Sessão expirada.' });
  }

  const lastSeen = new Date(session.last_seen_at).getTime();
  const createdAt = new Date(session.created_at).getTime();
  if (Date.now() - lastSeen > IDLE_MS || Date.now() - createdAt > ABSOLUTE_MS) {
    return reject('Sessão expirada.');
  }

  // Sessao amarrada ao IP e ao user-agent: um cookie roubado e usado de outra
  // maquina cai aqui.
  if (session.ip !== normalizeIp(req.ip) || session.user_agent !== (req.get('user-agent') || '')) {
    await audit('sessao.contexto_divergente', { adminId: session.admin_id, ip: normalizeIp(req.ip) });
    return reject('Sessão inválida.');
  }

  const admin = session.admins;
  if (!admin || !admin.active) return reject('Sessão inválida.');

  // Renova o "visto por ultimo" no maximo uma vez por minuto, para nao
  // gravar no banco a cada clique.
  if (Date.now() - lastSeen > 60_000) {
    dbUpdate(
      'admin_sessions',
      { token_hash: `eq.${hashToken(token)}` },
      { last_seen_at: new Date().toISOString() }
    ).catch(() => {});
  }

  req.admin = admin;
  req.session = session;
  req.sessionToken = token;
  next();
}

/**
 * CSRF: o token vive na sessao (servidor) e precisa vir num header custom.
 * Header custom nao pode ser enviado por um form cross-site, e o SameSite=Strict
 * do cookie ja barra a maior parte do vetor. As duas camadas juntas fecham.
 */
export async function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const sent = req.get('x-csrf-token');
  if (!sent || !safeEqual(sent, req.session.csrf)) {
    await audit('csrf.rejeitado', { adminId: req.admin?.id, ip: normalizeIp(req.ip) });
    return res.status(403).json({ error: 'Token de segurança inválido. Recarregue a página.' });
  }
  next();
}

export const currentCsrf = (req) => req.session.csrf;

/** Encerra todas as sessoes do administrador, menos a atual. */
export async function revokeOtherSessions(adminId, currentToken) {
  const hash = hashToken(currentToken);
  await dbDelete('admin_sessions', {
    admin_id: `eq.${adminId}`,
    token_hash: `neq.${hash}`,
  });
}
