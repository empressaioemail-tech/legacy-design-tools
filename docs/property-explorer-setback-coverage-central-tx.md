# Property Explorer Central-TX setback coverage

WDLL acceptance: 43, 44, 51, 52, 54
Audited: 2026-07-23
Scope: cities with a live Central-Texas zoning layer, plus Austin because it is a corpus and extension-public jurisdiction.

This is an envelope eligibility inventory, not a claim that every zoning code in a populated table is eligible. A populated table is allowed to omit conditional, overlay, or unmapped GIS codes. Those codes must decline rather than use a fallback district.

| jurisdictionKey | action | evidence |
| --- | --- | --- |
| `austin-tx` | populated (9 base districts) | `lib/adapters/src/local/setbacks/austin-tx.json`; City public [Section 25-2-492 table record](https://services.austintexas.gov/edims/document.cfm?id=419477), cross-checked with [Austin zoning resources](https://www.austintexas.gov/planning/zoning-resources-site-regulations). Base SF and MF rows only; overlays, combining districts, compatibility, and lot/use conditions remain omitted. |
| `bastrop-city-tx` | populated | `lib/adapters/src/local/setbacks/bastrop-city-tx.json`; official [B3 Code, April 2025](https://www.cityofbastrop.org/upload/page/0107/docs/B3/B3%20Code%20-%20April%202025.pdf), ?6.5.003(A), plus ?2.4.006(a) for P-EC. P-2/P-3 ship the 25-ft undeveloped-lot build-to scalar; P-4/P-5 and P-EC ship the conservative 15-ft top of their build-to ranges. The contextual developed-lot first-layer rule, side/rear dimensions, and height-in-stories remain declared in provenance but are not modeled as asserted scalars. |
| `buda-tx` | populated | `lib/adapters/src/local/setbacks/buda-tx.json`; City UDC ?2.07 at [eCode360](https://ecode360.com/40956702). |
| `cedar-park-tx` | populated | `lib/adapters/src/local/setbacks/cedar-park-tx.json`; cited local ordinance rows, with unmapped codes explicitly omitted. |
| `dripping-springs-tx` | populated | `lib/adapters/src/local/setbacks/dripping-springs-tx.json`; Municode Chapter 30, Exhibit A, Section 3. |
| `georgetown-tx` | populated | `lib/adapters/src/local/setbacks/georgetown-tx.json`; UDC Chapter 6 ?6.02 and Chapter 7 Table 7.02.020. |
| `hutto-tx` | populated | `lib/adapters/src/local/setbacks/hutto-tx.json`; City UDC ?10.403.4.2. |
| `kyle-tx` | populated | `lib/adapters/src/local/setbacks/kyle-tx.json`; eCode360 Chapter 53 ?53-33, Charts 1 and 2. |
| `leander-tx` | populated | `lib/adapters/src/local/setbacks/leander-tx.json`; Chapter 14, Exhibit A, Article VI ?6. |
| `liberty-hill-tx` | populated (14 standard-lot districts) | `lib/adapters/src/local/setbacks/liberty-hill-tx.json`; official [UDC Table 4-4](https://ecode360.com/42968563). Zero-lot-line, PUD, Edwards-Aquifer, MH2, and spelling-unreviewed GIS `I-1` conditions remain omitted. |
| `lockhart-tx` | populated (4 commercial/industrial districts) | `lib/adapters/src/local/setbacks/lockhart-tx.json`; official [Ordinance 2024-18, Appendix II](https://mcclibraryfunctions-stage.azurewebsites.us/api/ordinanceDownload/11173/1309249/pdf). RLD/RMD/RHD development-type, central-business, PDD, and conditional-adjacency cases remain omitted. |
| `new-braunfels-tx` | populated | `lib/adapters/src/local/setbacks/new-braunfels-tx.json`; Chapter 144 ?144-3.4. |
| `pflugerville-tx` | populated | `lib/adapters/src/local/setbacks/pflugerville-tx.json`; City UDC ?4.2.4, Tables 4.2.4A-C at [Encode Plus](https://online.encodeplus.com/regs/pflugerville/doc-view.aspx?print=1&tocid=004.004). |
| `round-rock-tx` | populated | `lib/adapters/src/local/setbacks/round-rock-tx.json`; Code Chapter 2 ?2-26. |
| `san-antonio-tx` | populated (15 residential/multifamily districts) | `lib/adapters/src/local/setbacks/san-antonio-tx.json`; official [UDC Table 310-1](https://sanantonio-tx.elaws.us/code/udc_artiii_div2_sec35-310.01), with public [City table rendering](https://docsonline.sanantonio.gov/FileUploads/DSD/IB565.pdf). Commercial, industrial, downtown, special, overlay, and lot-orientation/plat conditions remain omitted. |
| `san-marcos-tx` | populated | `lib/adapters/src/local/setbacks/san-marcos-tx.json`; 2025 Development Code ??4.4.1.3, 4.4.1.4, and 4.4.2.1. |
| `taylor-tx` | populated (6 Place Types) | `lib/adapters/src/local/setbacks/taylor-tx.json`; City-adopted [Taylor Made LDC](https://www.taylortx.gov/DocumentCenter/View/14244/Taylor-Land-Development-Code---Revised-091224), Sections 4.3.1.2 and 4.3.1.4 through 4.3.1.8. Front is the lower build-to-line bound; side/rear zoning scalar values are absent and carried only as explicit non-binding sentinels, with building-code separation still controlling. EC/CS remain TBD. |

The Bastrop routing policy is explicit: City of Bastrop GIS and situs paths retain their legacy `bastrop-tx` key, while `getSetbackTableForZoning` resolves every B3 `P-*` code to `bastrop-city-tx`. This prevents P-1 through P-5 from reaching the legacy `P Public/Institutional` district. Other populated tables retain their existing documented matching and omission rules; this inventory does not turn an unreviewed GIS code into a newly asserted dimensional value.
