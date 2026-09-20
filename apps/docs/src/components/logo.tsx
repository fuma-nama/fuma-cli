"use client";
import { type ComponentProps, useId } from "react";

export function Logo(props: ComponentProps<"svg">) {
  const id = useId();

  return (
    <svg viewBox="0 0 279 278" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <g filter={`url(#${id}filter0_d_657_85)`}>
        <rect x="31.4004" y="58" width="216" height="158" rx="16" fill="#4D3AF7" />
      </g>
      <path
        d="M63.2004 125V95.8H82.0004V101.4H69.1204V107.88H80.9604V113.48H69.2004V125H63.2004ZM96.3848 125.4C93.4248 125.4 91.0781 124.6 89.3448 123C87.6381 121.4 86.7848 119.213 86.7848 116.44V95.8H92.7848V116.4C92.7848 117.627 93.0914 118.573 93.7048 119.24C94.3448 119.88 95.2381 120.2 96.3848 120.2C97.5048 120.2 98.3848 119.88 99.0248 119.24C99.6648 118.573 99.9848 117.627 99.9848 116.4V95.8H105.985V116.44C105.985 119.187 105.118 121.373 103.385 123C101.678 124.6 99.3448 125.4 96.3848 125.4ZM110.049 125V95.8H116.809L119.489 105C119.782 105.96 119.996 106.8 120.129 107.52C120.289 108.24 120.382 108.747 120.409 109.04C120.436 108.747 120.516 108.24 120.649 107.52C120.809 106.8 121.022 105.96 121.289 105L123.929 95.8H130.689V125H125.209V117C125.209 115.533 125.236 114 125.289 112.4C125.369 110.773 125.462 109.16 125.569 107.56C125.676 105.96 125.796 104.467 125.929 103.08C126.062 101.667 126.182 100.44 126.289 99.4L122.929 112.6H117.849L114.329 99.4C114.462 100.387 114.596 101.573 114.729 102.96C114.862 104.32 114.982 105.8 115.089 107.4C115.222 108.973 115.329 110.587 115.409 112.24C115.489 113.893 115.529 115.48 115.529 117V125H110.049ZM133.354 125L140.514 95.8H148.114L155.354 125H149.234L147.834 118.4H140.874L139.474 125H133.354ZM141.874 113.6H146.794L145.394 106.56C145.207 105.547 145.007 104.547 144.794 103.56C144.607 102.547 144.46 101.76 144.354 101.2C144.247 101.76 144.1 102.533 143.914 103.52C143.754 104.507 143.567 105.507 143.354 106.52L141.874 113.6ZM62.8004 184.6V179H82.0004V184.6H62.8004Z"
        fill="#CDB9FF"
      />
      <rect x="39.4004" y="76" width="200" height="10" fill="#2AD4FF" fillOpacity="0.23" />
      <rect x="39.4004" y="96" width="200" height="10" fill="#2AD4FF" fillOpacity="0.23" />
      <rect x="39.4004" y="116" width="200" height="10" fill="#2AD4FF" fillOpacity="0.23" />
      <rect x="39.4004" y="136" width="200" height="10" fill="#2AD4FF" fillOpacity="0.23" />
      <rect x="39.4004" y="156" width="200" height="10" fill="#2AD4FF" fillOpacity="0.23" />
      <rect x="39.4004" y="176" width="200" height="10" fill="#2AD4FF" fillOpacity="0.23" />
      <rect x="39.4004" y="196" width="200" height="10" fill="#2AD4FF" fillOpacity="0.23" />
      <rect x="31.4004" y="58" width="216" height="158" rx="16" stroke="#201A2F" strokeWidth="25" />
      <defs>
        <filter
          id={`${id}filter0_d_657_85`}
          x="0.000391006"
          y="56.6"
          width="278.8"
          height="220.8"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="30" />
          <feGaussianBlur stdDeviation="15.7" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_657_85" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_657_85"
            result="shape"
          />
        </filter>
      </defs>
    </svg>
  );
}
