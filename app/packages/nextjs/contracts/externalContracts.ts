import { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

/**
 * External contracts (non-yarn-deploy). ACTA contracts are deployed via
 * `yarn deploy` and land in deployedContracts.ts automatically.
 */
const externalContracts = {} as const;

export default externalContracts satisfies GenericContractsDeclaration;
