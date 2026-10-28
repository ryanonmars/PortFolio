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
  if (title === 'Tagged VLANs') return openTaggedVlans(page, label);
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
    const summary = page.locator(`summary[aria-label="Actions for ${name}"]`);
    if (
      !(await summary
        .locator('..')
        .evaluate((element) => element.hasAttribute('open')))
    )
      await summary.click();
    await page
      .getByRole('button', { name: `Details for ${name}`, exact: true })
      .click();
  }
  await expect(
    inspector.getByRole('heading', { name, exact: true }),
  ).toBeVisible();
  return inspector.getByLabel(label, { exact: true });
}

export async function openTaggedVlans(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const picker = page.getByRole('dialog', {
    name: `${label} picker`,
    exact: true,
  });
  await expect(picker).toBeVisible();
  return picker;
}

export async function selectTaggedVlans(
  page: Page,
  label: string,
  ids: string[],
) {
  const picker = await openTaggedVlans(page, label);
  const clear = picker.getByRole('button', { name: 'Clear all', exact: true });
  if (await clear.isEnabled()) await clear.click();
  for (const id of ids) {
    await picker
      .getByLabel(`${label} to add`, { exact: true })
      .selectOption(id);
    await picker.getByRole('button', { name: 'Add VLAN', exact: true }).click();
  }
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
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
