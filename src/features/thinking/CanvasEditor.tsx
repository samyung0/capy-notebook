// Excalidraw temporarily disabled — keep the prop contract for Canvas route.
export default function CanvasEditor(_props: {
  initialScene?: unknown;
  onChange: (scene: unknown) => void;
  /** A frozen account views the canvas without editing it. */
  readOnly?: boolean;
}) {
  return <div className="h-full w-full" />;
}
