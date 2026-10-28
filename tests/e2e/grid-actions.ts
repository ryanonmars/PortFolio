import { expect, type Page } from '@playwright/test';

export async function gridCell(
  page: Page,
  port: number | string,
  column: string,
) {
  const name = typeof port === 'number' ? `Port ${port}` : port;
  const title =
    column === 'Link state (documented)'
      ? 'Documented link state'
      : column === 'Connector kind'
        ? 'Interface type'
        : column;
  const core = [
    'Port',
    'Interface type',
    'Mode',
    'Native/Untagged VLAN',
    'Tagged VLANs',
    'Documented link state',
  ];
  const label = `${name} ${title}`;
  if (core.includes(title)) {
    const button = page.getByRole('button', { name: label, exact: true });
    const editor = page
      .locator('input, select, textarea')
      .and(page.getByLabel(label, { exact: true }));
    if (await button.count()) {
      await button.click();
      await expect(editor).toBeFocused();
    } else await editor.focus();
    return editor;
  }
  const inspector = page.getByRole('complementary', {
    name: 'Port details',
    exact: true,
  });
  if (
    !(await inspector.count()) ||
    !(await inspector.getByRole('heading', { name, exact: true }).count())
  ) {
    await page
      .getByRole('checkbox', { name: `Select ${name}`, exact: true })
      .locator('..')
      .click({ position: { x: 2, y: 2 } });
  }
  await expect(
    inspector.getByRole('heading', { name, exact: true }),
  ).toBeVisible();
  return inspector.getByLabel(label, { exact: true });
}

export async function openBulk(page: Page) {
  const summary = page.locator('summary').filter({ hasText: /^Bulk actions/ });
  if (
    !(await summary.evaluate((element) =>
      element.parentElement!.hasAttribute('open'),
    ))
  )
    await summary.click();
}
