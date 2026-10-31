const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export const fmtDate = (d: Date | string) => date.format(new Date(d));
export const fmtDateTime = (d: Date | string) => `${dateTime.format(new Date(d))} UTC`;
export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const STATUS_TONE = { draft: 'neutral', ready: 'positive', completed: 'accent' } as const;
export const STATUS_LABEL = { draft: 'Draft', ready: 'Ready', completed: 'Completed' } as const;
