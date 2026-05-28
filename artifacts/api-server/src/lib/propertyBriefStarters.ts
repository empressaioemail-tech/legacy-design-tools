/**
 * Canonical deep-research starter prompts for Property Brief (Hauska).
 * Extension UI maps these IDs to clickable starter chips on the first screen.
 */

export const PERSONA_BUCKETS = [
  "owner_buyer",
  "family",
  "investor",
  "agent_helper",
] as const;

export type PersonaBucket = (typeof PERSONA_BUCKETS)[number];

export const STARTER_PROMPT_IDS = [
  "adu",
  "flood",
  "schools",
  "str",
  "setbacks",
  "red_flags",
] as const;

export type StarterPromptId = (typeof STARTER_PROMPT_IDS)[number];

export interface PropertyBriefStarterPrompt {
  id: StarterPromptId;
  label: string;
  question: string;
  personaBuckets: PersonaBucket[];
}

/** Six canonical starter prompts for deep research first screen. */
export const PROPERTY_BRIEF_STARTER_PROMPTS: Record<
  StarterPromptId,
  PropertyBriefStarterPrompt
> = {
  adu: {
    id: "adu",
    label: "ADU / guest house",
    question: "Could the owner add an ADU or guest house on this lot?",
    personaBuckets: ["owner_buyer", "family", "investor", "agent_helper"],
  },
  flood: {
    id: "flood",
    label: "Flood risk",
    question: "Is this property in a flood zone or high flood-risk area?",
    personaBuckets: ["owner_buyer", "family", "investor", "agent_helper"],
  },
  schools: {
    id: "schools",
    label: "Schools & neighborhood",
    question:
      "What should a buyer know about schools and neighborhood context for this address?",
    personaBuckets: ["family", "owner_buyer", "agent_helper"],
  },
  str: {
    id: "str",
    label: "Short-term rental",
    question: "Are short-term rentals (Airbnb/VRBO) allowed at this property?",
    personaBuckets: ["investor", "owner_buyer", "agent_helper"],
  },
  setbacks: {
    id: "setbacks",
    label: "Setbacks & additions",
    question:
      "What setback or major-addition rules might limit building or expanding here?",
    personaBuckets: ["owner_buyer", "family", "investor", "agent_helper"],
  },
  red_flags: {
    id: "red_flags",
    label: "Client red flags",
    question:
      "What are the top red flags or surprises a buyer should verify before making an offer?",
    personaBuckets: ["agent_helper", "owner_buyer", "investor", "family"],
  },
};

export function isStarterPromptId(id: string): id is StarterPromptId {
  return (STARTER_PROMPT_IDS as readonly string[]).includes(id);
}

export function isPersonaBucket(v: string): v is PersonaBucket {
  return (PERSONA_BUCKETS as readonly string[]).includes(v);
}

export function starterQuestion(id: StarterPromptId): string {
  return PROPERTY_BRIEF_STARTER_PROMPTS[id].question;
}
