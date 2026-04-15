import { useState } from 'react';
import { useSigner, useMiden, useAccount, useSyncState } from '@miden-sdk/react';
import { useTurnkeySigner } from '@miden-sdk/miden-turnkey-react';

function App() {
  // Unified signer context (from TurnkeySignerProvider)
  const signer = useSigner();

  // Turnkey-specific state (extended API: status, error, signMessage, refresh)
  const {
    account,
    status,
    error,
    signMessage,
    refresh,
  } = useTurnkeySigner();

  // Miden client state
  const { isReady, isInitializing, error: midenError, signerAccountId, sync } = useMiden();

  // Sync state
  const { syncHeight, isSyncing, lastSyncTime } = useSyncState();

  // Account details when a signer account exists
  const accountResult = useAccount(signerAccountId ?? undefined);

  // Local state for the "sign arbitrary message" demo
  const [rawMessage, setRawMessage] = useState(
    '0x68656c6c6f2066726f6d206d6964656e2074757274',
  );
  const [lastSig, setLastSig] = useState<{ r: string; s: string; v: string } | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleConnect = async () => {
    if (signer?.isConnected) await signer.disconnect();
    else await signer?.connect();
  };

  const handleSync = async () => {
    await sync();
  };

  const handleSign = async () => {
    if (!rawMessage) return;
    setIsSigning(true);
    setSignError(null);
    try {
      const sig = await signMessage(rawMessage);
      setLastSig(sig);
    } catch (e) {
      setSignError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSigning(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const statusColor: Record<string, string> = {
    idle: '#888',
    connecting: '#ff9500',
    connected: '#22aa55',
    error: '#dc3545',
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Miden + Turnkey Signer Integration</h1>
        <p style={styles.subtitle}>
          Demonstrates TurnkeySignerProvider + MidenProvider with the unified signer
          interface.
        </p>

        {/* Status banner */}
        <div
          style={{
            ...styles.banner,
            background: statusColor[status] ?? '#888',
          }}
        >
          Status: {status.toUpperCase()}
          {status === 'error' && error ? ` — ${error.message}` : ''}
        </div>

        {/* Connection */}
        <Section title="Connection">
          <StatusRow label="Signer Connected" value={signer?.isConnected ? 'Yes' : 'No'} />
          <StatusRow label="Signer Name" value={signer?.name ?? 'None'} />
          <StatusRow label="Miden Ready" value={isReady ? 'Yes' : 'No'} />
          <StatusRow label="Initializing" value={isInitializing ? 'Yes' : 'No'} />
          {midenError && <StatusRow label="Miden Error" value={midenError.message} isError />}
        </Section>

        {/* Turnkey Account */}
        {account && (
          <Section title="Turnkey Account">
            <StatusRow label="Address" value={account.address} truncate />
            {account.publicKey && (
              <StatusRow label="Public Key" value={account.publicKey} truncate />
            )}
            <StatusRow label="Format" value={account.addressFormat} />
          </Section>
        )}

        {/* Miden Account */}
        {signerAccountId && (
          <Section title="Miden Account">
            <StatusRow label="Account ID" value={signerAccountId} truncate />
            {accountResult.account && (
              <>
                <StatusRow
                  label="Nonce"
                  value={accountResult.account.nonce().toString()}
                />
                <StatusRow
                  label="Is Faucet"
                  value={accountResult.account.isFaucet() ? 'Yes' : 'No'}
                />
              </>
            )}
          </Section>
        )}

        {/* Sync State */}
        {isReady && (
          <Section title="Sync State">
            <StatusRow label="Block Height" value={syncHeight.toString()} />
            <StatusRow label="Syncing" value={isSyncing ? 'Yes' : 'No'} />
            <StatusRow
              label="Last Sync"
              value={lastSyncTime ? new Date(lastSyncTime).toLocaleTimeString() : 'Never'}
            />
          </Section>
        )}

        {/* Balances */}
        {accountResult.assets.length > 0 && (
          <Section title="Balances">
            {accountResult.assets.map((asset) => (
              <StatusRow
                key={asset.assetId}
                label={asset.symbol ?? 'Asset'}
                value={`${asset.amount.toString()} (${truncate(asset.assetId, 16)})`}
              />
            ))}
          </Section>
        )}

        {/* Arbitrary message signing — exercises the new signMessage() API */}
        {signer?.isConnected && (
          <Section title="Sign Arbitrary Message">
            <label style={styles.label} htmlFor="msg">
              Hex payload
            </label>
            <input
              id="msg"
              style={styles.input}
              value={rawMessage}
              onChange={(e) => setRawMessage(e.target.value)}
              placeholder="0x..."
            />
            <div style={styles.inlineButtons}>
              <button
                style={styles.button}
                onClick={handleSign}
                disabled={isSigning || !rawMessage}
              >
                {isSigning ? 'Signing...' : 'Sign with Turnkey'}
              </button>
            </div>
            {signError && (
              <p style={{ ...styles.errorText, marginTop: '0.5rem' }}>{signError}</p>
            )}
            {lastSig && (
              <pre style={styles.sigBlock}>
                {JSON.stringify(lastSig, null, 2)}
              </pre>
            )}
          </Section>
        )}

        {/* Actions */}
        <div style={styles.buttonGroup}>
          <button
            style={signer?.isConnected ? styles.buttonSecondary : styles.button}
            onClick={handleConnect}
            disabled={status === 'connecting'}
          >
            {status === 'connecting'
              ? 'Connecting...'
              : signer?.isConnected
                ? 'Disconnect'
                : 'Connect'}
          </button>

          {signer?.isConnected && (
            <button
              style={styles.buttonSecondary}
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing...' : 'Refresh wallet'}
            </button>
          )}

          {isReady && (
            <button
              style={styles.buttonSecondary}
              onClick={handleSync}
              disabled={isSyncing}
            >
              {isSyncing ? 'Syncing...' : 'Sync'}
            </button>
          )}
        </div>

        {/* Debug */}
        <details style={styles.debug}>
          <summary style={styles.debugSummary}>Debug Info</summary>
          <pre style={styles.debugContent}>
            {JSON.stringify(
              {
                status,
                signerConnected: signer?.isConnected,
                signerName: signer?.name,
                isReady,
                isInitializing,
                signerAccountId,
                turnkeyAddress: account?.address,
                error: error?.message,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <h2 style={styles.sectionTitle}>{title}</h2>
      {children}
    </div>
  );
}

function StatusRow({
  label,
  value,
  isError = false,
  truncate: shouldTruncate = false,
}: {
  label: string;
  value: string;
  isError?: boolean;
  truncate?: boolean;
}) {
  const displayValue = shouldTruncate ? truncate(value, 24) : value;
  return (
    <div style={styles.statusRow}>
      <span style={styles.statusLabel}>{label}:</span>
      <span
        style={{
          ...styles.statusValue,
          ...(isError ? styles.errorText : {}),
        }}
      >
        {displayValue}
      </span>
    </div>
  );
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 3) / 2);
  return `${str.slice(0, half)}...${str.slice(-half)}`;
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
  },
  card: {
    background: 'white',
    borderRadius: '12px',
    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
    padding: '2rem',
    maxWidth: '560px',
    width: '100%',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    color: '#333',
    marginBottom: '0.25rem',
  },
  subtitle: {
    color: '#666',
    marginBottom: '1rem',
    fontSize: '0.9rem',
  },
  banner: {
    color: 'white',
    padding: '0.5rem 0.75rem',
    borderRadius: '6px',
    fontSize: '0.8rem',
    fontWeight: 600,
    letterSpacing: '0.05em',
    marginBottom: '1rem',
  },
  section: {
    background: '#f8f9fa',
    borderRadius: '8px',
    padding: '1rem',
    marginBottom: '1rem',
  },
  sectionTitle: {
    fontSize: '0.8rem',
    fontWeight: 600,
    color: '#ff5500',
    marginBottom: '0.75rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.25rem 0',
    borderBottom: '1px solid #eee',
  },
  statusLabel: { color: '#666', fontSize: '0.85rem' },
  statusValue: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    color: '#333',
    maxWidth: '60%',
    textAlign: 'right',
    wordBreak: 'break-all',
  },
  errorText: { color: '#dc3545' },
  label: {
    display: 'block',
    color: '#666',
    fontSize: '0.8rem',
    marginBottom: '0.25rem',
  },
  input: {
    width: '100%',
    padding: '0.5rem 0.75rem',
    fontSize: '0.85rem',
    fontFamily: 'monospace',
    border: '1px solid #ddd',
    borderRadius: '6px',
    marginBottom: '0.5rem',
  },
  inlineButtons: {
    display: 'flex',
    gap: '0.5rem',
  },
  sigBlock: {
    background: '#fff',
    border: '1px solid #eee',
    borderRadius: '6px',
    padding: '0.5rem',
    marginTop: '0.5rem',
    fontSize: '0.75rem',
    overflow: 'auto',
  },
  buttonGroup: {
    display: 'flex',
    gap: '0.5rem',
    marginTop: '1rem',
    flexWrap: 'wrap',
  },
  button: {
    flex: 1,
    minWidth: '120px',
    padding: '0.7rem 1rem',
    fontSize: '0.95rem',
    fontWeight: 600,
    color: 'white',
    background: '#ff5500',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  buttonSecondary: {
    flex: 1,
    minWidth: '120px',
    padding: '0.7rem 1rem',
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#ff5500',
    background: 'white',
    border: '2px solid #ff5500',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  debug: {
    marginTop: '1.5rem',
    padding: '0.5rem',
    background: '#f1f1f1',
    borderRadius: '4px',
  },
  debugSummary: {
    cursor: 'pointer',
    color: '#666',
    fontSize: '0.75rem',
  },
  debugContent: {
    marginTop: '0.5rem',
    fontSize: '0.7rem',
    overflow: 'auto',
    maxHeight: '200px',
  },
};

export default App;
