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
  TurnkeyProvider,
  useTurnkey,
  AuthState,
  type TurnkeyProviderConfig,
} from "@turnkey/react-wallet-kit";
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
 *  - `connect`      : failure during the `connect()` flow (handleLogin modal)
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
  /**
   * Turnkey wallet-kit provider configuration. The `auth.methods` block
   * controls which auth methods (passkey, email OTP, OAuth, ...) appear in
   * the built-in login modal opened by `connect()`.
   */
  config: TurnkeyProviderConfig;
  /** Optional custom account components to include in the account (e.g. from a compiled .masp package) */
  customComponents?: SignerAccountConfig["customComponents"];
  /** Optional account ID to import instead of creating a new account */
  importAccountId?: string;
  /**
   * If true, the provider treats an existing wallet-kit session as connected
   * on mount without showing the login modal. Default: true.
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
  onConnect?: (account: WalletAccount) => void;
  /** Called whenever the signer becomes disconnected. */
  onDisconnect?: () => void;
  /** Called whenever an error occurs. Second argument describes the lifecycle phase. */
  onError?: (error: Error, phase: TurnkeySignerErrorPhase) => void;
}

/**
 * Turnkey-specific extras exposed via useTurnkeySigner hook.
 */
export interface TurnkeySignerExtras {
  /** Connected account (null if not connected) */
  account: WalletAccount | null;
  /** All wallets visible in the current Turnkey session. */
  wallets: Wallet[];
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
   * Re-fetch wallets from Turnkey and re-select based on the configured
   * `walletSelector`/`accountSelector`.
   */
  refresh: () => Promise<void>;
}

const TurnkeySignerExtrasContext = createContext<TurnkeySignerExtras | null>(
  null,
);

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
 * Inner provider — runs inside `<TurnkeyProvider>` and bridges wallet-kit
 * state into the Miden `SignerContext`.
 */
function TurnkeySignerProviderInner({
  children,
  customComponents,
  importAccountId,
  autoConnect,
  walletSelector,
  accountSelector,
  onConnect,
  onDisconnect,
  onError,
}: Omit<TurnkeySignerProviderProps, "config">) {
  const {
    httpClient,
    session,
    wallets,
    authState,
    handleLogin,
    refreshWallets,
    logout,
  } = useTurnkey();

  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [status, setStatus] = useState<TurnkeySignerStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

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

  /** Pick wallet + account from the wallet-kit `wallets` array. */
  const pickAccount = useCallback((): WalletAccount => {
    const chosenWallet = resolveWallet(wallets as Wallet[], walletSelector);
    return resolveAccount(
      chosenWallet.accounts as WalletAccount[],
      accountSelector,
    );
  }, [wallets, walletSelector, accountSelector]);

  // React to wallet-kit auth state transitions.
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    const isAuthed = authState === AuthState.Authenticated;

    if (!isAuthed) {
      if (wasConnectedRef.current) {
        wasConnectedRef.current = false;
        setAccount(null);
        setStatus("idle");
        setError(null);
        onDisconnectRef.current?.();
      }
      return;
    }

    if (!wallets.length) return;

    try {
      const acct = pickAccount();
      setAccount(acct);
      setStatus("connected");
      setError(null);
      if (!wasConnectedRef.current) {
        wasConnectedRef.current = true;
        onConnectRef.current?.(acct);
      }
    } catch (e) {
      reportError(e, "buildContext");
    }
  }, [authState, wallets, pickAccount, reportError]);

  const connect = useCallback(async () => {
    if (authState === AuthState.Authenticated) return;
    setStatus("connecting");
    setError(null);
    try {
      await handleLogin();
    } catch (e) {
      reportError(e, "connect");
      throw e;
    }
  }, [authState, handleLogin, reportError]);

  const disconnect = useCallback(async () => {
    try {
      await logout();
    } catch (e) {
      reportError(e, "connect");
      throw e;
    }
  }, [logout, reportError]);

  const refresh = useCallback(async () => {
    try {
      await refreshWallets();
      const acct = pickAccount();
      setAccount(acct);
      setStatus("connected");
    } catch (e) {
      reportError(e, "buildContext");
      throw e;
    }
  }, [refreshWallets, pickAccount, reportError]);

  const signRaw = useCallback(
    async (messageHex: string): Promise<TurnkeyRawSignature> => {
      if (!httpClient || !account) {
        throw new Error("Turnkey wallet not connected");
      }
      // Use the raw httpClient instead of handleSignMessage so signing
      // happens without opening a confirmation modal — Miden transactions
      // call signCb many times per flow.
      const result = await httpClient.signRawPayload({
        signWith: account.address,
        payload: messageHex,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_KECCAK256",
      });
      return result as TurnkeyRawSignature;
    },
    [httpClient, account],
  );

  const signMessage = useCallback(
    async (messageHex: string): Promise<TurnkeyRawSignature> => {
      try {
        return await signRaw(messageHex);
      } catch (e) {
        reportError(e, "sign");
        throw e;
      }
    },
    [signRaw, reportError],
  );

  // Build signer context for MidenProvider
  const [signerContext, setSignerContext] = useState<SignerContextValue | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const isAuthed = authState === AuthState.Authenticated;

    async function buildContext() {
      if (!isAuthed || !account) {
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
        const compressedPublicKey = account.publicKey;
        if (!compressedPublicKey) {
          throw new Error("Account has no public key");
        }

        const commitment = await evmPkToCommitment(compressedPublicKey);
        const commitmentBytes = commitment.serialize();

        const signCb = async (_: Uint8Array, signingInputs: Uint8Array) => {
          try {
            const { SigningInputs } = await import("@miden-sdk/miden-sdk");
            const inputs = SigningInputs.deserialize(signingInputs);
            const messageHex = inputs.toCommitment().toHex();
            const sig = await signRaw(messageHex);
            return fromTurnkeySig(sig);
          } catch (e) {
            reportError(e, "sign");
            throw e;
          }
        };

        if (cancelled) return;

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
      } catch (e) {
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
    authState,
    account,
    signRaw,
    connect,
    disconnect,
    importAccountId,
    customComponents,
    reportError,
  ]);

  const extrasValue = useMemo<TurnkeySignerExtras>(
    () => ({
      account,
      wallets: wallets as Wallet[],
      status,
      error,
      signMessage,
      refresh,
    }),
    [account, wallets, status, error, signMessage, refresh],
  );

  // wallet-kit restores persisted sessions on mount. Setting autoConnect=false
  // signals the app wants to start logged out, so the first time we observe an
  // authenticated session under that flag we tear it down.
  const didInitialAutoConnectCheckRef = useRef(false);
  useEffect(() => {
    if (autoConnect !== false) return;
    if (didInitialAutoConnectCheckRef.current) return;
    if (authState !== AuthState.Authenticated) return;
    didInitialAutoConnectCheckRef.current = true;
    logout().catch((e) => reportError(e, "autoConnect"));
  }, [autoConnect, authState, logout, reportError]);

  return (
    <TurnkeySignerExtrasContext.Provider value={extrasValue}>
      <SignerContext.Provider value={signerContext}>
        {children}
      </SignerContext.Provider>
    </TurnkeySignerExtrasContext.Provider>
  );
}

/**
 * TurnkeySignerProvider wraps Turnkey's React wallet kit and exposes a Miden
 * `SignerContext`, so `useSigner()` and `useTurnkeySigner()` work side-by-side
 * with the rest of the Miden React SDK.
 *
 * `connect()` opens the built-in wallet-kit login modal, which displays every
 * auth method (passkey, email OTP, OAuth, ...) enabled in your Turnkey org.
 *
 * @example
 * ```tsx
 * <TurnkeySignerProvider
 *   config={{
 *     organizationId: "your-org-id",
 *     auth: { methods: { passkeyAuthEnabled: true, emailOtpAuthEnabled: true } },
 *   }}
 *   onConnect={(acc) => console.log("connected:", acc.address)}
 * >
 *   <MidenProvider config={{ rpcUrl: "testnet" }}>
 *     <App />
 *   </MidenProvider>
 * </TurnkeySignerProvider>
 * ```
 */
export function TurnkeySignerProvider({
  children,
  config,
  ...inner
}: TurnkeySignerProviderProps) {
  return (
    <TurnkeyProvider config={config}>
      <TurnkeySignerProviderInner {...inner}>
        {children}
      </TurnkeySignerProviderInner>
    </TurnkeyProvider>
  );
}

/**
 * Hook for Turnkey-specific extras beyond the unified useSigner interface.
 * Use this to access the connected account, all wallets, status/error,
 * sign arbitrary messages, or force a refresh of wallet/account data.
 *
 * @example
 * ```tsx
 * const { account, wallets, status, error, signMessage, refresh, isConnected } =
 *   useTurnkeySigner();
 * ```
 */
export function useTurnkeySigner(): TurnkeySignerExtras & {
  isConnected: boolean;
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
