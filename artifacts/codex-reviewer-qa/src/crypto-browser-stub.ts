// Browser stub for node:crypto — pulled in transitively via portal-ui → engine-core → @empressaio/atom-contract.
export function createHash(_algorithm: string): { update(): { digest(): string } } {
  return {
    update() {
      return { digest: () => "" };
    },
  };
}

export function randomBytes(_size: number): Uint8Array {
  return new Uint8Array(_size);
}
