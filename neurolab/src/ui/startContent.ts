/** The words on the start screen. Kept apart from the DOM code so a test can check the disclaimer is always there. */
import { t } from '../i18n';

export const eyebrow = (): string => t('start.eyebrow');
export const headline = (): string => t('start.headline');
export const subtitle = (): string => t('start.subtitle');
export const tagline = (): string => t('start.tagline');

/** Shown on the start screen, in the README and on the debrief. It is part of the product. */
export const disclaimer = (): string => t('start.disclaimer');

export const buildStatus = (): string => t('start.status');
