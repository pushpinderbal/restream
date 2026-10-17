import "./brand-mark.css";

/** The play mark keeps its separated facets after the entrance animation. */
export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`brand-mark ${className}`}
      viewBox="0 0 40 40"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="brand-fragment brand-fragment-top"
        d="m11 6 10 5.5L11 17Z"
      />
      <path
        className="brand-fragment brand-fragment-tip"
        d="M25 15 36 21 25 27Z"
      />
      <path
        className="brand-fragment brand-fragment-center"
        d="M11 21 22 15 22 27Z"
      />
      <path
        className="brand-fragment brand-fragment-bottom"
        d="M12 25.5 23 31.5 12 37.5Z"
      />
    </svg>
  );
}
