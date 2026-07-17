import { cn } from '@/lib/cn';

const WARP_XS = [14, 24, 34];
/* 纬线呈波形穿行：穿第 1、3 根经线之下、压第 2 根之上 —— 织纹节奏是品牌规范，不得调整绘制顺序 */
const WARP_OVER_XS = [14, 34];
/* 正弦波纬线（幅 6、周期 20，波峰在经线之间），小尺寸下靠波形本身传达「编织」 */
const WEFT_WAVE =
  'M5.6 18.6 C6.7 18.2 7.9 18 9 18 C12.64 18 15.36 30 19 30 C22.64 30 25.36 18 29 18 C32.64 18 35.36 30 39 30 C40.8 30 42.7 28 44 25.8';

interface WeftwiseMarkProps {
  size?: number;
  className?: string;
}

/** weftwise 品牌标志（织纹 mark），颜色走 --brand-warp / --brand-weft token 自动亮暗 */
export function WeftwiseMark({ size = 24, className }: WeftwiseMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <g className="stroke-[rgb(var(--brand-warp))]" strokeWidth={3.6} strokeLinecap="round">
        {WARP_XS.map((x) => (
          <line key={x} x1={x} y1={11} x2={x} y2={37} />
        ))}
      </g>
      <path
        className="stroke-[rgb(var(--brand-weft))]"
        d={WEFT_WAVE}
        strokeWidth={3.6}
        strokeLinecap="round"
        fill="none"
      />
      <g className="stroke-[rgb(var(--brand-warp))]" strokeWidth={3.6} strokeLinecap="round">
        {WARP_OVER_XS.map((x) => (
          <line key={x} x1={x} y1={17.5} x2={x} y2={30.5} />
        ))}
      </g>
      <circle className="fill-[rgb(var(--brand-weft))]" cx={45.8} cy={23.4} r={2.1} />
    </svg>
  );
}
