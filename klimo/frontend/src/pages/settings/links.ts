/** Opens an address outside the panel (a Telegram deep link) in a new tab, leaving the panel as it is. */
export function openTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
