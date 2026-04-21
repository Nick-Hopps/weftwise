import { cn } from '@/lib/cn';

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center',
        'h-5 min-w-[20px] px-1.5 rounded-sm',
        'font-mono text-[11px] leading-none',
        'bg-subtle text-foreground-secondary',
        'border border-border-strong',
        'shadow-xs',
        className,
      )}
      {...props}
    />
  );
}
