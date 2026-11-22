export interface CoverCrop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

// Center-crop a source of srcW x srcH so it fills a dstW x dstH target
// without distortion (CSS object-fit: cover semantics).
export function coverCrop(srcW: number, srcH: number, dstW: number, dstH: number): CoverCrop {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    // Source is wider than target: trim left and right.
    const sw = srcH * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  // Source is taller than target: trim top and bottom.
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}
