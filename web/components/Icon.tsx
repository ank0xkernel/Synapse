/** Synapse line icons: 20px grid, 1.5 stroke, round caps. Decorative by default (aria-hidden). */
const PATHS = {
  dashboard: 'M3.5 3.5h5.5v6H3.5zM11 3.5h5.5v3.5H11zM11 9h5.5v7.5H11zM3.5 11.5H9v5H3.5z',
  resume: 'M5.5 2.5h6l3.5 3.5v11.5h-9.5zM11.5 2.5V6H15M8 9.5h4.5M8 12.5h4.5M8 15.5h2.5',
  profile: 'M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5',
  job: 'M3 6.5h14v10H3zM7.5 6.5V4.5h5v2M3 10.5h14',
  session: 'M3.5 4.5h13v9h-7l-3.5 3v-3H3.5zM7 8.5h6M7 11h3.5',
  prep: 'M10 2.5l1.9 4.6 4.6.4-3.5 3 1.1 4.7L10 12.8l-4.1 2.4 1.1-4.7-3.5-3 4.6-.4z',
  desktop: 'M2.5 4h15v9.5h-15zM7 16.5h6M10 13.5v3',
  settings: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
  upload: 'M10 13V3.5M6 7.5l4-4 4 4M3.5 13v3.5h13V13',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  plus: 'M10 4v12M4 10h12',
  arrow: 'M4 10h12M11 5l5 5-5 5',
  close: 'M5 5l10 10M15 5L5 15',
  link: 'M8.5 11.5l3-3M7 9l-2 2a2.8 2.8 0 0 0 4 4l2-2M13 11l2-2a2.8 2.8 0 0 0-4-4L9 7',
  spark: 'M10 3v4M10 13v4M3 10h4M13 10h4M5.5 5.5l2 2M12.5 12.5l2 2M5.5 14.5l2-2M12.5 7.5l2-2',
  mic: 'M10 12.5a2.5 2.5 0 0 0 2.5-2.5V5a2.5 2.5 0 0 0-5 0v5a2.5 2.5 0 0 0 2.5 2.5zM5.5 10a4.5 4.5 0 0 0 9 0M10 14.5v2.5',
  wave: 'M2.5 10h2l1.5-4 2.5 9 2.5-11 2.5 9 1.5-3h2.5',
  file: 'M5.5 2.5h6l3.5 3.5v11.5h-9.5zM11.5 2.5V6H15',
  trash: 'M4 6h12M8 6V4h4v2M5.5 6l.8 10.5h7.4L14.5 6',
  edit: 'M12.5 4l3.5 3.5-8.5 8.5H4v-3.5z',
  refresh: 'M15.5 8.5A5.5 5.5 0 0 0 5 7M4.5 11.5A5.5 5.5 0 0 0 15 13M5 3.5V7h3.5M15 16.5V13h-3.5',
  lock: 'M5 9h10v8H5zM7 9V6.5a3 3 0 0 1 6 0V9',
  clock: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6v4l2.5 2',
  external: 'M8 4.5H4.5v11h11V12M11 3.5h5.5V9M16.5 3.5L9 11'
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 18, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
