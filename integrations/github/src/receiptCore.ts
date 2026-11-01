/**
 * Confirmation receipts — the proof that a write was approved on its card.
 *
 * VoiceOS renders a write tool's confirmation card before any integration code
 * runs, and gives the integration no signal that the card was shown: a user
 * who turns off "Ask before every action" gets the tool call with no card at
 * all. So each write's confirmation widget computes a digest of the exact
 * arguments the user is approving and stages it into the call as
 * `confirmation_receipt`. The handler recomputes it and refuses to dispatch
 * without a valid, fresh, unused receipt.
 *
 * One file, src/receiptCoreScript.ts, runs in two places: its exact text is
 * inlined into the widget's <script> at build time, and the server imports it
 * as code, so the canonical form can never drift between what the card signed
 * and what the server checks. Nothing is compiled from a string at runtime
 * (VoiceOS's share review rejects that). It is deliberately ES5 with no
 * dependencies: the widget sandbox has no modules and no guaranteed WebCrypto.
 */
import GHR from "./receiptCoreScript.ts";


export type ReceiptCheck =
  | { ok: true; nonce: string; issuedAt: number }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export interface ReceiptCore {
  utf8(text: string): number[];
  sha256(bytes: ArrayLike<number>): number[];
  hex(bytes: ArrayLike<number>): string;
  normText(value: unknown): string;
  normBody(value: unknown): string;
  normNum(value: unknown): string;
  normList(value: unknown): string[];
  canonical(tool: string, args: Record<string, unknown>): string;
  mint(tool: string, args: Record<string, unknown>, nowMs: number, nonceHex: string): string;
  verify(
    tool: string,
    args: Record<string, unknown>,
    token: unknown,
    nowMs: number,
    ttlMs: number,
  ): ReceiptCheck & { reason?: string };
}

export const receiptCore = GHR as ReceiptCore;
