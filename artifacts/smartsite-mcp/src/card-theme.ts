/**
 * Card colour system. ONE token set drives every surface of the MCP App card,
 * so the card can never be half dark and half light.
 *
 * What hosts actually send (primary docs, read 2026-11):
 *  - MCP Apps (SEP-1865, spec 2026-01-26): the host answers `ui/initialize`
 *    with `hostContext.theme` ("light" | "dark") and optional
 *    `hostContext.styles.variables` (a map such as `--color-background-primary`).
 *    Hosts may send any subset or none, and later send
 *    `ui/notifications/host-context-changed` with a partial context. The app is
 *    expected to keep fallback values in `:root` and apply the host's values.
 *    https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 *    https://modelcontextprotocol.io/extensions/apps/overview
 *  - ChatGPT Apps SDK: `window.openai.theme` ("light" | "dark") with the
 *    `openai:set_globals` event. It documents no CSS variables.
 *    https://developers.openai.com/apps-sdk/reference
 *    https://developers.openai.com/apps-sdk/build/chatgpt-ui
 *
 * So: the fallback palette below is chosen by the host's theme flag when it
 * sends one, else by prefers-color-scheme. Host colour variables are applied
 * only when the host sends the core set (a partial set would clash with our
 * accents); the ones it leaves out are derived from the ones it sends.
 */

export type ThemeTokens = Record<string, string>;

export const DARK_TOKENS: ThemeTokens = {
  "--color-background-primary": "#30302E",
  "--color-background-secondary": "#262624",
  "--color-background-tertiary": "#1C1C1B",
  "--color-text-primary": "#FAF9F5",
  "--color-text-secondary": "#C2C0B6",
  "--color-text-tertiary": "#AAA8A0",
  "--color-border-primary": "#6B6A64",
  "--color-border-secondary": "#44433F",
  "--color-border-tertiary": "#56554F",
  "--color-background-inverse": "#FAF9F5",
  "--color-text-inverse": "#141413",
  "--ss-raised": "#3C3C39",
  "--ss-blue": "#86ADDF",
  "--ss-gold": "#E8963B",
  "--ss-atom": "#6FC1B8",
  "--ss-slate": "#A9ABAF",
  "--ss-warn": "#CFB165",
  "--ss-amber": "#D1A041",
  "--ss-accent": "#86ADDF",
  "--ss-record": "#6FC1B8",
  "--ss-on-accent": "#1F1F1E",
  "--ss-brand-site": "#F5B95C",
  "--ss-atom-wash": "rgba(111,193,184,.12)",
};

export const LIGHT_TOKENS: ThemeTokens = {
  "--color-background-primary": "#FFFFFF",
  "--color-background-secondary": "#F5F4ED",
  "--color-background-tertiary": "#EDECE4",
  "--color-text-primary": "#141413",
  "--color-text-secondary": "#4A4944",
  "--color-text-tertiary": "#5E5D57",
  "--color-border-primary": "#8F8D84",
  "--color-border-secondary": "#E3E1D8",
  "--color-border-tertiary": "#C9C6BA",
  "--color-background-inverse": "#141413",
  "--color-text-inverse": "#FAF9F5",
  "--ss-raised": "#EDECE4",
  "--ss-blue": "#1F5F94",
  "--ss-gold": "#7F4B00",
  "--ss-atom": "#176158",
  "--ss-slate": "#55575B",
  "--ss-warn": "#745000",
  "--ss-amber": "#7F5300",
  "--ss-accent": "#1F5F94",
  "--ss-record": "#176158",
  "--ss-on-accent": "#FFFFFF",
  "--ss-brand-site": "#7F4B00",
  "--ss-atom-wash": "rgba(23,97,88,.12)",
};

function block(tokens: ThemeTokens): string {
  return Object.keys(tokens)
    .map((k) => `${k}:${tokens[k]}`)
    .join(";");
}

/** Names the rest of the stylesheet already uses, now aliases of the one token set. */
const ALIASES =
  "--ss-ink:var(--color-background-primary);--ss-void:var(--color-background-secondary);" +
  "--ss-t3:var(--color-text-primary);--ss-t5:var(--color-text-secondary);--ss-t6:var(--color-text-tertiary);" +
  "--ss-line-06:var(--color-border-secondary);--ss-line-14:var(--color-border-tertiary);" +
  "--bg:var(--color-background-primary);" +
  '--ss-ui:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;' +
  "--ss-fs-meta:12.5px;--ss-fs-body:14.5px;--ss-r-tip:12px";

/**
 * The token blocks. Dark is the default; light applies by the host's flag
 * (`data-scheme`) or, with no flag, by prefers-color-scheme.
 */
export function buildThemeCss(): string {
  return [
    `:root{color-scheme:dark;${block(DARK_TOKENS)};${ALIASES}}`,
    `:root[data-scheme="light"]{color-scheme:light;${block(LIGHT_TOKENS)}}`,
    `@media (prefers-color-scheme:light){:root:not([data-scheme="dark"]){color-scheme:light;${block(LIGHT_TOKENS)}}}`,
  ].join("\n");
}

/**
 * Applies the host theme. Runs after the card script so the card's own message
 * guard stays the first one in the page. No network, no eval.
 */
export const THEME_SCRIPT = `(function(){
  var root=document.documentElement;
  var CORE=["--color-background-primary","--color-text-primary","--color-text-secondary"];
  var NAME=/^--(color|font)-[a-z0-9-]+$/;
  var ctx={};
  var canMix=false;
  try{canMix=!!(window.CSS&&CSS.supports&&CSS.supports("color","color-mix(in srgb,red 50%,blue)"));}catch(e){}
  function mix(a,b,p){return "color-mix(in srgb,var("+a+") "+p+"%,var("+b+"))";}
  function lum(c){
    var m=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c||"");var r,g,b;
    if(m){var h=m[1];if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];r=parseInt(h.slice(0,2),16);g=parseInt(h.slice(2,4),16);b=parseInt(h.slice(4,6),16);}
    else{m=/^rgba?\\(\\s*(\\d+)[ ,]+(\\d+)[ ,]+(\\d+)/.exec(c||"");if(!m)return null;r=+m[1];g=+m[2];b=+m[3];}
    return (0.2126*r+0.7152*g+0.0722*b)/255;
  }
  function setScheme(t){
    if(t!=="light"&&t!=="dark")return;
    root.setAttribute("data-scheme",t);
    root.style.colorScheme=t;
  }
  function applyVars(v){
    if(!v||typeof v!=="object"||!canMix)return;
    for(var i=0;i<CORE.length;i++){if(typeof v[CORE[i]]!=="string"||!v[CORE[i]])return;}
    var P="--color-background-primary",T="--color-text-primary",S="--color-text-secondary";
    var given={};
    for(var k in v){
      if(Object.prototype.hasOwnProperty.call(v,k)&&NAME.test(k)&&typeof v[k]==="string"&&v[k]){
        root.style.setProperty(k,v[k]);given[k]=1;
      }
    }
    var derive={
      "--color-background-secondary":mix(P,T,94),
      "--color-background-tertiary":mix(P,T,88),
      "--color-text-tertiary":mix(S,P,72),
      "--color-border-primary":mix(T,P,40),
      "--color-border-secondary":mix(T,P,10),
      "--color-border-tertiary":mix(T,P,22),
      "--color-background-inverse":"var("+T+")",
      "--color-text-inverse":"var("+P+")"
    };
    for(var d in derive){if(!given[d])root.style.setProperty(d,derive[d]);}
    root.style.setProperty("--ss-raised",mix(P,T,86));
    if(!ctx.theme){var l=lum(v[P]);if(l!==null)setScheme(l>0.5?"light":"dark");}
  }
  function take(c){
    if(!c||typeof c!=="object")return;
    if(c.theme){ctx.theme=c.theme;setScheme(c.theme);}
    if(c.styles&&c.styles.variables)applyVars(c.styles.variables);
  }
  window.addEventListener("message",function(ev){
    if(ev.source!==window.parent)return;
    var m=ev.data;
    if(!m||typeof m!=="object")return;
    if(m.result&&m.result.hostContext)take(m.result.hostContext);
    else if(m.method==="ui/notifications/host-context-changed")take(m.params);
  });
  try{
    if(window.openai&&window.openai.theme)setScheme(window.openai.theme);
    window.addEventListener("openai:set_globals",function(e){
      var g=e&&e.detail&&e.detail.globals;
      if(g&&g.theme)setScheme(g.theme);
    });
  }catch(e2){}
})();`;
