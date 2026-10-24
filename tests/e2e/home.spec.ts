import { expect, test } from '@playwright/test';

test.beforeEach(({ context }) => context.route('https://plausible.io/**', (r) => r.fulfill({ status: 202, body: '' })));

test('homepage filter: empty shows all, a match narrows, no match says so', async ({ page }) => {
  await page.goto('/');
  const filter = page.getByLabel('Find a tool');
  const tools = page.locator('#tools li');
  const headings = page.locator('#tools h2');
  const visible = page.locator('#tools li:visible');
  const noMatch = page.getByText('No tool matches that. Try "HEIC", "PDF", "JSON" or "QR".');

  await expect(visible).toHaveCount(await tools.count());
  await expect(noMatch).toBeHidden();

  await filter.fill('heic');
  await expect(visible).toHaveCount(1);
  await expect(visible.getByRole('link')).toHaveAttribute('href', '/heic-to-jpg/');
  await expect(noMatch).toBeHidden();

  // A category heading hides when every tool under it is filtered out.
  await expect(headings).toHaveText(['Image', 'PDF', 'AI', 'Video', 'Developer', 'QR code']);
  await filter.fill('json'); // the JSON formatter and the JWT decoder ("JSON Web Token")
  await expect(visible).toHaveCount(2);
  await expect(headings.filter({ visible: true })).toHaveText(['Developer']);
  await filter.fill('pdf');
  await expect(visible).toHaveCount(4);
  await expect(headings.filter({ visible: true })).toHaveText(['PDF']);

  await filter.fill('zzzz');
  await expect(visible).toHaveCount(0);
  await expect(headings.filter({ visible: true })).toHaveCount(0);
  await expect(noMatch).toBeVisible();

  await filter.fill('');
  await expect(headings.filter({ visible: true })).toHaveCount(6);
  await expect(visible).toHaveCount(await tools.count());
  await expect(noMatch).toBeHidden();
});
