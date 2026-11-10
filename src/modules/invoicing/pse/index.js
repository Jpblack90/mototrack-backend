import { simulatedProvider } from './simulated.js';
import { nubefactProvider } from './nubefact.js';

/**
 * Obtiene el adaptador PSE correspondiente para la empresa indicada.
 *
 * @param {object} company Objeto empresa con campos pse_provider, pse_url, pse_token_enc
 * @returns {typeof simulatedProvider | typeof nubefactProvider}
 */
export function getPseProvider(company) {
  if (company?.pse_provider === 'nubefact') {
    return nubefactProvider;
  }
  return simulatedProvider;
}

export { simulatedProvider, nubefactProvider };
