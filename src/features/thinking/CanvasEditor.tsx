import { Excalidraw } from '@excalidraw/excalidraw';
import { useEffect, useRef } from 'react';
import '@excalidraw/excalidraw/index.css';
import { useTheme } from '@/theme/ThemeProvider';

interface SceneBlob {
  elements?: readonly unknown[];
}

export default function CanvasEditor({
  initialScene,
  onChange,
}: {
  initialScene?: unknown;
  onChange: (scene: unknown) => void;
}) {
  const { theme } = useTheme();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scene = (initialScene ?? {}) as SceneBlob;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return (
    <div className="h-full w-full">
      {/* <Excalidraw
        initialData={{
          elements: (scene.elements as never) ?? [],
          scrollToContent: true,
        }}
        onChange={(elements) => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => onChange({ elements }), 800);
        }}
        theme={theme === 'mocha' ? 'mocha' : 'latte'}
      /> */}
    </div>
  );
}
