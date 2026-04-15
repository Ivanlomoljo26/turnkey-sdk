import './polyfills';
import { createRoot } from 'react-dom/client';
import { TurnkeySignerProvider } from '@miden-sdk/miden-turnkey-react';
import { MidenProvider } from '@miden-sdk/react';
import App from './App';

const defaultOrganizationId = import.meta.env.VITE_TURNKEY_ORGANIZATION_ID;
const rpId = import.meta.env.VITE_TURNKEY_RP_ID ?? window.location.hostname;

if (!defaultOrganizationId) {
  throw new Error(
    'Missing VITE_TURNKEY_ORGANIZATION_ID. Copy .env.example to .env and fill it in.'
  );
}

createRoot(document.getElementById('root')!).render(
  <TurnkeySignerProvider
    config={{
      defaultOrganizationId,
      rpId,
      apiBaseUrl: 'https://api.turnkey.com',
    }}
    autoConnect
    onConnect={(account) => {
      // eslint-disable-next-line no-console
      console.log('[Turnkey] connected:', account.address);
    }}
    onDisconnect={() => {
      // eslint-disable-next-line no-console
      console.log('[Turnkey] disconnected');
    }}
    onError={(err, phase) => {
      // eslint-disable-next-line no-console
      console.error(`[Turnkey][${phase}]`, err);
    }}
  >
    <MidenProvider config={{ rpcUrl: 'devnet', prover: 'devnet' }}>
      <App />
    </MidenProvider>
  </TurnkeySignerProvider>
);
