import type { SVGProps } from "react";

/** Small original mark for the title bar; it uses the active theme tokens. */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M3.5 18.5 8.7 8.2l4.1 7.1 2.4-4.1 5.3 7.3H3.5Z"
        fill="var(--accent-soft)"
        stroke="var(--accent)"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <circle cx="17.1" cy="6.8" r="1.25" fill="var(--accent)" />
    </svg>
  );
}
