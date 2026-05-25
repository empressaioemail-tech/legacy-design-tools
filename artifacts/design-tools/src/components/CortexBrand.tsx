import { useChromeTheme } from "@workspace/portal-ui";

const MONO =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function isLightChrome(themeId: string): boolean {
  return themeId === "light" || themeId === "soft-light";
}

export function CortexWordmark({
  height = 26,
  className,
}: {
  height?: number;
  className?: string;
}) {
  const { themeId } = useChromeTheme();
  const fill = isLightChrome(themeId) ? "#0d0d0d" : "#fafaf7";
  const width = Math.round((height * 640) / 140);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 640 140"
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="Cortex"
      data-testid="cortex-wordmark"
    >
      <text
        x="320"
        y="98"
        textAnchor="middle"
        fill={fill}
        style={{ fontFamily: MONO, fontSize: 88 }}
      >
        <tspan fontWeight={300}>[ </tspan>
        <tspan fontWeight={500}>cortex</tspan>
        <tspan fontWeight={300}> ]</tspan>
      </text>
    </svg>
  );
}

export function CortexIcon({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const { themeId } = useChromeTheme();
  const fill = isLightChrome(themeId) ? "#0d0d0d" : "#fafaf7";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Cortex"
      data-testid="cortex-icon"
    >
      <text
        x="50"
        y="68"
        textAnchor="middle"
        fill={fill}
        style={{ fontFamily: MONO, fontSize: 56 }}
      >
        <tspan fontWeight={300}>[</tspan>
        <tspan fontWeight={500}>c</tspan>
        <tspan fontWeight={300}>]</tspan>
      </text>
    </svg>
  );
}
