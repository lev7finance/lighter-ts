/**
 * The injection seam for Ethereum `personal_sign`. Types and documentation only — this module has
 * no runtime content and this package ships no L1 curve or digest code at all
 * (`docs/decisions.md` D6, D10).
 *
 * The reasoning is worth restating because it looks like a gap: the consuming application already
 * holds its L1 keys in a wallet or custody layer and already has a signing library. Reimplementing
 * that here would mean shipping several hundred lines of unvalidated cryptography for a signature
 * this package cannot produce anyway, since it never sees the key. What it *can* own — and what is
 * genuinely hard to get right — is the exact message string, which is pinned byte for byte in
 * `conformance/vectors/tx.json` → `l1Messages`.
 *
 * So: build the message here, sign it there.
 */

/**
 * Anything that can produce an EIP-191 `personal_sign` signature over a UTF-8 string.
 *
 * Implementations sign `"\x19Ethereum Signed Message:\n" ‖ decimal(byteLength) ‖ text` — the
 * framing {@link eip191Message} builds — and return the 65-byte result as `0x` + 130 lowercase hex
 * digits, `r(32) ‖ s(32) ‖ v` with `v ∈ {27, 28}`.
 *
 * Satisfied by a wallet client, a browser provider, a hardware wallet, a KMS, or a platform binding.
 * Two adapters, neither of which adds a dependency to this package:
 *
 * **A wallet client whose `signMessage` takes an options object** (this is the shape viem uses —
 * the seam is *not* satisfied verbatim by it, which is exactly why the adapter is written out):
 *
 * ```ts
 * // `walletClient` and `account` are created by the application, not by this package.
 * const l1Signer: EthPersonalSigner = {
 *   signMessage: (message: string) => walletClient.signMessage({ account, message }),
 *   getAddress: async () => account.address,
 * };
 * ```
 *
 * **An EIP-1193 provider**, where the message must be passed as UTF-8 hex and the argument order is
 * `[message, address]`:
 *
 * ```ts
 * const l1Signer: EthPersonalSigner = {
 *   signMessage: (message: string) =>
 *     provider.request({
 *       method: "personal_sign",
 *       params: [`0x${bytesToHex(utf8ToBytes(message))}`, address],
 *     }) as Promise<`0x${string}`>,
 *   getAddress: async () => address,
 * };
 * ```
 *
 * A library whose `signMessage` already takes a bare string — ethers' `Signer`, for instance —
 * satisfies this interface as it stands.
 */
export interface EthPersonalSigner {
  /**
   * Sign `message` with EIP-191 `personal_sign`.
   *
   * @param message The exact message body built by this package. Sign it verbatim: any
   * normalisation, trimming or re-encoding changes what was signed.
   * @returns `0x` + 130 hex digits — `r ‖ s ‖ v`, with `v ∈ {27, 28}`.
   */
  signMessage(message: string): Promise<`0x${string}`>;

  /**
   * The address that {@link EthPersonalSigner.signMessage} signs with, if the implementation knows
   * it.
   *
   * Optional, and used only by caller-side sanity checks — nothing in this package recovers an
   * address from a signature, so nothing here can verify that the two agree.
   */
  getAddress?(): Promise<`0x${string}`>;
}
