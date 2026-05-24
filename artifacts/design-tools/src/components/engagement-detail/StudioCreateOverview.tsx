import { CREATE_OUTPUTS, PROMPT_GENERATOR_CREDITS } from "./studioMnmlCatalog";

/** Compact mnml capability legend above the kickoff form. */
export function StudioCreateOverview() {
  return (
    <div
      className="studio-create-overview"
      data-testid="studio-create-overview"
    >
      <p className="studio-create-overview-lead">
        mnml.ai powers Studio. Pick an output type, then configure source,
        style, and prompt.
      </p>
      <ul className="studio-create-overview-list">
        {CREATE_OUTPUTS.map((o) => (
          <li key={o.id}>
            <span className="studio-create-overview-name">{o.title}</span>
            <span className="studio-create-overview-hint">{o.hint}</span>
            <span className="studio-create-overview-cost">{o.credits} cr</span>
          </li>
        ))}
        <li>
          <span className="studio-create-overview-name">Prompt generator</span>
          <span className="studio-create-overview-hint">
            Reference image → optimized prompt
          </span>
          <span className="studio-create-overview-cost">
            {PROMPT_GENERATOR_CREDITS} cr
          </span>
        </li>
      </ul>
    </div>
  );
}
