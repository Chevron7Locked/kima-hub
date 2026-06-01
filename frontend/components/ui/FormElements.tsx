import { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, forwardRef } from "react";
import { cn } from "@/utils/cn";

// Input Component
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "bg-[var(--bg-secondary)] border text-white placeholder-gray-600 rounded-sm px-3 py-2 text-sm transition-colors",
          "focus:outline-none focus:ring-1",
          error
            ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/20"
            : "border-[var(--border-interactive)] focus:border-[#1db954]/50 focus:ring-purple-500/20",
          className
        )}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

// Textarea Component
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "bg-[var(--bg-secondary)] border text-white placeholder-gray-600 rounded-sm px-3 py-2 text-sm resize-none transition-colors",
          "focus:outline-none focus:ring-1",
          error
            ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/20"
            : "border-[var(--border-interactive)] focus:border-[#1db954]/50 focus:ring-purple-500/20",
          className
        )}
        {...props}
      />
    );
  }
);

Textarea.displayName = "Textarea";

// Select Component
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, error, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          "bg-[var(--bg-secondary)] border text-white rounded-sm px-3 py-2 text-sm appearance-none cursor-pointer transition-colors",
          "focus:outline-none",
          error
            ? "border-red-500/50 focus:border-red-500"
            : "border-[var(--border-interactive)] focus:border-[#1db954]/50",
          className
        )}
        {...props}
      >
        {children}
      </select>
    );
  }
);

Select.displayName = "Select";
