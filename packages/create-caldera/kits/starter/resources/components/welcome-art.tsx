import { MARK_PATHS } from '@/components/caldera-logo'

// The mark again and again, each copy larger and further out, outlined over blue fills: the
// welcome page's poster. Drawn in a 480×440 box and cropped by whatever holds it.
const LAYERS = [
  { x: 150, y: 150, scale: 7.2, fill: 'fill-[#cfe2ff] dark:fill-[#071a3d]', stroke: 'stroke-[#006cff]/40' },
  { x: 118, y: 126, scale: 6.4, fill: 'fill-[#b3d1ff] dark:fill-[#0a2659]', stroke: 'stroke-[#006cff]/60' },
  { x: 86, y: 102, scale: 5.6, fill: 'fill-[#8bbaff] dark:fill-[#0d3478]', stroke: 'stroke-[#006cff]/80' },
  { x: 54, y: 78, scale: 4.8, fill: 'fill-[#5c9dff] dark:fill-[#0f4aa8]', stroke: 'stroke-[#006cff]' },
  { x: 22, y: 54, scale: 4, fill: 'fill-[#006cff]', stroke: 'stroke-[#4d94ff]' },
] as const

/** The poster's background, for whatever it sits in to blend into it. */
export const ART_BACKGROUND = 'bg-[#e6f0ff] dark:bg-[#04102a]'

export function WelcomeArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 440" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className={className}>
      <rect width="480" height="440" className="fill-[#e6f0ff] dark:fill-[#04102a]" />
      {/* The marks, back to front: the largest first. */}
      {LAYERS.map((layer) => (
        <g key={layer.scale} transform={`translate(${layer.x} ${layer.y + 10}) scale(${layer.scale}) translate(0 -12)`}>
          {MARK_PATHS.map((d) => (
            <path key={d} d={d} className={`${layer.fill} ${layer.stroke}`} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      ))}
    </svg>
  )
}
