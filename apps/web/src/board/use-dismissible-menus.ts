import { useEffect, type RefObject } from 'react';

// These are action menus, not inspector accordions or board-group folders.
const menuSelector =
  'details.board-more,details.board-browser-actions,details.port-row-menu';

export function useDismissibleMenus(scope: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const openMenus = () =>
      Array.from(
        scope.current?.querySelectorAll<HTMLDetailsElement>(menuSelector) ?? [],
      ).filter((menu) => menu.open);
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      for (const menu of openMenus())
        if (!path.includes(menu)) menu.open = false;
    };
    const opened = (event: Event) => {
      const target = event.target;
      if (
        !(target instanceof HTMLDetailsElement) ||
        !target.matches(menuSelector) ||
        !target.open
      )
        return;
      for (const menu of openMenus()) if (menu !== target) menu.open = false;
    };
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        document.querySelector('dialog[open],[popover]:popover-open')
      )
        return;
      const menus = openMenus();
      if (!menus.length) return;
      const active = document.activeElement;
      const focused = menus.find((menu) => active && menu.contains(active));
      // A portal dialog/context menu owns Escape before an underlying ellipsis.
      // Explorer itself is a dialog on mobile and contains its board menus.
      const overlay =
        active instanceof Element
          ? active.closest('[role="dialog"],[role="menu"]')
          : null;
      if (!focused && overlay && !menus.some((menu) => overlay.contains(menu)))
        return;
      const menu = focused ?? menus.at(-1)!;
      event.preventDefault();
      event.stopImmediatePropagation();
      menu.open = false;
      menu
        .querySelector<HTMLElement>('summary')
        ?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('toggle', opened, true);
    // Window capture precedes the mobile Explorer's document-level Escape trap.
    window.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('toggle', opened, true);
      window.removeEventListener('keydown', keyboard, true);
    };
  }, [scope]);
}
