import './polyfills';
import { createRoot } from 'react-dom/client';
import { TurnkeySignerProvider } from '@miden-sdk/miden-turnkey-react';
import { MidenProvider } from '@miden-sdk/react';
import '@turnkey/react-wallet-kit/styles.css';
import App from './App';

const organizationId = import.meta.env.VITE_TURNKEY_ORGANIZATION_ID;
const rpId = import.meta.env.VITE_TURNKEY_RP_ID ?? window.location.hostname;
const authProxyConfigId = import.meta.env.VITE_TURNKEY_AUTH_PROXY_CONFIG_ID;

if (!organizationId) {
  throw new Error(
    'Missing VITE_TURNKEY_ORGANIZATION_ID. Copy .env.example to .env and fill it in.'
  );
}

createRoot(document.getElementById('root')!).render(
  <TurnkeySignerProvider
    config={{
      organizationId,
      passkeyConfig: { rpId },
      ...(authProxyConfigId ? { authProxyConfigId } : {}),
      auth: {
        methods: {
          passkeyAuthEnabled: true,
          emailOtpAuthEnabled: true,
        },
        methodOrder: ['passkey', 'email'],
      },
    }}
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
    <MidenProvider
      config={{
        rpcUrl: 'https://rpc.devnet.miden.io',
        prover: 'https://tx-prover.devnet.miden.io',
      }}
    >
      <App />
    </MidenProvider>
  </TurnkeySignerProvider>
);
