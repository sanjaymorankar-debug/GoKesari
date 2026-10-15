/** A GSTIN with a correct check digit for state `state` and a 10-character PAN-like body. */
export function gstin(state: string, body: string): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const g = `${state}${body}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = chars.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return g + chars[(36 - (sum % 36)) % 36];
}
