import { BodyFontSizeSchema } from './contracts';

export const BODY_FONT_SIZE_CSS_VARIABLE = '--wiki-body-font-size';

export function bodyFontSizeCssValue(value: number): string {
  return `${BodyFontSizeSchema.parse(value)}px`;
}

export function applyBodyFontSize(
  element: Pick<HTMLElement, 'style'>,
  value: number,
): void {
  element.style.setProperty(BODY_FONT_SIZE_CSS_VARIABLE, bodyFontSizeCssValue(value));
}
