// Browser stub for node:crypto — pulled in transitively via portal-ui → engine-core → @workspace/codes.
export function createHash(_algorithm: string): { update(): { digest(): string } } {
  return {
    update() {
      return { digest: () => "" };
    },
  };
}
