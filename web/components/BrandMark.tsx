/** The Synapse app tile (assets/brand/synapse-app-icon.png, served from public/brand-mark.png). */
export default function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return <img className={className} src="/brand-mark.png" width={24} height={24} alt="" />;
}
