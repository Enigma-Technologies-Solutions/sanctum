import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// ETS Product Light badges — soft tinted pills for status,
// volt fill for permission tags (the one branded accent).
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 font-sans font-medium text-[12px] px-2.5 py-1 rounded-full",
  {
    variants: {
      variant: {
        // Volt — permission tags only. Black ink on volt.
        volt:       "bg-volt text-app-ink font-semibold",
        // Status: soft tinted pills — NOT solid neon
        success:    "bg-[rgba(30,158,98,.12)]  text-[#137A4B]",
        warning:    "bg-[rgba(199,125,17,.14)] text-[#92600D]",
        danger:     "bg-[rgba(210,64,46,.12)]  text-[#B0301F]",
        info:       "bg-[rgba(47,111,224,.12)] text-[#2358BC]",
        // Neutral surface
        secondary:  "bg-app-surface text-app-ink-2 border border-app-border",
        // Default outline
        default:    "border border-app-border text-app-ink-2 bg-transparent",
        // Muted ghost
        ghost:      "bg-app-surface text-app-ink-3",
        // Destructive (mirror danger for shadcn compat)
        destructive:"bg-[rgba(210,64,46,.12)] text-[#B0301F]",
        // Outline (shadcn compat)
        outline:    "border border-app-border text-app-ink-2 bg-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
