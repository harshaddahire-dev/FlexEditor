/** The Cutroom mark: a clip being cut — two film strips parted by a diagonal blade line. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Cutroom" className="logo">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--bg-3)" stroke="var(--line-strong)" />
      <path d="M5 8.5h7.2L9.4 15.5H5z" fill="var(--accent)" />
      <path d="M13.6 8.5H19v7h-7.4z" fill="var(--text-1)" opacity="0.88" />
      <path d="M12.9 6.5 9.9 17.5" stroke="var(--playhead)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
