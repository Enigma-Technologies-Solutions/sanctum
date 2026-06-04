import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// ETS Product Light buttons — Inter, 8px radius
// One volt CTA per view max; everything else is ink-primary or ghost.
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "font-sans font-semibold text-[13px]",
    "transition-colors duration-100",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-ink focus-visible:ring-offset-2",
    "disabled:pointer-events-none disabled:opacity-40",
  ].join(" "),
  {
    variants: {
      variant: {
        // Ink primary — black bg, white text. Default action.
        default:
          "bg-app-ink text-white rounded hover:bg-[#1a1a1a] active:bg-[#2a2a2a]",
        // Volt CTA — yellow, black text. ONE per view. Do not overuse.
        volt:
          "bg-volt text-app-ink rounded font-bold hover:bg-[#eaed00] active:bg-[#d5d800]",
        // Ghost / secondary — white bg, border, ink text
        outline:
          "bg-white border border-app-border text-app-ink rounded hover:bg-app-surface active:bg-app-raised",
        // Destructive
        destructive:
          "bg-danger text-white rounded hover:bg-[#b83527]",
        // Minimal — no bg, no border, ink-2 text
        ghost:
          "bg-transparent text-app-ink-2 rounded hover:bg-app-surface hover:text-app-ink",
        // Underline link
        link:
          "bg-transparent text-app-ink underline-offset-4 hover:underline",
        // Muted surface
        secondary:
          "bg-app-surface text-app-ink border border-app-border rounded hover:bg-app-raised",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-[12px]",
        lg: "h-10 px-5",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
