/** Erro comum a todos os gateways, para as rotas tratarem de um jeito só. */
export class GatewayError extends Error {
  constructor(message, { status = 502, body = null } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.body = body;
  }
}
