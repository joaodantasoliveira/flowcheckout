import { GatewayError } from './errors.js';
import { misticpay } from './misticpay.js';
import { syncpay } from './syncpay.js';

export { GatewayError };

/**
 * Registro de gateways de pagamento.
 *
 * Para adicionar um terceiro, escreva um modulo com a mesma interface
 * (testCredentials, createPixCharge, checkTransaction, getBalance,
 * parseWebhook, credentialFields) e coloque aqui. Nada mais muda.
 */
export const GATEWAYS = {
  [misticpay.id]: misticpay,
  [syncpay.id]: syncpay,
};

export const DEFAULT_GATEWAY = misticpay.id;

export const getGateway = (id) => GATEWAYS[id] || null;

export const listGateways = () =>
  Object.values(GATEWAYS).map((g) => ({
    id: g.id,
    label: g.label,
    docsUrl: g.docsUrl,
    credentialFields: g.credentialFields,
  }));

export const isValidGateway = (id) => Boolean(GATEWAYS[id]);
