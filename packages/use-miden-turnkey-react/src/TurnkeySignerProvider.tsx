import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import {
  Turnkey,
  type TurnkeySDKBrowserConfig,
  SessionType,
} from "@turnkey/sdk-browser";
import type { TurnkeyBrowserClient } from "@turnkey/sdk-browser";
import type { WalletAccount, Wallet } from "@turnkey/core";
import {
  SignerContext,
  type SignerContextValue,
  type SignerAccountConfig,
} from "@miden-sdk/react";
import { evmPkToCommitment, fromTurnkeySig } from "@miden-sdk/miden-turnkey";

// TURNKEY SIGNER PROVIDER
// ================================================================================================

/** Signature returned by Turnkey's signRawPayload API. */
export interface TurnkeyRawSignature {
  r: string;
  s: string;
  v: string;
}

/** High-level status of the Turnkey signer. */
export type TurnkeySignerStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

/**
 * Phase of an error reported via `onError`.
 *  - `connect`      : failure during the `connect()` flow (passkey login, wallet fetch)
 *  - `autoConnect`  : failure during automatic connection on mount
 *  - `buildContext` : failure while preparing the signer context (public-key commitment, etc.)
 *  - `sign`         : failure during a signing operation
 */
export type TurnkeySignerErrorPhase =
  | "connect"
  | "autoConnect"
  | "buildContext"
  | "sign";

/**
 * Selector used to pick a specific wallet from the list returned by Turnkey.
 * Either a wallet name, a zero-based index, or a custom predicate.
 */
export type WalletSelector =
  | string
  | number
  | ((wallets: Wallet[]) => Wallet | undefined);

/**
 * Selector used to pick a specific account from a chosen wallet.
 * Either an address, a zero-based index, or a custom predicate.
 */
export type AccountSelector =
  | string
  | number
  | ((accounts: WalletAccount[]) => WalletAccount | undefined);

export interface TurnkeySignerProviderProps {
  children: ReactNode;
  /** Turnkey SDK browser configuration (defaultOrganizationId is required; apiBaseUrl defaults to https://api.turnkey.com) */
  config: Pick<TurnkeySDKBrowserConfig, "defaultOrganizationId"> &
    Partial<Omit<TurnkeySDKBrowserConfig, "defaultOrganizationId">>;
  /** Optional custom account components to include in the account (e.g. from a compiled .masp package) */
  customComponents?: SignerAccountConfig["customComponents"];
  /** Optional account ID to import instead of creating a new account */
  importAccountId?: string;
  /**
   * If true, the provider attempts to connect automatically on mount when a
   * valid Turnkey session already exists (no passkey prompt). Default: false.
   */
  autoConnect?: boolean;
  /** Pick which wallet to use if the user has multiple. Defaults to the first. */
  walletSelector?: WalletSelector;
  /**
   * Pick which account to use from the selected wallet. Defaults to the first
   * account whose addressFormat is `ADDRESS_FORMAT_ETHEREUM`, else the first account.
   */
  accountSelector?: AccountSelector;
  /** Called whenever the signer becomes connected. */
  onConnect?: (account: WalletAccount, client: TurnkeyBrowserClient) => void;
  /** Called whenever the signer becomes disconnected. */
  onDisconnect?: () => void;
  /** Called whenever an error occurs. Second argument describes the lifecycle phase. */
  onError?: (error: Error, phase: TurnkeySignerErrorPhase) => void;
}

/**
 * Turnkey-specific extras exposed via useTurnkeySigner hook.
 */
export interface TurnkeySignerExtras {
  /** Turnkey browser client instance (null if not yet connected) */
  client: TurnkeyBrowserClient | null;
  /** Connected account (null if not connected) */
  account: WalletAccount | null;
  /** High-level signer status */
  status: TurnkeySignerStatus;
  /** Last error surfaced by the provider (cleared on successful connect). */
  error: Error | null;
  /**
   * Sign an arbitrary hex payload using the connected account.
   * Returns the raw Turnkey `{r,s,v}` signature.
   * Throws if called before connection.
   */
  signMessage: (messageHex: string) => Promise<TurnkeyRawSignature>;
  /**
   * Re-fetch wallets/accounts from Turnkey and re-select based on the
   * configured `walletSelector`/`accountSelector`.
   */
  refresh: () => Promise<void>;
}

interface TurnkeySignerExtrasInternal extends TurnkeySignerExtras {
  setAccount: (account: WalletAccount | null) => void;
}

const TurnkeySignerExtrasContext =
  createContext<TurnkeySignerExtrasInternal | null>(null);

/**
 * Signs a message using Turnkey's signRawPayload API.
 */
async function signWithTurnkey(
  messageHex: string,
  client: TurnkeyBrowserClient,
  account: WalletAccount,
): Promise<TurnkeyRawSignature> {
  const result = await client.signRawPayload({
    signWith: account.address,
    payload: messageHex,
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_KECCAK256",
  });
  return result;
}

function resolveWallet(wallets: Wallet[], selector?: WalletSelector): Wallet {
  if (!wallets.length) throw new Error("No wallets found");
  if (selector == null) return wallets[0];
  if (typeof selector === "function") {
    const picked = selector(wallets);
    if (!picked) throw new Error("walletSelector returned no wallet");
    return picked;
  }
  if (typeof selector === "number") {
    const w = wallets[selector];
    if (!w) throw new Error(`Wallet index ${selector} out of range`);
    return w;
  }
  const byName = wallets.find((w) => w.walletName === selector);
  if (!byName) throw new Error(`No wallet named "${selector}"`);
  return byName;
}

function resolveAccount(
  accounts: WalletAccount[],
  selector?: AccountSelector,
): WalletAccount {
  if (!accounts.length) throw new Error("No accounts found");
  if (selector == null) {
    return (
      (accounts.find(
        (a) => a.addressFormat === "ADDRESS_FORMAT_ETHEREUM",
      ) as WalletAccount | undefined) ?? (accounts[0] as WalletAccount)
    );
  }
  if (typeof selector === "function") {
    const picked = selector(accounts);
    if (!picked) throw new Error("accountSelector returned no account");
    return picked;
  }
  if (typeof selector === "number") {
    const a = accounts[selector];
    if (!a) throw new Error(`Account index ${selector} out of range`);
    return a;
  }
  const byAddr = accounts.find((a) => a.address === selector);
  if (!byAddr) throw new Error(`No account with address "${selector}"`);
  return byAddr;
}

/**
 * TurnkeySignerProvider wraps MidenProvider to enable Turnkey wallet signing.
 * Constructs a TurnkeyBrowserClient internally from the provided config.
 *
 * @example
 * ```tsx
 * <TurnkeySignerProvider
 *   config={{ defaultOrganizationId: "your-org-id" }}
 *   autoConnect
 *   onConnect={(acc) => console.log("connected:", acc.address)}
 * >
 *   <MidenProvider config={{ rpcUrl: "testnet" }}>
 *     <App />
 *   </MidenProvider>
 * </TurnkeySignerProvider>
 * ```
 */
const TURNKEY_DEFAULTS = {
  apiBaseUrl: "https://api.turnkey.com",
};

export function TurnkeySignerProvider({
  children,
  config,
  customComponents,
  importAccountId,
  autoConnect = false,
  walletSelector,
  accountSelector,
  onConnect,
  onDisconnect,
  onError,
}: TurnkeySignerProviderProps) {
  const resolvedConfig: TurnkeySDKBrowserConfig = {
    ...TURNKEY_DEFAULTS,
    ...config,
  };

  const turnkey = useMemo(
    () => new Turnkey(resolvedConfig),
    [resolvedConfig.apiBaseUrl, resolvedConfig.defaultOrganizationId],
  );

  const [client, setClient] = useState<TurnkeyBrowserClient | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<TurnkeySignerStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  // Keep latest callback refs so connect/disconnect identity is stable.
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [onConnect, onDisconnect, onError]);

  const reportError = useCallback(
    (e: unknown, phase: TurnkeySignerErrorPhase) => {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setStatus("error");
      onErrorRef.current?.(err, phase);
    },
    [],
  );

  /** Shared flow: fetch wallets using an already-authenticated client and select the account. */
  const pickAccountFromClient = useCallback(
    async (
      indexedDbClient: TurnkeyBrowserClient,
    ): Promise<WalletAccount> => {
      const { wallets } = await indexedDbClient.getWallets();
      const chosenWallet = resolveWallet(wallets as Wallet[], walletSelector);
      const { accounts } = await indexedDbClient.getWalletAccounts({
        walletId: chosenWallet.walletId,
      });
      return resolveAccount(accounts as WalletAccount[], accountSelector);
    },
    [walletSelector, accountSelector],
  );

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      // 1. Create IndexedDB client and initialize its keypair
      const indexedDbClient = await turnkey.indexedDbClient();
      await indexedDbClient.init();

      // 2. Only login if no existing session
      const existingSession = await turnkey.getSession();
      if (!existingSession) {
        const passkeyClient = turnkey.passkeyClient();
        await passkeyClient.loginWithPasskey({
          sessionType: SessionType.READ_WRITE,
          publicKey: (await indexedDbClient.getPublicKey())!,
        });
      }

      // 3. Pick wallet + account via configured selectors
      const acct = await pickAccountFromClient(indexedDbClient);

      // 4. Set connected
      setClient(indexedDbClient);
      setAccount(acct);
      setIsConnected(true);
      setStatus("connected");
      onConnectRef.current?.(acct, indexedDbClient);
    } catch (e) {
      reportError(e, "connect");
      throw e;
    }
  }, [turnkey, pickAccountFromClient, reportError]);

  const disconnect = useCallback(async () => {
    setAccount(null);
    setIsConnected(false);
    setStatus("idle");
    setError(null);
    onDisconnectRef.current?.();
  }, []);

  // Allow external setting of account (for apps that handle auth themselves)
  const setConnectedAccount = useCallback((acc: WalletAccount | null) => {
    setAccount(acc);
    setIsConnected(acc !== null);
    setStatus(acc !== null ? "connected" : "idle");
    if (acc !== null) setError(null);
  }, []);

  // Auto-connect on mount if requested AND a session already exists
  // (we don't want to silently trigger a passkey prompt).
  useEffect(() => {
    if (!autoConnect) return;
    let cancelled = false;
    (async () => {
      try {
        const existing = await turnkey.getSession();
        if (!existing || cancelled) return;
        const idb = await turnkey.indexedDbClient();
        await idb.init();
        const acct = await pickAccountFromClient(idb);
        if (cancelled) return;
        setClient(idb);
        setAccount(acct);
        setIsConnected(true);
        setStatus("connected");
        onConnectRef.current?.(acct, idb);
      } catch (e) {
        if (!cancelled) reportError(e, "autoConnect");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoConnect, turnkey, pickAccountFromClient, reportError]);

  const refresh = useCallback(async () => {
    if (!client) throw new Error("Cannot refresh: Turnkey client not connected");
    try {
      const acct = await pickAccountFromClient(client);
      setAccount(acct);
      setIsConnected(true);
      setStatus("connected");
    } catch (e) {
      reportError(e, "buildContext");
      throw e;
    }
  }, [client, pickAccountFromClient, reportError]);

  const signMessage = useCallback(
    async (messageHex: string): Promise<TurnkeyRawSignature> => {
      if (!client || !account) {
        throw new Error("Turnkey wallet not connected");
      }
      try {
        return await signWithTurnkey(messageHex, client, account);
      } catch (e) {
        reportError(e, "sign");
        throw e;
      }
    },
    [client, account, reportError],
  );

  // Build signer context
  const [signerContext, setSignerContext] = useState<SignerContextValue | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    async function buildContext() {
      if (!isConnected || !account) {
        // Not connected - provide context with connect/disconnect but no signing capability
        setSignerContext({
          signCb: async () => {
            throw new Error("Turnkey wallet not connected");
          },
          accountConfig: null as any,
          storeName: "",
          name: "Turnkey",
          isConnected: false,
          connect,
          disconnect,
        });
        return;
      }

      try {
        // Connected - build full context with signing capability
        const compressedPublicKey = account.publicKey;
        if (!compressedPublicKey) {
          throw new Error("Account has no public key");
        }

        const commitment = await evmPkToCommitment(compressedPublicKey);
        const commitmentBytes = commitment.serialize();

        const signCb = async (_: Uint8Array, signingInputs: Uint8Array) => {
          if (!client) throw new Error("Turnkey client not available");
          try {
            const { SigningInputs } = await import("@miden-sdk/miden-sdk");
            const inputs = SigningInputs.deserialize(signingInputs);
            const messageHex = inputs.toCommitment().toHex();

            const sig = await signWithTurnkey(messageHex, client, account);
            return fromTurnkeySig(sig);
          } catch (e) {
            reportError(e, "sign");
            throw e;
          }
        };

        if (!cancelled) {
          const { AccountStorageMode } = await import("@miden-sdk/miden-sdk");

          setSignerContext({
            signCb,
            accountConfig: {
              publicKeyCommitment: commitmentBytes,
              accountType: "RegularAccountImmutableCode",
              storageMode: AccountStorageMode.public(),
              ...(customComponents?.length ? { customComponents } : {}),
              ...(importAccountId ? { importAccountId } : {}),
            },
            storeName: `turnkey_${account.address}`,
            name: "Turnkey",
            isConnected: true,
            connect,
            disconnect,
          });
        }
      } catch (e) {
        console.error("Failed to build Turnkey signer context:", e);
        if (!cancelled) {
          reportError(e, "buildContext");
          setSignerContext({
            signCb: async () => {
              throw new Error("Turnkey wallet not connected");
            },
            accountConfig: null as any,
            storeName: "",
            name: "Turnkey",
            isConnected: false,
            connect,
            disconnect,
          });
        }
      }
    }

    buildContext();
    return () => {
      cancelled = true;
    };
  }, [
    isConnected,
    account,
    client,
    connect,
    disconnect,
    importAccountId,
    customComponents,
    reportError,
  ]);

  // Extended extras context with setAccount
  const extrasValue = useMemo<TurnkeySignerExtrasInternal>(
    () => ({
      client,
      account,
      status,
      error,
      signMessage,
      refresh,
      setAccount: setConnectedAccount,
    }),
    [
      client,
      account,
      status,
      error,
      signMessage,
      refresh,
      setConnectedAccount,
    ],
  );

  return (
    <TurnkeySignerExtrasContext.Provider value={extrasValue}>
      <SignerContext.Provider value={signerContext}>
        {children}
      </SignerContext.Provider>
    </TurnkeySignerExtrasContext.Provider>
  );
}

/**
 * Hook for Turnkey-specific extras beyond the unified useSigner interface.
 * Use this to access the Turnkey client, set the account, inspect status/errors,
 * sign arbitrary messages, or force a refresh of wallet/account data.
 *
 * @example
 * ```tsx
 * const { client, account, status, error, signMessage, refresh, setAccount, isConnected } =
 *   useTurnkeySigner();
 *
 * // After Turnkey auth flow completes:
 * setAccount(walletAccount);
 * ```
 */
export function useTurnkeySigner(): TurnkeySignerExtras & {
  isConnected: boolean;
  setAccount: (account: WalletAccount | null) => void;
} {
  const extras = useContext(TurnkeySignerExtrasContext);
  const signer = useContext(SignerContext);
  if (!extras) {
    throw new Error(
      "useTurnkeySigner must be used within TurnkeySignerProvider",
    );
  }
  return { ...extras, isConnected: signer?.isConnected ?? false };
}
