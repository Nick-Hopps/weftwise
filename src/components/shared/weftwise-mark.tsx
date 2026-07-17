import { cn } from '@/lib/cn';

const WARP_XS = [13, 21, 29, 37];
/* 纬线压第 2、4 根经线、穿第 1、3 根之下 —— 织纹层级是品牌规范，不得调整绘制顺序 */
const WARP_OVER_XS = [13, 29];

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
      <g className="stroke-[rgb(var(--brand-warp))]" strokeWidth={3} strokeLinecap="round">
        {WARP_XS.map((x) => (
          <line key={x} x1={x} y1={9} x2={x} y2={39} />
        ))}
      </g>
      <line
        className="stroke-[rgb(var(--brand-weft))]"
        x1={7}
        y1={24}
        x2={42}
        y2={24}
        strokeWidth={3}
        strokeLinecap="round"
      />
      <g className="stroke-[rgb(var(--brand-warp))]" strokeWidth={3} strokeLinecap="round">
        {WARP_OVER_XS.map((x) => (
          <line key={x} x1={x} y1={19} x2={x} y2={29} />
        ))}
      </g>
      <circle className="fill-[rgb(var(--brand-weft))]" cx={45.6} cy={24} r={1.9} />
    </svg>
  );
}
