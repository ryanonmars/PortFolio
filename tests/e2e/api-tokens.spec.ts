import { expect, test } from '@playwright/test';

test('API tokens show a secret once, preserve metadata, revoke and fit the viewport', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('token-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Synthetic-token-password-42');
  const setup = await (
    await page.request.get('/api/v1/auth/setup-status')
  ).json();
  await page
    .getByRole('button', {
      name: setup.setupRequired ? 'Create administrator account' : 'Sign in',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Open board browser', exact: true }),
  ).toBeVisible();
  async function open() {
    const settings = page.getByText('Settings', { exact: true });
    if (!(await settings.isVisible()))
      await page
        .getByRole('button', { name: 'Open board browser', exact: true })
        .click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'API Tokens', exact: true }).click();
  }
  await open();
  const dialog = page.getByRole('region', { name: 'API Tokens', exact: true });
  await expect(dialog).toBeVisible();
  await page
    .getByLabel('Token name', { exact: true })
    .fill('Documentation assistant');
  await expect(page.getByLabel('Access', { exact: true })).toHaveValue('read');
  await page
    .getByLabel('Expires at (optional)', { exact: true })
    .fill('2030-01-01T12:00');
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  const secret = page.getByLabel('New API token', { exact: true });
  await expect(secret).toHaveValue(/^pf_[a-f0-9]{64}$/);
  const plaintext = await secret.inputValue();
  await expect(
    dialog.getByText('Documentation assistant', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/Expires:/)).toContainText('2030');
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.getByRole('link', { name: 'General', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('link', { name: 'API Tokens', exact: true }).click();
  await expect(page.getByLabel('New API token', { exact: true })).toHaveCount(
    0,
  );
  expect(await dialog.textContent()).not.toContain(plaintext);
  await page.screenshot({
    path: test.info().outputPath('api-token-settings.png'),
  });
  await page
    .getByRole('button', {
      name: 'Revoke Documentation assistant',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Confirm revoke', exact: true })
    .click();
  await expect(dialog.getByText('Revoked', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'General', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
