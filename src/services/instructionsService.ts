import { PublicKey, TransactionInstruction, SystemProgram, AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "bn.js";

const DFLOW_PROGRAM_ID = new PublicKey("DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH");
const EVENT_AUTHORITY = new PublicKey("8xeaWCsJYxRoudEZGJWURdfrtFhLYZz9b4iHJnW5tb3d");
const SWAP2_DISCRIMINATOR = Uint8Array.from([65, 75, 63, 76, 235, 91, 91, 136]);

export const InstructionsService = {
  buildDFlowSwap2Instruction(userAuthority: PublicKey, fromMint: PublicKey, toMint: PublicKey, inAmount: bigint, outAmount: bigint) {
    const slippage_bps = 300;
    const platform_fee_bps = 0;
    const positive_slippage_fee_limit_pct = 1;

    const data = Buffer.concat([
      Buffer.from(SWAP2_DISCRIMINATOR),
      Buffer.from(new Uint32Array([0]).buffer),
      Buffer.from(new BN(outAmount).toArray("le", 8)),
      Buffer.from(new Uint16Array([slippage_bps]).buffer),
      Buffer.from(new Uint16Array([platform_fee_bps]).buffer),
      Buffer.from(new Uint8Array([positive_slippage_fee_limit_pct])),
    ]);

    const keys: AccountMeta[] = [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: userAuthority, isSigner: true, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DFLOW_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({ programId: DFLOW_PROGRAM_ID, keys, data });
  },

  async buildRaydiumCpmmswapInstruction(params: {
    userAuthority: PublicKey;
    poolId: PublicKey;
    ammConfig: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountIn: bigint;
    minOut: bigint;
  }) {
    // (copy-paste logika raydium milikmu di sini)
  },
};
