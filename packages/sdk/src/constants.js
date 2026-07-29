// ACTA v1 normative constants.
// Any change to CIRCUIT_PARAMS or the encodings in encoding.js is a breaking
// change to predicateProgramHash: bump VERSION and re-derive every policy hash.

/** BN254 scalar field modulus (the SNARK field). */
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const VERSION = 1n;

/** Fixed circuit shape. Baked into predicateProgramHash via packParams(). */
export const CIRCUIT_PARAMS = {
  nClaims: 8,
  maxPredicates: 4,
  maxLogicTokens: 16,
  valueBits: 64,
  anchorTreeDepth: 16,
  sanctionsTreeDepth: 32,
};

/** Predicate comparison operators (1/OPENAC normative codes). */
export const OP = { LE: 0, GE: 1, EQ: 2 };

/** Postfix logic token types. REF/AND/OR/NOT are 1/OPENAC; PAD fills unused slots. */
export const TOKEN = { REF: 0, AND: 1, OR: 2, NOT: 3, PAD: 4 };

/** Claim format tags (1/OPENAC normative codes). */
export const FORMAT = { BOOL: 0, UINT: 1, ISO_DATE: 2, ROC_DATE: 3, STRING: 4 };

/**
 * AgentCapabilityCredential v1 claim schema: fixed slot layout.
 * Unused slots MUST be 0 with format UINT.
 */
export const SCHEMA_V1 = [
  { name: 'auditScore', format: FORMAT.UINT },
  { name: 'jurisdiction', format: FORMAT.STRING },
  { name: 'capabilities', format: FORMAT.UINT },
  { name: 'validUntil', format: FORMAT.UINT },
  { name: 'reserved4', format: FORMAT.UINT },
  { name: 'reserved5', format: FORMAT.UINT },
  { name: 'reserved6', format: FORMAT.UINT },
  { name: 'reserved7', format: FORMAT.UINT },
];
