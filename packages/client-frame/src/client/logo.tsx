/**
 * The official ORYH logo: four connected records around one trusted center, plus the wordmark.
 *
 * Traced from `site/public/brand/oryh-logo.svg` in the ORYH repository rather than redrawn. The
 * two near-black fills become `currentColor` so the mark stays legible on a dark sidebar; only the
 * emerald accent is a fixed brand colour. `compact` drops the wordmark and keeps the square mark,
 * which is what fits an icon rail.
 * @param compact - render the mark alone instead of the full lockup.
 * @returns the inline logo, hidden from assistive tech when a text label sits beside it.
 */
export function OryhLogo({ compact }: { compact: boolean }) {
  return (
    <svg
      className="oryh-logo"
      viewBox={compact ? '0 0 40 40' : '0 0 73 40'}
      role="img"
      aria-label="ORYH"
      focusable="false"
    >
      <rect x="7" y="4" width="17" height="8" rx="3" fill="currentColor" />
      <rect x="28" y="9" width="8" height="17" rx="3" fill="currentColor" />
      <rect x="16" y="28" width="17" height="8" rx="3" fill="#047857" />
      <rect x="4" y="15" width="8" height="17" rx="3" fill="currentColor" />
      {!compact && (
        <g transform="translate(42.46 25.28)">
          <path
            fill="currentColor"
            d="M1.54 0.00V-11.88H4.18V-8.98L3.89 -9.35Q4.12 -9.97 4.51 -10.47Q4.89 -10.98 5.46 -11.31Q5.88 -11.57 6.39 -11.72Q6.90 -11.87 7.44 -11.91Q7.97 -11.95 8.51 -11.88V-9.09Q8.02 -9.24 7.36 -9.19Q6.71 -9.14 6.18 -8.89Q5.65 -8.65 5.29 -8.24Q4.93 -7.84 4.74 -7.30Q4.55 -6.75 4.55 -6.07V0.00ZM10.03 5.28 12.32 -1.01 12.36 0.84 7.19 -11.88H10.30L13.77 -2.88H13.07L16.52 -11.88H19.51L12.80 5.28ZM27.50 0.00V-5.61Q27.50 -6.02 27.46 -6.65Q27.41 -7.28 27.18 -7.92Q26.95 -8.56 26.43 -8.99Q25.90 -9.42 24.95 -9.42Q24.56 -9.42 24.12 -9.29Q23.68 -9.17 23.30 -8.83Q22.91 -8.48 22.67 -7.81Q22.42 -7.14 22.42 -6.03L20.70 -6.84Q20.70 -8.25 21.27 -9.48Q21.85 -10.71 23.00 -11.47Q24.14 -12.23 25.89 -12.23Q27.29 -12.23 28.17 -11.76Q29.05 -11.29 29.54 -10.56Q30.03 -9.83 30.24 -9.05Q30.45 -8.26 30.49 -7.61Q30.54 -6.96 30.54 -6.67V0.00ZM19.38 0.00V-15.84H22.04V-7.70H22.42V0.00Z"
          />
        </g>
      )}
    </svg>
  )
}
