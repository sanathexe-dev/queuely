export default function Logo({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--brand-deep)" />
      <circle cx="10" cy="16" r="3.4" fill="#d9f99d" />
      <circle cx="17.2" cy="16" r="2.7" fill="#bef264" opacity=".85" />
      <circle cx="23.4" cy="16" r="2.1" fill="#a3e635" opacity=".65" />
    </svg>
  );
}
