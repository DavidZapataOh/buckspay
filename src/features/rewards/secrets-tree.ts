import { fromCanonical, poseidon2, toBytes32 } from './secrets-poseidon'

export const TREE_DEPTH = 20

const zeros: bigint[] = [0n]
for (let level = 0; level < TREE_DEPTH; level++) zeros.push(poseidon2(zeros[level], zeros[level]))

export type MerklePath = { index: number; siblings: Uint8Array[]; root: Uint8Array }

/** `leaf = Poseidon(inner, exp)`, the leaf the program appends for a word batch. */
export function leafOf(inner: Uint8Array, exp: number): Uint8Array {
  return toBytes32(poseidon2(fromCanonical(inner, 'inner'), BigInt(exp)))
}

/** Hashes one level of the tree: the nodes at `level` become their parents, the last one paired with an empty subtree. */
function up(nodes: bigint[], level: number): bigint[] {
  const parents: bigint[] = []
  for (let i = 0; i < nodes.length; i += 2)
    parents.push(poseidon2(nodes[i], i + 1 < nodes.length ? nodes[i + 1] : zeros[level]))
  return parents
}

/**
 * The root of the depth-20 tree that holds `leaves` from index 0 and empty subtrees after them, and the siblings of
 * the leaf at `index` from the leaf up.
 */
export function merklePath(leaves: readonly Uint8Array[], index: number): MerklePath {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error('The leaf is not in this tree')
  if (leaves.length > 2 ** TREE_DEPTH) throw new Error('The tree holds more leaves than its depth allows')
  let nodes = leaves.map((leaf) => fromCanonical(leaf, 'leaf'))
  const siblings: Uint8Array[] = []
  let at = index
  for (let level = 0; level < TREE_DEPTH; level++) {
    const sibling = at ^ 1
    siblings.push(toBytes32(sibling < nodes.length ? nodes[sibling] : zeros[level]))
    nodes = up(nodes, level)
    at >>= 1
  }
  return { index, siblings, root: toBytes32(nodes[0]) }
}

export const emptyRoot = () => toBytes32(zeros[TREE_DEPTH])
