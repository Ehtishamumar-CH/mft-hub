/** Project-wide constants (see docs/DECISIONS.md). */
export const PROJECT = 'mft-hub';

/** D2: Swiss data residency. */
export const REGION = 'eu-central-2';

/** Default resource tags applied to every taggable resource. */
export const DEFAULT_TAGS: Readonly<Record<string, string>> = {
  Project: PROJECT,
  Environment: 'demo',
};
