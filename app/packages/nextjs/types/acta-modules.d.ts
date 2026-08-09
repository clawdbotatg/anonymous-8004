// Untyped ZK deps used by the ACTA demo.
declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: unknown,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;
  };
}

declare module "circomlibjs" {
  export function newMemEmptyTrie(): Promise<{
    F: { toObject(v: unknown): bigint };
    root: unknown;
    insert(key: bigint, value: bigint): Promise<unknown>;
    find(key: bigint): Promise<{
      found: boolean;
      siblings: unknown[];
      isOld0: boolean;
      notFoundKey?: unknown;
      notFoundValue?: unknown;
    }>;
  }>;
}
