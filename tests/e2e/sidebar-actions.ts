import { expect, type Page } from '@playwright/test';

export async function openSidebar(page: Page) {
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await expect(page.locator('.sidebar-menu-toggle')).toBeAttached();
  if (
    (await menu.isVisible()) &&
    (await menu.getAttribute('aria-expanded')) === 'false'
  )
    await menu.click();
  await expect(
    page.getByRole('navigation', { name: 'Workspace navigation', exact: true }),
  ).toBeVisible();
}

export async function sidebarAction(page: Page, name: string) {
  await openSidebar(page);
  await page
    .getByRole('navigation', { name: 'Workspace navigation', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
}

export async function sidebarNavigate(
  page: Page,
  name: string,
  mayDecline = false,
) {
  await openSidebar(page);
  const link = page
    .getByRole('navigation', { name: 'Workspace navigation', exact: true })
    .getByRole('link', { name, exact: true });
  const href = await link.getAttribute('href');
  await link.click();
  if (!mayDecline) {
    await expect(page).toHaveURL(new URL(href!, page.url()).toString());
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    if (await menu.isVisible())
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
  }
}
