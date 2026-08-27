/**
 * Shared Playwright selector helpers for P-85 index-search recipes.
 */

import type { RecordsRecipeBrowser } from "./types.js";

export async function tryClickFirst(
  browser: RecordsRecipeBrowser,
  selectors: readonly string[],
): Promise<boolean> {
  for (const selector of selectors) {
    const result = await browser.click(selector);
    if (result.ok) return true;
  }
  return false;
}

export async function tryFillFirst(
  browser: RecordsRecipeBrowser,
  selectors: readonly string[],
  value: string,
): Promise<boolean> {
  for (const selector of selectors) {
    const result = await browser.fill(selector, value);
    if (result.ok) return true;
  }
  return false;
}

export const TERMS_ACCEPT_SELECTORS = [
  'input[type="submit"][value*="Accept" i]',
  'button:has-text("I Accept")',
  'button:has-text("Accept")',
  'a:has-text("Accept")',
  "#acceptDisclaimer",
  "#btnAccept",
  'button:has-text("I Agree")',
  'a:has-text("I Agree")',
] as const;

export const SEARCH_SUBMIT_SELECTORS = [
  'input[type="submit"][value*="Search" i]',
  'button:has-text("Search")',
  'button[type="submit"]',
  'input[type="submit"]',
] as const;
