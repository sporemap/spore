// Spore's published launch policy, pinned in the bundle. The API also states it (/api/eligibility),
// but nothing the server says is allowed to move money: the fee split and the launch fee are
// derived here and the server's copy only has to agree, otherwise the launch refuses to build.
// Pre-deploy security review 2026-10-18, finding #1.
import { PublicKey } from "@solana/web3.js";

/// The platform wallet: fee-split shareholder and launch-fee recipient (DESIGN §11).
export const PLATFORM_WALLET = new PublicKey("FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5");
/// The most the launch transaction may transfer to the platform (0.02 SOL). The server may lower it.
export const MAX_LAUNCH_FEE_LAMPORTS = 20_000_000n;
/// Creator fee split in bps: child creator, parent creator, grandparent creator, platform.
export const SPLIT_BPS = [5000, 0, 0, 5000] as const;

export class PolicyError extends Error {
  constructor(message: string) { super(message); this.name = "PolicyError"; }
}

/// The platform coin ($SPORE, launched by the owner on Spore 2026-10-19): the platform's fee share buys and locks it.
export const SPORE_COIN = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
