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
        d="M24 15.5 35 21.5 24 27.5Z"
      />
      <path
        className="brand-fragment brand-fragment-center"
        d="M12 21 23 15 23 27Z"
      />
      <path
        className="brand-fragment brand-fragment-bottom"
        d="M12 22.5 23 28.5 12 34.5Z"
      />
    </svg>
  );
}
