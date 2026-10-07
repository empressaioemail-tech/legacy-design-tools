/**
 * Starter prompts (UX review 2026-10-05, F10). Users pick these from the
 * connector in Claude; each one is a plain ask that routes to the right tool.
 */
import { z } from "zod";

type PromptServer = {
  registerPrompt: (
    name: string,
    config: { title: string; description: string; argsSchema?: Record<string, z.ZodTypeAny> },
    cb: (args: Record<string, string>) => {
      messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
    },
  ) => unknown;
};

const ask = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export const SMARTSITE_PROMPTS = [
  {
    name: "look_up_property",
    title: "Look up a property",
    description: "Zoning, land use, flood and setbacks for one Texas address, with its map card.",
    args: { address: "The property's address, for example 1301 Water St, Bastrop, TX" },
    text: (a: Record<string, string>) => `Look up ${a.address} in Smart Site.`,
  },
  {
    name: "neighbours",
    title: "What's around a property",
    description: "The nearest parcels to one property, shown as a card grid.",
    args: { address: "The property's address" },
    text: (a: Record<string, string>) => `Show me the 8 nearest parcels to ${a.address} in Smart Site.`,
  },
  {
    name: "compare_parcels",
    title: "Compare parcels",
    description: "Several properties side by side as a card grid.",
    args: { addresses: "Two or more addresses or parcel ids, separated by commas" },
    text: (a: Record<string, string>) => `Compare these in Smart Site, with full detail on each: ${a.addresses}.`,
  },
  {
    name: "my_saved_properties",
    title: "My saved properties",
    description: "The parcels you have saved in Smart Site, with their status.",
    args: {},
    text: () => "What properties have I saved in Smart Site?",
  },
] as const;

export function registerSmartsitePrompts(server: PromptServer): void {
  for (const p of SMARTSITE_PROMPTS) {
    const argsSchema = Object.fromEntries(
      Object.entries(p.args).map(([k, d]) => [k, z.string().min(1).describe(d)]),
    );
    server.registerPrompt(
      p.name,
      {
        title: p.title,
        description: p.description,
        ...(Object.keys(argsSchema).length ? { argsSchema } : {}),
      },
      (args) => ask(p.text(args)),
    );
  }
}
