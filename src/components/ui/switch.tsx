import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}

/**
 * Simple toggle switch. No external dependency — inline CSS only.
 * Uses ink (#0A0A0A) for on-state to match the ETS Product Light system.
 */
export function Switch({ checked, onCheckedChange, disabled, className, id }: SwitchProps) {
  return (
    <button
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onCheckedChange(!checked)}
      className={cn("relative inline-flex flex-shrink-0 focus-visible:outline-none", className)}
      style={{
        width: "36px",
        height: "20px",
        borderRadius: "10px",
        background: checked ? "#0A0A0A" : "#D6DAE0",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "background 0.15s",
        padding: 0,
      }}
    >
      <span
        style={{
          display: "block",
          position: "absolute",
          top: "2px",
          left: checked ? "18px" : "2px",
          width: "16px",
          height: "16px",
          borderRadius: "8px",
          background: "#FFFFFF",
          boxShadow: "0 1px 2px rgba(0,0,0,.18)",
          transition: "left 0.15s",
        }}
      />
    </button>
  );
}
