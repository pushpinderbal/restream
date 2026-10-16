import "./brand-mark.css";

/** Dispersed fragments converge into a single play symbol on first mount. */
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
        d="M12 8 23 14 12 20Z"
      />
      <path
        className="brand-fragment brand-fragment-tip"
        d="M23 14 34 20 23 26Z"
      />
      <path
        className="brand-fragment brand-fragment-center"
        d="M12 20 23 14 23 26Z"
      />
      <path
        className="brand-fragment brand-fragment-bottom"
        d="M12 20 23 26 12 32Z"
      />
      <path className="brand-resolved" d="M12 8 34 20 12 32Z" />
    </svg>
  );
}
