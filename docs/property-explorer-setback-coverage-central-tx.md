# Property Explorer Central-TX setback coverage

WDLL acceptance: 43, 44  
Audited: 2026-07-22  
Scope: cities with a live Central-Texas zoning layer, plus Austin because it is a corpus and extension-public jurisdiction.

This is an envelope eligibility inventory, not a claim that every zoning code in a populated table is eligible. A populated table is allowed to omit conditional, overlay, or unmapped GIS codes. Those codes must decline rather than use a fallback district.

| jurisdictionKey | action | evidence |
| --- | --- | --- |
| `austin-tx` | honest-empty | `lib/adapters/src/local/setbacks/austin-tx.json`; official [Austin zoning resources](https://www.austintexas.gov/planning/zoning-resources-site-regulations) identifies LDC §25-2-492 and combining-district conditions. No city zoning stamp or conditional-rule model is wired. |
| `bastrop-city-tx` | honest-empty | `lib/adapters/src/local/setbacks/bastrop-city-tx.json`; official [B3 Code, April 2025](https://www.cityofbastrop.org/upload/page/0107/docs/B3/B3%20Code%20-%20April%202025.pdf). P-1 through P-5 need frontage, existing-lot, and building-type facts. |
| `buda-tx` | populated | `lib/adapters/src/local/setbacks/buda-tx.json`; City UDC §2.07 at [eCode360](https://ecode360.com/40956702). |
| `cedar-park-tx` | populated | `lib/adapters/src/local/setbacks/cedar-park-tx.json`; cited local ordinance rows, with unmapped codes explicitly omitted. |
| `dripping-springs-tx` | populated | `lib/adapters/src/local/setbacks/dripping-springs-tx.json`; Municode Chapter 30, Exhibit A, Section 3. |
| `georgetown-tx` | populated | `lib/adapters/src/local/setbacks/georgetown-tx.json`; UDC Chapter 6 §6.02 and Chapter 7 Table 7.02.020. |
| `hutto-tx` | populated | `lib/adapters/src/local/setbacks/hutto-tx.json`; City UDC §10.403.4.2. |
| `kyle-tx` | populated | `lib/adapters/src/local/setbacks/kyle-tx.json`; eCode360 Chapter 53 §53-33, Charts 1 and 2. |
| `leander-tx` | populated | `lib/adapters/src/local/setbacks/leander-tx.json`; Chapter 14, Exhibit A, Article VI §6. |
| `liberty-hill-tx` | honest-empty | `lib/adapters/src/local/setbacks/liberty-hill-tx.json`; official UDC Table 4-4 at [eCode360](https://ecode360.com/42968563) has zero-lot-line, PUD, and Edwards-Aquifer conditions. |
| `lockhart-tx` | honest-empty | `lib/adapters/src/local/setbacks/lockhart-tx.json`; official [Ordinance 2024-18](https://mcclibraryfunctions-stage.azurewebsites.us/api/ordinanceDownload/11173/1309249/pdf) applies building-type and adjacency conditions. |
| `new-braunfels-tx` | populated | `lib/adapters/src/local/setbacks/new-braunfels-tx.json`; Chapter 144 §144-3.4. |
| `pflugerville-tx` | populated | `lib/adapters/src/local/setbacks/pflugerville-tx.json`; City UDC §4.2.4, Tables 4.2.4A-C at [Encode Plus](https://online.encodeplus.com/regs/pflugerville/doc-view.aspx?print=1&tocid=004.004). |
| `round-rock-tx` | populated | `lib/adapters/src/local/setbacks/round-rock-tx.json`; Code Chapter 2 §2-26. |
| `san-antonio-tx` | honest-empty | `lib/adapters/src/local/setbacks/san-antonio-tx.json`; official UDC Table 310-1 at [eLaws](https://sanantonio-tx.elaws.us/code/udc_artiii_div2_sec35-310.01), with §35-516 lot-orientation and plat controls unmodeled. |
| `san-marcos-tx` | populated | `lib/adapters/src/local/setbacks/san-marcos-tx.json`; 2025 Development Code §§4.4.1.3, 4.4.1.4, and 4.4.2.1. |
| `taylor-tx` | honest-empty | `lib/adapters/src/local/setbacks/taylor-tx.json`; official [zoning and ordinances page](https://www.taylortx.gov/1281/Zoning-and-Ordinances) and form-based Place Type map. |

The policy is deliberately narrow: the known Bastrop B3 Place Type codes select a cited empty table and return an honest decline. Other populated tables retain their existing documented matching and omission rules; this inventory does not turn an unreviewed GIS code into a newly asserted dimensional value.
