import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Theme radii (tailwind.css) so a later rounded-* override replaces the earlier one.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ['input', 'button', 'button-lg', 'card', 'card-lg', 'card-xl'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
