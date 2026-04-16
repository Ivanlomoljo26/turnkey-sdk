import { useState, useEffect, useCallback } from 'react';
import { useSigner, useMiden, useSyncState, useNotes, useConsume } from '@miden-sdk/react';
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

  // Miden client state — only isReady/isInitializing/error are safe to read during init
  const { isReady, isInitializing, error: midenError, signerAccountId, sync } = useMiden();

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
            <StatusRow label="Address" value={account.address} truncate copyable />
            {account.publicKey && (
              <StatusRow label="Public Key" value={account.publicKey} truncate copyable />
            )}
            <StatusRow label="Format" value={account.addressFormat} />
          </Section>
        )}

        {/*
          Miden-dependent sections: only mount AFTER isReady to prevent WASM
          borrow conflicts with the init-phase syncState() calls.
        */}
        {isReady && signerAccountId && (
          <MidenDashboard signerAccountId={signerAccountId} sync={sync} />
        )}

        {/* Arbitrary message signing — exercises the new signMessage() API */}
        {signer?.isConnected && (
          <details style={styles.section}>
            <summary style={styles.collapsibleSectionTitle}>
              Sign Arbitrary Message
            </summary>
            <div style={styles.collapsibleBody}>
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
            </div>
          </details>
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
              onClick={() => sync()}
              disabled={false}
            >
              Sync
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

/**
 * All Miden-dependent UI lives here so it only mounts AFTER init completes.
 *
 * NOTE: useAccount is intentionally NOT used — it auto-fires WASM queries on
 * mount that race with the SDK's internal syncState(), triggering the RefCell
 * borrow conflict. Instead, balance is fetched on-demand via a manual button.
 */
function MidenDashboard({ signerAccountId, sync }: { signerAccountId: string; sync: () => Promise<void> }) {
  const { client } = useMiden();
  const { syncHeight, isSyncing, lastSyncTime } = useSyncState();

  // bech32 address
  const [bech32AccountId, setBech32AccountId] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const { AccountId, Address, NetworkId } = await import('@miden-sdk/miden-sdk');
        const id = AccountId.fromHex(signerAccountId);
        const addr = Address.fromAccountId(id, 'BasicWallet');
        setBech32AccountId(addr.toBech32(NetworkId.devnet()));
      } catch (e) {
        console.warn('bech32 conversion failed:', e);
      }
    })();
  }, [signerAccountId]);

  // Manual balance fetch — avoids the useAccount hook that races with sync
  const [balances, setBalances] = useState<{ assetId: string; amount: string }[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const { AccountId } = await import('@miden-sdk/miden-sdk');
      if (!client) throw new Error('Miden client not available');

      const accountId = AccountId.fromHex(signerAccountId);
      const account = await client.getAccount(accountId);
      if (!account) throw new Error('Account not found');

      const vault = account.vault();
      const assets = vault.fungibleAssets();
      const result: { assetId: string; amount: string }[] = [];
      for (const asset of assets) {
        result.push({
          assetId: asset.faucetId().toString(),
          amount: asset.amount().toString(),
        });
      }
      setBalances(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Balance] fetch failed:', msg);
      setBalanceError(msg);
    } finally {
      setBalanceLoading(false);
    }
  }, [signerAccountId]);

  return (
    <>
      {/* Miden Account */}
      <Section title="Miden Account">
        <StatusRow label="Account ID (hex)" value={signerAccountId} truncate copyable />
        {bech32AccountId && (
          <StatusRow label="Address (bech32)" value={bech32AccountId} truncate copyable />
        )}
      </Section>

      {/* Sync State */}
      <Section title="Sync State">
        <StatusRow label="Block Height" value={syncHeight.toString()} />
        <StatusRow label="Syncing" value={isSyncing ? 'Yes' : 'No'} />
        <StatusRow
          label="Last Sync"
          value={lastSyncTime ? new Date(lastSyncTime).toLocaleTimeString() : 'Never'}
        />
      </Section>

      {/* Balances — manual fetch to avoid useAccount borrow conflict */}
      <Section title="Balances">
        {balances.map((b) => (
          <StatusRow
            key={b.assetId}
            label="Balance"
            value={b.amount}
          />
        ))}
        {balances.length === 0 && !balanceLoading && (
          <StatusRow label="Status" value={balanceError ?? 'Click Check Balance'} isError={!!balanceError} />
        )}
        <div style={{ ...styles.inlineButtons, marginTop: '0.5rem' }}>
          <button
            style={styles.button}
            onClick={fetchBalance}
            disabled={balanceLoading}
          >
            {balanceLoading ? 'Fetching...' : 'Check Balance'}
          </button>
        </div>
      </Section>

      {/* Notes — only when sync is idle */}
      {!isSyncing && (
        <NotesSection accountId={signerAccountId} onSyncRequest={sync} />
      )}
    </>
  );
}

/**
 * Separate component so useNotes/useConsume hooks only mount when sync is idle,
 * preventing concurrent WASM client borrows that trigger the Rust borrow-fail panic.
 */
function NotesSection({ accountId, onSyncRequest }: { accountId: string; onSyncRequest: () => Promise<void> }) {
  const { consumableNotes, consumableNoteSummaries, isLoading, refetch } = useNotes();
  const { consume, isLoading: isConsuming, stage, error: consumeError, reset } = useConsume();

  const handleConsumeAll = async () => {
    if (consumableNotes.length === 0) return;
    reset();
    try {
      const result = await consume({
        accountId,
        notes: consumableNotes.map((n) => n.inputNoteRecord()),
      });
      console.log('[Miden] Consumed notes, TX:', result.transactionId);
      await refetch();
      await onSyncRequest();
    } catch (e) {
      console.error('[Miden] Consume failed:', e);
    }
  };

  return (
    <Section title="Notes">
      <StatusRow
        label="Consumable"
        value={isLoading ? 'Loading...' : consumableNotes.length.toString()}
      />
      {consumableNoteSummaries.map((ns) => (
        <div key={ns.id} style={styles.noteItem}>
          <span style={styles.noteId}>{truncate(ns.id, 20)}</span>
          <span style={styles.noteAssets}>
            {ns.assets.map((a) => `${a.amount.toString()} ${a.symbol ?? truncate(a.assetId, 10)}`).join(', ') || 'No assets'}
          </span>
        </div>
      ))}
      {consumeError && (
        <p style={{ ...styles.errorText, marginTop: '0.5rem' }}>{consumeError.message}</p>
      )}
      <div style={{ ...styles.inlineButtons, marginTop: '0.5rem' }}>
        <button
          style={styles.button}
          onClick={handleConsumeAll}
          disabled={isConsuming || consumableNotes.length === 0}
        >
          {isConsuming ? `Consuming... (${stage})` : `Consume All (${consumableNotes.length})`}
        </button>
        <button
          style={styles.buttonSecondary}
          onClick={refetch}
          disabled={isLoading}
        >
          Refresh Notes
        </button>
      </div>
    </Section>
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
  copyable = false,
}: {
  label: string;
  value: string;
  isError?: boolean;
  truncate?: boolean;
  copyable?: boolean;
}) {
  const [justCopied, setJustCopied] = useState(false);
  const displayValue = shouldTruncate ? truncate(value, 24) : value;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1200);
    } catch {
      // ignore — clipboard API may be blocked in insecure contexts
    }
  };

  return (
    <div style={styles.statusRow}>
      <span style={styles.statusLabel}>{label}:</span>
      <span style={styles.statusValueGroup}>
        <span
          style={{
            ...styles.statusValue,
            ...(isError ? styles.errorText : {}),
          }}
        >
          {displayValue}
        </span>
        {copyable && (
          <button
            type="button"
            onClick={handleCopy}
            style={styles.copyButton}
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
          >
            {justCopied ? 'Copied!' : 'Copy'}
          </button>
        )}
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
  collapsibleSectionTitle: {
    fontSize: '0.8rem',
    fontWeight: 600,
    color: '#ff5500',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    cursor: 'pointer',
    userSelect: 'none',
  },
  collapsibleBody: {
    marginTop: '0.75rem',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.25rem 0',
    borderBottom: '1px solid #eee',
  },
  statusLabel: { color: '#666', fontSize: '0.85rem' },
  statusValueGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    maxWidth: '60%',
    justifyContent: 'flex-end',
  },
  statusValue: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    color: '#333',
    textAlign: 'right',
    wordBreak: 'break-all',
  },
  copyButton: {
    fontSize: '0.7rem',
    fontWeight: 600,
    color: '#ff5500',
    background: 'white',
    border: '1px solid #ff5500',
    borderRadius: '4px',
    padding: '0.15rem 0.4rem',
    cursor: 'pointer',
    flexShrink: 0,
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
  noteItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.25rem 0',
    borderBottom: '1px solid #eee',
    fontSize: '0.8rem',
    fontFamily: 'monospace',
  },
  noteId: { color: '#333' },
  noteAssets: { color: '#666', textAlign: 'right' },
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
