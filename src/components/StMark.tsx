// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

/**
 * Sanctum "st" monogram. Black tile, volt frame, white letters and the volt
 * terminal square from the ETS style guide. Always sharp: no border radius.
 *
 * Generated from assets/logo/st-monogram.svg (Poppins 700 outlines), so it
 * renders the same with or without the font installed. Edit the SVG source
 * and regenerate rather than editing these paths by hand.
 */
export function StMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="Sanctum"
      className="ets-tile"
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect x="0" y="0" width="64" height="64" fill="#0A0A0A"/>
      <rect x="6.50" y="6.50" width="51.00" height="51.00" fill="none" stroke="#FBFF00" strokeWidth="3"/>
      <g fill="#FFFFFF" transform="translate(14.51 40.39) scale(0.03008 -0.03008)">
      <path transform="translate(0 0)" d="M32 183H201Q204 154 228.0 136.0Q252 118 287 118Q319 118 336.5 130.5Q354 143 354 163Q354 187 329.0 198.5Q304 210 248 224Q188 238 148.0 253.5Q108 269 79.0 302.5Q50 336 50 393Q50 441 76.5 480.5Q103 520 154.5 543.0Q206 566 277 566Q382 566 442.5 514.0Q503 462 512 376H354Q350 405 328.5 422.0Q307 439 272 439Q242 439 226.0 427.5Q210 416 210 396Q210 372 235.5 360.0Q261 348 315 336Q377 320 416.0 304.5Q455 289 484.5 254.5Q514 220 515 162Q515 113 487.5 74.5Q460 36 408.5 14.0Q357 -8 289 -8Q216 -8 159.0 17.0Q102 42 69.0 85.5Q36 129 32 183Z"/>
      <path transform="translate(538 0)" d="M373 145V0H286Q193 0 141.0 45.5Q89 91 89 194V416H21V558H89V694H260V558H372V416H260V192Q260 167 272.0 156.0Q284 145 312 145Z"/>
      </g>
      <rect x="44.02" y="35.88" width="4.51" height="4.51" fill="#FBFF00"/>
    </svg>
  );
}
