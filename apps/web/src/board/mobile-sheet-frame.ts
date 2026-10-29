/** Accessible controls, not a guessed keyboard height, define the fallback. */
export const mobileSheetTarget = 44;
export const mobileSheetPadding = 6;
const minimumFocusRow = mobileSheetTarget + mobileSheetPadding * 2;

export function mobileSheetFrame(
  viewport: { top: number; height: number },
  headerBottom: number,
  desiredHeight: number,
  focused: boolean,
  layoutHeight: number,
  focusedFieldHeight = mobileSheetTarget,
) {
  const minimumEditor =
    mobileSheetTarget +
    Math.max(
      mobileSheetTarget,
      Math.min(
        focusedFieldHeight,
        Math.max(mobileSheetTarget, layoutHeight - minimumFocusRow),
      ),
    ) +
    mobileSheetPadding * 2;
  const available = Math.max(
    0,
    viewport.top + viewport.height - Math.max(viewport.top, headerBottom),
  );
  const constrained = focused && available < minimumEditor;
  const emergency = constrained && viewport.height < minimumEditor;
  if (emergency)
    return {
      top: viewport.top,
      height: Math.min(
        Math.max(1, layoutHeight),
        Math.max(viewport.height, minimumFocusRow),
      ),
      constrained,
      emergency,
    };
  if (constrained)
    return {
      top: viewport.top,
      height: viewport.height,
      constrained,
      emergency,
    };
  const height = Math.max(
    1,
    Math.min(available, viewport.height * 0.94, desiredHeight),
  );
  return {
    top: viewport.top + viewport.height - height,
    height,
    constrained,
    emergency,
  };
}
