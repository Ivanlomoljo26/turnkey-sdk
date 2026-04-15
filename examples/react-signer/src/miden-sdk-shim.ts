// Shim around @miden-sdk/miden-sdk that patches the `AuthScheme` export so
// @miden-sdk/react@0.14.x can find `AuthScheme.AuthEcdsaK256Keccak`.
//
// Bug: @miden-sdk/miden-sdk@0.14.x's main index re-exports a string-constant
// `AuthScheme = { Falcon: "falcon", ECDSA: "ecdsa" }` that shadows the
// underlying WASM numeric enum `{ AuthEcdsaK256Keccak: 1 }`. But
// @miden-sdk/react@0.14.x's initializeSignerAccount still reads
// `AuthScheme.AuthEcdsaK256Keccak`, which evaluates to `undefined` and
// blows up inside WASM with "invalid enum value passed".
//
// This shim is referenced from vite.config.ts via a `resolve.alias` that
// redirects `@miden-sdk/miden-sdk` → this file. It re-exports everything
// from the real package (aliased as `@miden-sdk/miden-sdk-original`) and
// overrides `AuthScheme` with a patched object that carries both the
// original string aliases AND the WASM numeric values the react SDK
// expects.
//
// Remove once the Miden SDK fixes the mismatch upstream.

export * from '@miden-sdk/miden-sdk-original';

import { AuthScheme as OriginalAuthScheme } from '@miden-sdk/miden-sdk-original';

// WASM enum values for the AuthScheme tagged union, taken straight from
// miden-sdk's generated crates/miden_client_web bindings.
const WASM_AUTH_ECDSA_K256_KECCAK = 1;

export const AuthScheme = Object.freeze({
  ...(OriginalAuthScheme as Record<string, unknown>),
  AuthEcdsaK256Keccak: WASM_AUTH_ECDSA_K256_KECCAK,
});
