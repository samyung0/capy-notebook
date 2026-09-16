import { Icon, type IconProps } from '@/components/ui/Icon';

/** Editor chrome keeps the heavier stroke lucide used; app chrome stays at the Icon default. */
export function EditorIcon(props: IconProps) {
  return <Icon strokeWidth={2} {...props} />;
}
