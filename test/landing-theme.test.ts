import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { landingPage } from '../src/routes/landing.js';

function preview(saved?: string, blocked = false) {
  const html = landingPage('', '/reading');
  const root = { dataset: {} as Record<string, string> };
  const attributes: Record<string, string> = {};
  let click = () => {};
  const context = {
    localStorage: {
      getItem: () => { if (blocked) throw new Error('blocked'); return saved; },
      setItem: (_key: string, value: string) => { if (blocked) throw new Error('blocked'); saved = value; },
    },
    document: {
      documentElement: root,
      getElementById: () => ({
        setAttribute: (key: string, value: string) => { attributes[key] = value; },
        addEventListener: (_event: string, handler: () => void) => { click = handler; },
      }),
      querySelector: () => ({ setAttribute: (key: string, value: string) => { attributes[key] = value; } }),
    },
  };
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(script[1], context);
  return { root, attributes, click: () => click(), saved: () => saved, html };
}

it('defaults to light and switches the page and browser chrome together', () => {
  const page = preview();
  expect(page.html).not.toContain('prefers-color-scheme');
  expect(page.html).toContain('/reading/landing/book.webp');
  expect(page.attributes).toMatchObject({ 'aria-pressed': 'false', content: '#faf8f3' });
  page.click();
  expect(page.root.dataset.theme).toBe('dark');
  expect(page.attributes).toMatchObject({ 'aria-pressed': 'true', content: '#121110' });
  expect(preview(page.saved()).root.dataset.theme).toBe('dark');
  page.click();
  expect(page.saved()).toBe('light');
});

it('still switches when browser storage is blocked', () => {
  const page = preview(undefined, true);
  expect(page.attributes['aria-pressed']).toBe('false');
  page.click();
  expect(page.root.dataset.theme).toBe('dark');
});
