/**
 * Render a compiled predicate program in plain words — what the wallet shows
 * at the moment of consent, so "what will this proof reveal?" is answered by
 * the actual on-chain program, not by trusting the requesting page's copy.
 */
import { CompiledProgram, OP, SCHEMA_V1, TOKEN } from "./actaSdk";
import { decodeClaim } from "./vc";

export function describeProgram(program: CompiledProgram): string {
  const opWord = (op: bigint) => (op === BigInt(OP.LE) ? "≤" : op === BigInt(OP.GE) ? "≥" : "=");
  const predWords = program.predicates.map(p => {
    const slot = SCHEMA_V1[Number(p.claimRef)];
    return `${slot.name} ${opWord(p.op)} ${decodeClaim(p.compareValue, slot.format)}`;
  });
  // The program is postfix; walk it with a string stack to recover infix.
  const stack: string[] = [];
  for (const t of program.tokens) {
    if (t.type === BigInt(TOKEN.REF)) stack.push(predWords[Number(t.arg)]);
    else if (t.type === BigInt(TOKEN.AND) || t.type === BigInt(TOKEN.OR)) {
      const b = stack.pop();
      const a = stack.pop();
      stack.push(`(${a} ${t.type === BigInt(TOKEN.AND) ? "AND" : "OR"} ${b})`);
    } else if (t.type === BigInt(TOKEN.NOT)) stack.push(`NOT ${stack.pop()}`);
    // PAD: no-op
  }
  const out = stack.pop() ?? "(empty program)";
  return out.startsWith("(") && out.endsWith(")") ? out.slice(1, -1) : out;
}
