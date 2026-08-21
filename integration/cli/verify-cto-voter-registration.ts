// ============================================================================
// Noctis Zone — CTO Governance: Voter Registration Verification CLI
// ============================================================================
// PHP<->Node bridge, same convention as every other CLI in this directory.
// A voter's browser submits {cardanoAddress, cip8SignatureHex, cip8KeyHex}
// to a REST endpoint (PHP, out of this repo's scope — WordPress work stays
// local); the endpoint shells out to this CLI to get a real, independently
// verified result before persisting the (cardanoAddress -> CTO voter
// pubkey) binding the balance-snapshot builder needs.
//
// Input: single JSON object on stdin. Output: single JSON object on
// stdout, exit 0 only on a genuinely verified registration — a failed
// verification is NOT modeled as a "successful check with a negative
// result" the way read-only CLIs in this directory do (e.g.
// check-cto-badge-status.ts's not_deployed), because there is no safe
// partial result here: either the signature is valid or the registration
// must be rejected outright.
// ============================================================================

import { verifyAndDeriveCtoVoterIdentity } from '../cto-voter-registration.js';
import { parseJsonStdin, readStdin, requireFieldsFalsy } from './cli-io.js';

interface VerifyRegistrationInput {
  cardanoAddress: string;
  cip8SignatureHex: string;
  cip8KeyHex: string;
  /** The launch whose ballot this registration is for — a voter's identity is
   *  scoped per launch, so the derived key differs for each. */
  launchIdHex: string;
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<VerifyRegistrationInput>(raw);

  requireFieldsFalsy(input, ['cardanoAddress', 'cip8SignatureHex', 'cip8KeyHex', 'launchIdHex']);

  const result = verifyAndDeriveCtoVoterIdentity({
    cardanoAddress: input.cardanoAddress,
    cip8SignatureHex: input.cip8SignatureHex,
    cip8KeyHex: input.cip8KeyHex,
    launchIdHex: input.launchIdHex,
  });

  process.stdout.write(JSON.stringify({ verified: true, ...result }));
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({
      verified: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exitCode = 1;
});
