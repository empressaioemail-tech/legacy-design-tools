export function DisciplineBadge({ discipline }: { discipline: string }) {
  const label = discipline.replace(/-/g, " ");
  return <span className={`sc-dept-badge dept-${discipline}`}>{label}</span>;
}
