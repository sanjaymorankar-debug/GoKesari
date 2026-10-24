/** Escapes LIKE wildcards so "50%" or "a_b" match literally (TC-DISC-007: "%" used to match every product). */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
